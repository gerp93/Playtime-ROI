// One sync: sign in to Steam with the saved token and read the licenses,
// read the library and playtime from the Web API, then price whatever is
// new or changed since the last sync. Runs when the app opens and when the
// user asks; there is no background job.
import type { Store, StoredEstimate } from './database/store';
import type { SecretStore } from './secrets';
import { getOwnedGames, SteamKeyRejectedError } from './steam/webApi';
import { SteamAuthError, SteamCancelledError, SteamSession, SignedIn } from './steam/steamClient';
import { ItadClient, ItadKeyRejectedError } from './itad';
import type { FetchLike, Sleep } from './http';
import { acquisitionsByApp } from '../shared/licenses';
import { priceOnDate } from '../shared/priceHistory';
import type { SyncProgress, SyncResult } from '../shared/types';

/** Prices that found nothing are looked up again after this long, in case ITAD has added the game. */
const RETRY_MISSING_AFTER_S = 30 * 24 * 3600;
/** Kinds that cost nothing, so there is nothing to price. */
const UNPRICED = new Set(['free', 'gift', 'family']);

export interface SyncDeps {
  store: Store;
  secrets: SecretStore;
  fetch: FetchLike;
  /** Makes a Steam session; the caller wires the Steam Guard prompt and token saving. */
  openSteam: () => SteamSession;
  now: () => number;
  sleep?: Sleep;
  onProgress?: (p: SyncProgress) => void;
  paymentNames?: Record<string, unknown>;
}

export const META_LAST_SYNC = 'last_sync_at';
export const META_STEAM_ID = 'steam_id64';
export const META_COUNTRY = 'country';
export const DEFAULT_COUNTRY = 'US';

export function getCountry(store: Store): string {
  const c = store.getMeta(META_COUNTRY);
  return c && /^[A-Z]{2}$/.test(c) ? c : DEFAULT_COUNTRY;
}

function result(deps: SyncDeps, ok: boolean, phase: SyncResult['phase'], message: string, games = 0, priced = 0): SyncResult {
  deps.onProgress?.({ phase, message });
  return { ok, phase, message, games, pricesLookedUp: priced, finishedAt: deps.now() };
}

/** Whether a game's saved estimate still answers the question, or needs looking up. */
export function needsPricing(estimate: StoredEstimate | null, forDate: number, country: string, now: number): boolean {
  if (!estimate) return true;
  if (estimate.forDate !== forDate || estimate.country !== country) return true;
  if (estimate.status === 'error') return true;
  if (estimate.status !== 'ok' && now - estimate.lookedUpAt > RETRY_MISSING_AFTER_S) return true;
  return false;
}

/** Reads the licenses through an open, signed-in Steam session and saves when each game came in. */
export async function readLicenses(deps: SyncDeps, session: SteamSession, account: SignedIn, libraryAppIds: Set<number>): Promise<void> {
  deps.onProgress?.({ phase: 'reading-licenses', message: 'Reading your Steam licenses…' });
  const licenses = await session.licenses();
  const packages = await session.packageDetails(licenses.map((l) => l.package_id));
  const byApp = acquisitionsByApp(licenses, packages, account.accountId, libraryAppIds, deps.paymentNames);
  deps.store.replaceAcquisitions(byApp.values());
}

export async function priceGames(deps: SyncDeps, itadKey: string): Promise<number> {
  const { store } = deps;
  const country = getCountry(store);
  const now = deps.now();
  const todo = store
    .listGames()
    .filter((g) => g.acquiredAt != null && !UNPRICED.has(g.acquisition))
    .filter((g) => needsPricing(store.getEstimate(g.appId), g.acquiredAt as number, country, now));
  if (todo.length === 0) return 0;

  const itad = new ItadClient(deps.fetch, itadKey, { sleep: deps.sleep });
  deps.onProgress?.({ phase: 'pricing', message: 'Finding your games on IsThereAnyDeal…', done: 0, total: todo.length });
  const ids = await itad.lookupSteamApps(todo.map((g) => g.appId));

  let done = 0;
  for (const game of todo) {
    const forDate = game.acquiredAt as number;
    const base = { appId: game.appId, forDate, country, lookedUpAt: deps.now(), price: null, regular: null, cut: null, recordedAt: null, match: null, error: null };
    const itadId = ids.get(game.appId) ?? null;
    if (!itadId) {
      store.saveEstimate({ ...base, status: 'not_found' });
    } else {
      try {
        const history = await itad.steamPriceHistory(itadId, country);
        const pick = priceOnDate(history, forDate);
        if (!pick) store.saveEstimate({ ...base, status: 'no_history' });
        else
          store.saveEstimate({
            ...base,
            status: 'ok',
            price: pick.record.price,
            regular: pick.record.regular,
            cut: pick.record.cut,
            recordedAt: pick.record.at,
            match: pick.match,
          });
      } catch (err) {
        if (err instanceof ItadKeyRejectedError) throw err;
        store.saveEstimate({ ...base, status: 'error', error: err instanceof Error ? err.message : 'Lookup failed.' });
      }
    }
    done += 1;
    deps.onProgress?.({ phase: 'pricing', message: `Pricing ${game.name}`, done, total: todo.length });
  }
  return done;
}

