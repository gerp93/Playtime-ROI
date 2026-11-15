// Picks the Steam price on a given day out of IsThereAnyDeal's price
// history. Pure, so it can be tested without the network.
import type { Money, PriceMatch } from './types';

/** One entry of ITAD's /games/history/v2 answer, reduced to what is used. */
export interface PriceRecord {
  /** Unix seconds when this price took effect. */
  at: number;
  price: Money;
  regular: Money | null;
  cut: number;
}

export interface PricePick {
  record: PriceRecord;
  match: PriceMatch;
}

/**
 * Each record says the price changed at that moment, so the price on a day
 * is the last record on or before it. When ITAD's history only starts after
 * the purchase (its records for older games begin around 2014), the first
 * record is used and marked `after`, which the dashboard shows as less sure.
 */
export function priceOnDate(records: PriceRecord[], when: number): PricePick | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort((a, b) => a.at - b.at);
  let best: PriceRecord | null = null;
  for (const record of sorted) {
    if (record.at <= when) best = record;
    else break;
  }
  if (best) return { record: best, match: 'before' };
  return { record: sorted[0], match: 'after' };
}

/** Converts a decimal amount from an API (e.g. 19.99) to whole cents without float drift. */
export function amountToCents(amount: unknown): number | null {
  if (typeof amount === 'number' && Number.isFinite(amount)) return Math.round(amount * 100);
  if (typeof amount === 'string' && /^-?\d+(\.\d+)?$/.test(amount.trim())) return Math.round(Number(amount) * 100);
  return null;
}

function moneyFrom(value: unknown): Money | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const currency = typeof v.currency === 'string' ? v.currency : null;
  if (!currency) return null;
  const cents =
    typeof v.amountInt === 'number' && Number.isInteger(v.amountInt) ? v.amountInt : amountToCents(v.amount);
  if (cents == null || cents < 0) return null;
  return { cents, currency };
}

/**
 * Parses ITAD's history answer: a list of
 * `{ timestamp, shop: {id}, deal: { price, regular, cut } }`. Entries that
 * can't be read are left out rather than guessed at.
 */
export function parseHistory(body: unknown, shopId: number): PriceRecord[] {
  if (!Array.isArray(body)) return [];
  const out: PriceRecord[] = [];
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const shop = e.shop as Record<string, unknown> | undefined;
    if (shop && shop.id != null && Number(shop.id) !== shopId) continue;
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) / 1000 : NaN;
    if (!Number.isFinite(at)) continue;
    const deal = (e.deal ?? {}) as Record<string, unknown>;
    const price = moneyFrom(deal.price);
    if (!price) continue;
    const cut = typeof deal.cut === 'number' && Number.isFinite(deal.cut) ? deal.cut : 0;
    out.push({ at: Math.floor(at), price, regular: moneyFrom(deal.regular), cut });
  }
  return out;
}
