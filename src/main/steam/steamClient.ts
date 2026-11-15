// Signs in to Steam with node-steam-user to read the account's licenses,
// whose creation time is the day each game came in. Steam Guard is asked
// for through a callback; the password is used once and never kept. After
// the first sign-in only the refresh token Steam hands back is saved (by
// the caller), and later syncs sign in with that.
import { EventEmitter } from 'events';
import type { SteamLicense, PackageDetails } from '../../shared/licenses';
import { packageDetailsFromInfo } from '../../shared/licenses';
import type { SteamGuardRequest } from '../../shared/types';

/** The parts of a SteamUser instance this uses, so tests can drive a fake one. */
export interface SteamUserLike extends EventEmitter {
  steamID: { getSteamID64(): string; accountid: number } | null;
  licenses: SteamLicense[] | null;
  logOn(details: Record<string, unknown>): void;
  logOff(): void;
  getProductInfo(
    apps: number[],
    packages: number[],
    inclTokens?: boolean
  ): Promise<{ packages: Record<string, { packageinfo?: unknown }>; unknownPackages?: number[] }>;
}

export type SteamUserFactory = () => SteamUserLike;

export type LogOnDetails = { refreshToken: string } | { accountName: string; password: string };

export interface SignedIn {
  steamId64: string;
  accountId: number;
}

/** Sign-in refused because of the account details or token, not the network. */
export class SteamAuthError extends Error {
  constructor(message: string, readonly eresult: number | null) {
    super(message);
    this.name = 'SteamAuthError';
  }
}

export class SteamCancelledError extends Error {
  constructor() {
    super('Steam sign-in was cancelled.');
    this.name = 'SteamCancelledError';
  }
}

// EResult values (SteamUser.EResult) that mean the details or token are wrong.
const AUTH_RESULTS = new Map<number, string>([
  [5, 'Steam says the account name or password is wrong.'],
  [15, 'Steam refused the sign-in.'],
  [18, 'Steam could not find that account.'],
  [27, 'The saved Steam sign-in has expired. Sign in again in Settings.'],
  [63, 'Steam asked for a Steam Guard code.'],
  [65, 'The Steam Guard code was wrong.'],
  [84, 'Steam is limiting sign-ins from this computer for a while. Try again later.'],
  [88, 'The Steam Guard code was wrong.'],
]);

const LICENSE_WAIT_MS = 30000;
const PACKAGE_BATCH = 200;

export function createRealSteamUser(): SteamUserLike {
  // Loaded on first use so the tests (which pass a fake) never need it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SteamUser = require('steam-user');
  return new SteamUser({
    // Don't write Steam's own machine files or caches anywhere.
    dataDirectory: null,
    renewRefreshTokens: true,
    autoRelogin: false,
    enablePicsCache: false,
  }) as SteamUserLike;
}

/** steam-user's EPaymentMethod enum, by name, for showing how a license was paid. */
export function paymentMethodNames(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('steam-user').EPaymentMethod as Record<string, unknown>;
}

export class SteamSession {
  private readonly client: SteamUserLike;
  private signedIn: SignedIn | null = null;
  private cancelGuard: (() => void) | null = null;

  constructor(
    factory: SteamUserFactory,
    private readonly hooks: {
      /** Called with every refresh token Steam hands out (first sign-in, and renewals). */
      onRefreshToken: (token: string) => void;
      /** Asks the user for a Steam Guard code. Rejects if they cancel. */
      onSteamGuard: (request: SteamGuardRequest) => Promise<string>;
    }
  ) {
    this.client = factory();
    this.client.on('refreshToken', (token: unknown) => {
      if (typeof token === 'string' && token !== '') this.hooks.onRefreshToken(token);
    });
    // An unhandled 'error' event would crash the main process.
    this.client.on('error', () => undefined);
  }

  signIn(details: LogOnDetails): Promise<SignedIn> {
    return new Promise<SignedIn>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.client.removeListener('loggedOn', onLoggedOn);
        this.client.removeListener('error', onError);
        this.client.removeListener('steamGuard', onGuard);
        fn();
      };
      const onLoggedOn = () => {
        const id = this.client.steamID;
        if (!id) {
          finish(() => reject(new Error('Steam signed in but gave no account id.')));
          return;
        }
        this.signedIn = { steamId64: id.getSteamID64(), accountId: id.accountid };
        finish(() => resolve(this.signedIn as SignedIn));
      };
      const onError = (err: { eresult?: number; message?: string }) => {
        const eresult = typeof err?.eresult === 'number' ? err.eresult : null;
        const authMessage = eresult != null ? AUTH_RESULTS.get(eresult) : undefined;
        finish(() =>
          reject(authMessage ? new SteamAuthError(authMessage, eresult) : new Error('Could not sign in to Steam. Check the connection and try again.'))
        );
      };
      const onGuard = (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => {
        let cancelled = false;
        this.cancelGuard = () => {
          cancelled = true;
        };
        this.hooks
          .onSteamGuard({ domain: domain ?? null, lastCodeWrong: Boolean(lastCodeWrong) })
          .then((code) => {
            if (cancelled || settled) return;
            callback(code.trim());
          })
          .catch(() => {
            try {
              this.client.logOff();
            } catch {
              // already disconnected
            }
            finish(() => reject(new SteamCancelledError()));
          });
      };
      this.client.on('loggedOn', onLoggedOn);
      this.client.on('error', onError);
      this.client.on('steamGuard', onGuard);
      try {
        this.client.logOn('refreshToken' in details ? { refreshToken: details.refreshToken } : { ...details });
      } catch {
        finish(() => reject(new Error('Could not start the Steam sign-in.')));
      }
    });
  }

  /** The account's licenses; Steam sends them just after sign-in. */
  async licenses(): Promise<SteamLicense[]> {
    if (this.client.licenses) return this.client.licenses;
    return new Promise<SteamLicense[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.removeListener('licenses', onLicenses);
        reject(new Error('Steam did not send the license list.'));
      }, LICENSE_WAIT_MS);
      const onLicenses = (list: SteamLicense[]) => {
        clearTimeout(timer);
        resolve(list ?? []);
      };
      this.client.once('licenses', onLicenses);
    });
  }

  /** Which apps each package contains, and how it is billed. */
  async packageDetails(packageIds: number[]): Promise<Map<number, PackageDetails>> {
    const out = new Map<number, PackageDetails>();
    const unique = [...new Set(packageIds)];
    for (let i = 0; i < unique.length; i += PACKAGE_BATCH) {
      const batch = unique.slice(i, i + PACKAGE_BATCH);
      const result = await this.client.getProductInfo([], batch, true);
      for (const [id, entry] of Object.entries(result.packages ?? {})) {
        out.set(Number(id), packageDetailsFromInfo(entry?.packageinfo));
      }
    }
    return out;
  }

  get account(): SignedIn | null {
    return this.signedIn;
  }

  close(): void {
    this.cancelGuard?.();
    try {
      this.client.logOff();
    } catch {
      // not connected
    }
  }
}