/**
 * The whole sync. `signedInSession` is passed when the user has just signed
 * in from Settings, so the same session is used instead of a second sign-in.
 */
export async function runSync(deps: SyncDeps, signedInSession?: { session: SteamSession; account: SignedIn }): Promise<SyncResult> {
  const { store, secrets } = deps;
  const webKey = secrets.get('steamWebApiKey');
  if (!webKey) return result(deps, false, 'needs-keys', 'Add your Steam Web API key in Settings to read your library.');

  // 1. Sign in to Steam for the licenses (purchase dates).
  let session = signedInSession?.session ?? null;
  let account = signedInSession?.account ?? null;
  let licenseNote = '';
  if (!session) {
    const token = secrets.get('steamRefreshToken');
    if (!token) {
      if (!store.getMeta(META_STEAM_ID)) return result(deps, false, 'needs-login', 'Sign in to Steam in Settings to read your purchase dates.');
      licenseNote = ' Not signed in to Steam, so purchase dates were not updated.';
    } else {
      deps.onProgress?.({ phase: 'signing-in', message: 'Signing in to Steam…' });
      session = deps.openSteam();
      try {
        account = await session.signIn({ refreshToken: token });
      } catch (err) {
        session.close();
        session = null;
        if (err instanceof SteamAuthError) {
          secrets.remove('steamRefreshToken');
          return result(deps, false, 'needs-login', `${err.message} Sign in again in Settings.`);
        }
        if (err instanceof SteamCancelledError) return result(deps, false, 'needs-login', err.message);
        if (!store.getMeta(META_STEAM_ID)) return result(deps, false, 'error', err instanceof Error ? err.message : 'Could not sign in to Steam.');
        licenseNote = ' Steam sign-in failed, so purchase dates were not updated.';
      }
    }
  }

  try {
    if (account) store.setMeta(META_STEAM_ID, account.steamId64);
    const steamId64 = store.getMeta(META_STEAM_ID) as string;

    // 2. The library and playtime.
    deps.onProgress?.({ phase: 'reading-library', message: 'Reading your library and playtime…' });
    let games;
    try {
      games = await getOwnedGames(deps.fetch, webKey, steamId64, { sleep: deps.sleep });
    } catch (err) {
      if (err instanceof SteamKeyRejectedError) return result(deps, false, 'needs-keys', err.message);
      return result(deps, false, 'error', err instanceof Error ? err.message : 'Could not read the library.');
    }
    store.replaceGames(games, deps.now());

    if (session && account) {
      try {
        await readLicenses(deps, session, account, new Set(games.map((g) => g.appId)));
      } catch (err) {
        licenseNote = ` ${err instanceof Error ? err.message : 'Could not read the licenses.'} Purchase dates were not updated.`;
      }
    }
  } finally {
    session?.close();
  }

  // 3. Prices for what is new or changed.
  const gameCount = store.listGames().length;
  const itadKey = secrets.get('itadApiKey');
  let priced = 0;
  let priceNote = '';
  if (!itadKey) {
    priceNote = ' Add an IsThereAnyDeal key in Settings to estimate prices.';
  } else {
    try {
      priced = await priceGames(deps, itadKey);
    } catch (err) {
      priceNote = ` ${err instanceof Error ? err.message : 'Pricing failed.'}`;
    }
  }

  store.setMeta(META_LAST_SYNC, String(deps.now()));
  const message = `Synced ${gameCount} games${priced ? `, priced ${priced}` : ''}.${licenseNote}${priceNote}`;
  return result(deps, true, 'done', message, gameCount, priced);
}
