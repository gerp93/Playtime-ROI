// Cost per hour, rankings and totals. Pure: the dashboard and the tests both call it.
import type { DashboardSummary, GameRow, Money, ValuedGame } from './types';

const ACQUIRED_FREE_LABEL: Record<string, string> = {
  free: 'Free',
  gift: 'Gift',
  family: 'Family sharing',
};

/** Where a summary's currency is unknown (nothing priced yet). */
export const FALLBACK_CURRENCY = 'USD';

export function hoursFromMinutes(minutes: number): number {
  return Math.max(0, minutes) / 60;
}

/** The currency most of the counted prices are in, so one odd price doesn't change the whole total. */
export function mainCurrency(rows: GameRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const money = row.manualPrice ?? (row.estimate?.status === 'ok' ? row.estimate.price : null);
    if (!money) continue;
    counts.set(money.currency, (counts.get(money.currency) ?? 0) + 1);
  }
  let best = FALLBACK_CURRENCY;
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      best = currency;
      bestCount = count;
    }
  }
  return best;
}

export function valueGame(row: GameRow, currency: string): ValuedGame {
  const hours = hoursFromMinutes(row.playtimeMinutes);
  const flags: string[] = [];
  let counted: Money | null = null;
  let basis: ValuedGame['basis'] = 'unknown';

  if (row.manualPrice) {
    counted = row.manualPrice;
    basis = 'manual';
  } else if (row.acquisition in ACQUIRED_FREE_LABEL) {
    counted = { cents: 0, currency };
    basis = 'zero';
    flags.push(ACQUIRED_FREE_LABEL[row.acquisition]);
  } else if (row.estimate?.status === 'ok' && row.estimate.price) {
    counted = row.estimate.price;
    basis = 'estimate';
    if (row.estimate.match === 'after') flags.push('Price recorded after you got it');
    if (row.bundle) flags.push(`Bundle of ${row.bundleSize}: full single price used`);
    if (row.acquisition === 'key') flags.push('Key: you may have paid less');
    if (row.acquisition === 'unknown') flags.push('No license found');
  } else {
    if (row.acquisition === 'unknown') flags.push('No license found');
    if (row.estimate?.status === 'not_found') flags.push('Not on IsThereAnyDeal');
    else if (row.estimate?.status === 'no_history') flags.push('No price history');
    else if (row.estimate?.status === 'error') flags.push('Price lookup failed');
    else if (!row.estimate) flags.push('Not priced yet');
  }

  if (hours > 0 && hours < 1) flags.push('Played under an hour');

  const costPerHour = counted && hours > 0 ? counted.cents / 100 / hours : null;
  return { ...row, counted, basis, hours, costPerHour, flags };
}

export function summarize(rows: GameRow[]): DashboardSummary {
  const currency = mainCurrency(rows);
  const valued = rows.map((row) => valueGame(row, currency));

  let totalSpentCents = 0;
  let unknownPriceCount = 0;
  let otherCurrencyCount = 0;
  let pricedHours = 0;
  let totalHours = 0;
  let neverPlayedSpentCents = 0;

  for (const game of valued) {
    totalHours += game.hours;
    if (!game.counted) {
      unknownPriceCount += 1;
      continue;
    }
    if (game.counted.currency !== currency) {
      otherCurrencyCount += 1;
      continue;
    }
    totalSpentCents += game.counted.cents;
    pricedHours += game.hours;
    if (game.playtimeMinutes <= 0) neverPlayedSpentCents += game.counted.cents;
  }

  const ranked = valued
    .filter((g) => g.costPerHour != null && g.counted?.currency === currency)
    .sort((a, b) => (a.costPerHour as number) - (b.costPerHour as number) || b.hours - a.hours);

  const neverPlayed = valued
    .filter((g) => g.playtimeMinutes <= 0)
    .sort((a, b) => (b.counted?.cents ?? -1) - (a.counted?.cents ?? -1) || a.name.localeCompare(b.name));

  return {
    currency,
    totalSpentCents,
    unknownPriceCount,
    otherCurrencyCount,
    totalHours,
    overallCostPerHour: pricedHours > 0 ? totalSpentCents / 100 / pricedHours : null,
    gameCount: valued.length,
    playedCount: valued.filter((g) => g.playtimeMinutes > 0).length,
    neverPlayed,
    ranked,
    neverPlayedSpentCents,
  };
}

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function formatPerHour(value: number | null, currency: string): string {
  if (value == null) return '—';
  return `${formatMoney(Math.round(value * 100), currency)}/h`;
}

export function formatHours(hours: number): string {
  if (hours <= 0) return '0 h';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
}

/**
 * Reads a price typed by the user ("19.99", "$19.99", "19,99") into cents.
 * Returns null when it is not a plain non-negative amount.
 */
export function parsePriceInput(text: string): number | null {
  const cleaned = text.trim().replace(/[^\d.,]/g, '');
  if (cleaned === '') return null;
  const normalised = /,\d{1,2}$/.test(cleaned) && !cleaned.includes('.') ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;
  const [whole, frac = ''] = normalised.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
