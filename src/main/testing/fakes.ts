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
  headers?: Record<string, string>;
}

export type Responder = (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that answers from a function and records every call. */
export function fakeFetch(respond: Responder): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const call = { url, method: init?.method ?? 'GET', body: init?.body, headers: init?.headers };
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

export interface HistoryRowSpec {
  id: string;
  date: string;
  items: string[];
  type?: string;
  payment?: string;
  /** "$59.99", or ["-32%", "$34.99", "$23.62"] for a discounted price. */
  base?: string | [string, string, string];
  tax?: string;
  total: string;
}

/** A purchase-history row the way Steam writes it (whitespace and attribute order as on the real page). */
export function historyRow(r: HistoryRowSpec): string {
  const base = Array.isArray(r.base)
    ? `<div class="wht_base_price_discounted"><div class="wht_discount_pct">${r.base[0]}</div><div><span class="wht_original_price">${r.base[1]}</span> <span class="wht_discounted_price">${r.base[2]}</span></div></div>`
    : (r.base ?? '');
  const items = r.items.map((i) => `<div style="clear: both">\n\t\t\t${i}\t\t\t\t\t\t\t\t\t\t\t</div>`).join('\n');
  return `<tr data-panel="{&quot;focusable&quot;:true,&quot;clickOnActivate&quot;:true}" role="button" class="wallet_table_row " onclick="location.href='https://help.steampowered.com/en/wizard/HelpWithTransaction?transid=${r.id}'">
  <td class="wht_date">${r.date}</td>
  <td data-tooltip-text="Click to get help with this purchase" class="wht_items " "="" aria-describedby="tooltip-3">${items}</td>
  <td class="wht_type "><div>${r.type ?? 'Purchase'}</div><div class="wth_payment">${r.payment ?? 'Visa **11'}</div></td>
  <td class="wht_base_price">${base}</td>
  <td class="wht_tax">${r.tax ?? ''}</td>
  <td class="wht_shipping"></td>
  <td class="wht_total ">${r.total}</td>
  <td class="wht_wallet_change"></td><td class="wht_wallet_balance"></td>
</tr>`;
}

/** The purchase-history page around some rows; `cursor` is what the page's script holds for "Load More". */
export function historyPage(rows: string[], cursor = 'null'): string {
  return `<html><body><table class="wallet_history_table"><thead><tr><th class="wht_date">Date</th></tr></thead><tbody>${rows.join('\n')}
<tr id="more_history" style="display: none"></tr></tbody></table>
<script type="text/javascript">var g_historyCursor = ${cursor};</script></body></html>`;
}

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
  /** The web cookies Steam hands out after sign-in; false for none (the web session never arrives). */
  webCookies?: string[] | false;
}

/** The web session id a fake sign-in produces. */
export const FAKE_WEB_SESSION_ID = 'fake-session-id';
export const FAKE_LOGIN_COOKIE = 'fake-login-secret';

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
      if (this.script.webCookies !== false) {
        this.emit('webSession', FAKE_WEB_SESSION_ID, this.script.webCookies ?? [`steamLoginSecure=${FAKE_LOGIN_COOKIE}`, `sessionid=${FAKE_WEB_SESSION_ID}`]);
      }
    });
  }
}
