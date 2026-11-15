// Steam's own purchase history (store.steampowered.com/account/history): what
// was actually charged, and when. This file reads the page's HTML into rows and
// works out which library game each purchase paid for. Pure: the main process
// fetches the pages and hands the text in, and the tests call it directly.
import type { Money } from './types';

/** One row of the purchase history table. */
export interface HistoryRow {
  /** Steam's transaction id (from the row's help link); the row's identity. */
  transId: string;
  /** Unix seconds at 00:00 UTC of the day shown. Steam shows only the day. */
  date: number;
  kind: 'purchase' | 'refund' | 'other';
  /** The Type column as Steam wrote it ("Purchase", "Refund", "In-Game Purchase", ...). */
  typeLabel: string;
  /** Item names, without the "Refund" line a refund row carries. */
  items: string[];
  /** The Price column before any discount, summed over the items. */
  listCents: number | null;
  discountPct: number | null;
  taxCents: number | null;
  /** What was charged, tax included. */
  totalCents: number | null;
  /** The currency symbol or code shown with the total ("$", "€", "CDN$"). */
  symbol: string | null;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** The first page says where to continue; null when there is nothing more. */
  cursor: Record<string, string> | null;
  /** The history table was on the page (false when Steam showed a sign-in page or something else). */
  hasTable: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  trade: '™',
  reg: '®',
  copy: '©',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Tags out, entities decoded, white space collapsed. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** "Oct 2, 2026" (or "2 Oct, 2026") as Unix seconds at 00:00 UTC; null when it is neither. */
export function parseHistoryDate(text: string): number | null {
  const t = text.trim();
  const a = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  const b = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})$/.exec(t);
  const [month, day, year] = a ? [a[1], a[2], a[3]] : b ? [b[2], b[1], b[3]] : [null, null, null];
  if (!month || !day || !year) return null;
  const m = MONTHS.indexOf(month.toLowerCase());
  if (m < 0) return null;
  const ms = Date.UTC(Number(year), m, Number(day));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Reads an amount like "$1,234.56", "1.234,56€" or "-$5.00" into whole minor
 * units, and keeps the symbol that came with it. Null when there is no number.
 */
export function parseMoneyText(text: string): { cents: number; symbol: string | null } | null {
  const cleaned = text.replace(/ /g, ' ').trim();
  const num = /\d[\d.,\s]*\d|\d/.exec(cleaned);
  if (!num) return null;
  const symbol = (cleaned.slice(0, num.index) + cleaned.slice(num.index + num[0].length)).replace(/[+\-\s]/g, '').trim() || null;
  const digits = num[0].replace(/\s/g, '');
  const decimal = /[.,](\d{1,2})$/.exec(digits);
  let whole: string;
  let frac = '';
  if (decimal) {
    whole = digits.slice(0, digits.length - decimal[0].length).replace(/[.,]/g, '');
    frac = decimal[1];
  } else {
    whole = digits.replace(/[.,]/g, '');
  }
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isFinite(cents)) return null;
  return { cents: cleaned.slice(0, num.index).includes('-') ? -cents : cents, symbol };
}

const DOLLAR_BY_COUNTRY: Record<string, string> = {
  US: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', HK: 'HKD', TW: 'TWD', MX: 'MXN', CO: 'COP', CL: 'CLP', AR: 'ARS', UY: 'UYU',
};
const KRONA_BY_COUNTRY: Record<string, string> = { SE: 'SEK', NO: 'NOK', DK: 'DKK', IS: 'ISK', CZ: 'CZK' };

