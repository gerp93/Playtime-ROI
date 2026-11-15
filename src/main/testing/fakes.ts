// Test doubles: a scripted fetch, a fake safeStorage and a fake steam-user client.
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FetchLike } from '../http';
import type { SafeStorageLike } from '../secrets';
import type { SteamUserLike } from '../steam/steamClient';
import type { SteamLicense } from '../../shared/licenses';

export interface Call {
  url: string;
  method: string;
  body?: string;
}

export type Responder = (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that answers from a function and records every call. */
export function fakeFetch(respond: Responder): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: { method?: string; body?: string }) => {
    const call = { url, method: init?.method ?? 'GET', body: init?.body };
    calls.push(call);
    const r = respond(call);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    const headers = r.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => {
        if (typeof r.body === 'string') return JSON.parse(r.body);
        return r.body;
      },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

export const noSleep = async () => undefined;

/** Reversible "encryption" so tests can check nothing is stored in plain text. */
export function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, 'utf-8').toString('hex')}`, 'utf-8'),
    decryptString: (b) => {
      const text = b.toString('utf-8');
      if (!text.startsWith('enc:')) throw new Error('not ours');
      return Buffer.from(text.slice(4), 'hex').toString('utf-8');
    },
  };
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'playtime-roi-test-'));
}

export interface FakeSteamScript {
  /** What happens on logOn. */
  onLogOn: (client: FakeSteamUser, details: Record<string, unknown>) => void;
  licenses?: SteamLicense[];
  packages?: Record<number, unknown>;
}

export class FakeSteamUser extends EventEmitter implements SteamUserLike {
  steamID: { getSteamID64(): string; accountid: number } | null = null;
  licenses: SteamLicense[] | null = null;
  logOns: Record<string, unknown>[] = [];
  loggedOff = 0;
  productInfoCalls: number[][] = [];

  constructor(private readonly script: FakeSteamScript) {
    super();
  }

  logOn(details: Record<string, unknown>): void {
    this.logOns.push(details);
    setImmediate(() => this.script.onLogOn(this, details));
  }

  logOff(): void {
    this.loggedOff += 1;
  }

  async getProductInfo(_apps: number[], packages: number[]) {
    this.productInfoCalls.push(packages);
    const out: Record<string, { packageinfo?: unknown }> = {};
    for (const id of packages) {
      const info = this.script.packages?.[id];
      if (info) out[String(id)] = { packageinfo: info };
    }
    return { packages: out };
  }

  /** Acts like Steam after a good sign-in: account id, a new token, then licenses. */
  succeed(accountId = 1000, token = 'refresh-token-2'): void {
    this.steamID = { getSteamID64: () => String(76561197960265728n + BigInt(accountId)), accountid: accountId };
    this.emit('refreshToken', token);
    this.emit('loggedOn', {});
    setImmediate(() => {
      this.licenses = this.script.licenses ?? [];
      this.emit('licenses', this.licenses);
    });
  }
}