const SYMBOLS: Record<string, string> = {
  '€': 'EUR', '£': 'GBP', '₩': 'KRW', '₹': 'INR', '₽': 'RUB', 'руб': 'RUB', 'zł': 'PLN', '₺': 'TRY', 'TL': 'TRY', '₴': 'UAH',
  '฿': 'THB', 'Rp': 'IDR', 'RM': 'MYR', '₱': 'PHP', '₫': 'VND', 'S/.': 'PEN', '₸': 'KZT', 'Kč': 'CZK', 'CHF': 'CHF', 'R$': 'BRL',
  'CDN$': 'CAD', 'A$': 'AUD', 'NZ$': 'NZD', 'HK$': 'HKD', 'S$': 'SGD', 'NT$': 'TWD', 'Mex$': 'MXN', 'R': 'ZAR', 'Rs': 'INR',
  '₪': 'ILS', 'AED': 'AED', 'SAR': 'SAR', 'QR': 'QAR', 'CLP$': 'CLP', 'COL$': 'COP', 'ARS$': 'ARS', '$U': 'UYU',
};

/**
 * The ISO code for the symbol Steam printed beside an amount. A bare "$" is
 * not one currency, so the account's country decides it. Null when unsure,
 * so a price is left out rather than counted in the wrong currency.
 */
export function currencyFromSymbol(symbol: string | null, country: string): string | null {
  if (!symbol) return null;
  const s = symbol.replace(/\.$/, '');
  if (/^[A-Z]{3}$/.test(s) && !(s in SYMBOLS)) return s;
  if (s === '$') return DOLLAR_BY_COUNTRY[country] ?? 'USD';
  if (s === '¥' || s === '円') return country === 'CN' ? 'CNY' : 'JPY';
  if (s === 'kr') return KRONA_BY_COUNTRY[country] ?? null;
  return SYMBOLS[s] ?? null;
}

function cell(row: string, name: string): string | null {
  const m = new RegExp(`<td\\b[^>]*\\bclass="${name}[^"]*"[^>]*>([\\s\\S]*?)</td>`, 'i').exec(row);
  return m ? m[1] : null;
}

function classify(label: string): HistoryRow['kind'] {
  const l = label.toLowerCase();
  if (l === 'purchase') return 'purchase';
  if (l === 'refund') return 'refund';
  return 'other';
}

function parseRow(openTag: string, row: string): HistoryRow | null {
  const transId = /transid=(\d+)/.exec(openTag)?.[1];
  const date = parseHistoryDate(textOf(cell(row, 'wht_date') ?? ''));
  if (!transId || date == null) return null;

  const typeCell = cell(row, 'wht_type') ?? '';
  const typeLabel = textOf(/<div>([\s\S]*?)<\/div>/i.exec(typeCell)?.[1] ?? typeCell.replace(/<div class="wth_payment"[\s\S]*?<\/div>/i, ''));

  // Items are one <div> each; the payment line inside an in-game purchase is not an item.
  const itemCell = cell(row, 'wht_items') ?? '';
  const names: string[] = [];
  const divs = itemCell.matchAll(/<div\b(?![^>]*wth_payment)[^>]*>([\s\S]*?)<\/div>/gi);
  for (const d of divs) names.push(textOf(d[1]));
  if (names.length === 0) names.push(textOf(itemCell));
  const items = names.filter((n) => n !== '' && n.toLowerCase() !== 'refund');

  const baseCell = cell(row, 'wht_base_price') ?? '';
  const original = /wht_original_price"[^>]*>([\s\S]*?)<\/span>/i.exec(baseCell)?.[1];
  const pct = /wht_discount_pct"[^>]*>\s*-?(\d+)%/i.exec(baseCell)?.[1];
  const list = parseMoneyText(textOf(original ?? baseCell));
  const tax = parseMoneyText(textOf(cell(row, 'wht_tax') ?? ''));
  const total = parseMoneyText(textOf(cell(row, 'wht_total') ?? ''));

  return {
    transId,
    date,
    kind: classify(typeLabel),
    typeLabel,
    items,
    listCents: original || baseCell.trim() ? (list?.cents ?? null) : null,
    discountPct: pct ? Number(pct) : null,
    taxCents: tax?.cents ?? null,
    totalCents: total?.cents ?? null,
    symbol: total?.symbol ?? list?.symbol ?? null,
  };
}

/** The history rows in a chunk of HTML: a whole page, or the `html` an AjaxLoadMoreHistory answer carries. */
export function parseHistoryRows(html: string): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const re = /(<tr\b[^>]*\bclass="wallet_table_row[^"]*"[^>]*>)([\s\S]*?)<\/tr>/gi;
  for (const m of html.matchAll(re)) {
    const row = parseRow(m[1], m[2]);
    if (row) rows.push(row);
  }
  return rows;
}

/** The cursor the page's script holds for "Load More Transactions"; null when it holds none. */
export function parseHistoryCursor(html: string): Record<string, string> | null {
  const m = /g_historyCursor\s*=\s*(\{[^;]*?\}|null)\s*;/.exec(html);
  if (!m || m[1] === 'null') return null;
  try {
    return cursorFrom(JSON.parse(m[1]));
  } catch {
    return null;
  }
}

/** A cursor as the form fields Steam wants back: flat, every value text. Null when empty or not an object. */
export function cursorFrom(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function parseHistoryPage(html: string): HistoryPage {
  return { rows: parseHistoryRows(html), cursor: parseHistoryCursor(html), hasTable: html.includes('wallet_history_table') };
}

// ---------------------------------------------------------------------------
// From receipts to games.

/** What the matching needs to know about a library game. */
export interface ReceiptGame {
  appId: number;
  name: string;
  /** Unix seconds of the earliest license, from the licenses. */
  acquiredAt: number | null;
  /** The regular price ITAD recorded, used only to share a multi-item receipt out fairly. */
  regularCents: number | null;
}

/** What a game cost according to the receipt that paid for it. */
export interface ReceiptPrice {
  appId: number;
  transId: string;
  /** Unix seconds (00:00 UTC) of the receipt's day. */
  date: number;
  price: Money;
  /** The receipt paid for more than this game, so the price is this game's share. */
  split: boolean;
  /** How many items the (unrefunded part of the) receipt covers. */
  itemCount: number;
}

const DAY = 86400;
/** A license is stamped within a day or so of the receipt; this leaves room for time zones. */
const MAX_DAYS_APART = 3;

/** A name reduced to lower-case words, so "STAR WARS™ Squadrons" and "Star Wars Squadrons" agree. */
export function normalizeName(name: string): string {
  return decodeEntities(name)
    .replace(/[™®©]/g, ' ') // before NFKD, which would turn ™ into "TM"
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** 0 for the same name, 1 when one is the other plus extra words at the end ("Game" and "Game Deluxe Edition"), null otherwise. */
function nameScore(item: string, game: string): 0 | 1 | null {
  if (item === '' || game === '') return null;
  if (item === game) return 0;
  const [short, long] = item.length <= game.length ? [item, game] : [game, item];
  return short.length >= 4 && long.startsWith(`${short} `) ? 1 : null;
}

interface Entry {
  row: HistoryRow;
  items: { name: string; norm: string; refunded: boolean }[];
  refundedCents: number;
}

function isWalletCredit(row: HistoryRow): boolean {
  return row.items.length === 1 && /wallet credit/i.test(row.items[0]);
}

/**
 * Which library game each purchase paid for, and what share of it. A purchase
 * is matched on the game's name (the same name beats a name that only starts
 * the same) and on the date: the game's license must be within a few days of
 * the receipt, so a later game with a similar name (Wreckfest and Wreckfest 2)
 * is never mistaken for the earlier one. Refunds take their items, and the
 * refunded amount, out of the purchase they belong to. A receipt that paid for
 * several things is shared out by regular price, or equally when that is unknown.
 */
export function priceFromReceipts(rows: HistoryRow[], games: ReceiptGame[], country: string): ReceiptPrice[] {
  const ordered = [...rows].sort(
    (a, b) => a.date - b.date || Number(a.kind === 'refund') - Number(b.kind === 'refund') || a.transId.localeCompare(b.transId)
  );

  // Purchases, with refunds taken off as they come.
  const entries: Entry[] = [];
  for (const row of ordered) {
    if (row.kind === 'purchase' && row.totalCents != null && row.items.length > 0 && !isWalletCredit(row)) {
      entries.push({ row, items: row.items.map((name) => ({ name, norm: normalizeName(name), refunded: false })), refundedCents: 0 });
    } else if (row.kind === 'refund') {
      const touched = new Set<Entry>();
      for (const name of row.items) {
        const norm = normalizeName(name);
        for (let i = entries.length - 1; i >= 0; i--) {
          const item = entries[i].items.find((it) => !it.refunded && it.norm === norm);
          if (item && entries[i].row.date <= row.date) {
            item.refunded = true;
            touched.add(entries[i]);
            break;
          }
        }
      }
      for (const e of touched) e.refundedCents += Math.round((row.totalCents ?? 0) / touched.size);
    }
  }

  // Candidate (receipt item, game) pairs, best first, each used once.
  interface Candidate {
    entry: Entry;
    itemIndex: number;
    game: ReceiptGame;
    score: number;
    apart: number;
  }
  const candidates: Candidate[] = [];
  const normGames = games.map((g) => ({ game: g, norm: normalizeName(g.name) }));
  for (const entry of entries) {
    entry.items.forEach((item, itemIndex) => {
      if (item.refunded) return;
      for (const { game, norm } of normGames) {
        const score = nameScore(item.norm, norm);
        if (score == null) continue;
        const apart = game.acquiredAt == null ? null : Math.abs(game.acquiredAt - entry.row.date) / DAY;
        // Without a license date only the exact name counts; with one, it must be close.
        if (apart == null ? score !== 0 : apart > MAX_DAYS_APART) continue;
        candidates.push({ entry, itemIndex, game, score, apart: apart ?? Number.MAX_SAFE_INTEGER });
      }
    });
  }
  candidates.sort((a, b) => a.score - b.score || a.apart - b.apart || a.game.appId - b.game.appId);

  const gameTaken = new Set<number>();
  const itemTaken = new Set<string>();
  const matched = new Map<Entry, Map<number, ReceiptGame>>();
  for (const c of candidates) {
    const key = `${c.entry.row.transId}#${c.itemIndex}`;
    if (gameTaken.has(c.game.appId) || itemTaken.has(key)) continue;
    gameTaken.add(c.game.appId);
    itemTaken.add(key);
    const forEntry = matched.get(c.entry) ?? new Map<number, ReceiptGame>();
    forEntry.set(c.itemIndex, c.game);
    matched.set(c.entry, forEntry);
  }

  // Each matched game's share of what that receipt really cost.
  const out: ReceiptPrice[] = [];
  for (const [entry, byItem] of matched) {
    const currency = currencyFromSymbol(entry.row.symbol, country);
    if (!currency) continue;
    const live = entry.items.map((it, i) => ({ it, i })).filter((x) => !x.it.refunded);
    const remaining = Math.max(0, (entry.row.totalCents ?? 0) - entry.refundedCents);
    const fallbackWeight = Math.max(1, (entry.row.listCents ?? 0) / live.length);
    const weight = (i: number) => {
      const regular = byItem.get(i)?.regularCents;
      return regular != null && regular > 0 ? regular : fallbackWeight;
    };
    const sum = live.reduce((s, x) => s + weight(x.i), 0);
    for (const { i } of live) {
      const game = byItem.get(i);
      if (!game) continue;
      const cents = live.length === 1 ? remaining : Math.round((remaining * weight(i)) / sum);
      out.push({
        appId: game.appId,
        transId: entry.row.transId,
        date: entry.row.date,
        price: { cents, currency },
        split: live.length > 1,
        itemCount: live.length,
      });
    }
  }
  return out;
}
