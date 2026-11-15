import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceInput, summarize, valueGame, formatHours } from './value';
import type { GameRow, PriceEstimate } from './types';

function est(cents: number, over: Partial<PriceEstimate> = {}): PriceEstimate {
  return {
    status: 'ok',
    price: { cents, currency: 'USD' },
    regular: { cents, currency: 'USD' },
    cut: 0,
    recordedAt: 1,
    match: 'before',
    lookedUpAt: 2,
    error: null,
    ...over,
  };
}

function game(over: Partial<GameRow>): GameRow {
  return {
    appId: 1,
    name: 'Game',
    playtimeMinutes: 600,
    lastPlayed: null,
    acquiredAt: 100,
    acquisition: 'purchase',
    paymentMethod: 'CreditCard',
    packageId: 1,
    bundle: false,
    bundleSize: 1,
    estimate: null,
    manualPrice: null,
    ...over,
  };
}

test('cost per hour uses the manual price first, then the estimate', () => {
  assert.equal(valueGame(game({ estimate: est(2000) }), 'USD').costPerHour, 2);
  const manual = valueGame(game({ estimate: est(2000), manualPrice: { cents: 500, currency: 'USD' } }), 'USD');
  assert.equal(manual.basis, 'manual');
  assert.equal(manual.costPerHour, 0.5);
});

test('free, gift and family games count as costing nothing and are flagged', () => {
  const g = valueGame(game({ acquisition: 'gift', estimate: est(2000) }), 'USD');
  assert.equal(g.basis, 'zero');
  assert.equal(g.costPerHour, 0);
  assert.deepEqual(g.flags, ['Gift']);
});

test('bundles, keys and late price records are flagged as less sure', () => {
  const g = valueGame(game({ bundle: true, bundleSize: 3, acquisition: 'key', estimate: est(1000, { match: 'after' }) }), 'USD');
  assert.deepEqual(g.flags, ['Price recorded after you got it', 'Bundle of 3: full single price used', 'Key: you may have paid less']);
});

test('a game with no price has no cost per hour', () => {
  const g = valueGame(game({ estimate: est(0, { status: 'not_found', price: null }) }), 'USD');
  assert.equal(g.counted, null);
  assert.equal(g.costPerHour, null);
  assert.deepEqual(g.flags, ['Not on IsThereAnyDeal']);
});

test('the summary totals spend, ranks played games and lists never played', () => {
  const s = summarize([
    game({ appId: 1, name: 'Cheap per hour', playtimeMinutes: 6000, estimate: est(2000) }),
    game({ appId: 2, name: 'Pricey per hour', playtimeMinutes: 60, estimate: est(3000) }),
    game({ appId: 3, name: 'Shelf', playtimeMinutes: 0, estimate: est(1500) }),
    game({ appId: 4, name: 'Unknown', playtimeMinutes: 120 }),
    game({ appId: 5, name: 'Euro', playtimeMinutes: 60, manualPrice: { cents: 100, currency: 'EUR' } }),
  ]);
  assert.equal(s.currency, 'USD');
  assert.equal(s.totalSpentCents, 6500);
  assert.equal(s.unknownPriceCount, 1);
  assert.equal(s.otherCurrencyCount, 1);
  assert.deepEqual(s.ranked.map((g) => g.appId), [1, 2]);
  assert.deepEqual(s.neverPlayed.map((g) => g.appId), [3]);
  assert.equal(s.neverPlayedSpentCents, 1500);
  assert.equal(s.gameCount, 5);
  assert.equal(s.playedCount, 4);
  // 65.00 over the 101 hours of the priced USD games
  assert.ok(Math.abs((s.overallCostPerHour ?? 0) - 65 / 101) < 1e-9);
});

test('typed prices are read into cents', () => {
  assert.equal(parsePriceInput('19.99'), 1999);
  assert.equal(parsePriceInput('$5'), 500);
  assert.equal(parsePriceInput('4,99'), 499);
  assert.equal(parsePriceInput('1,299.50'), 129950);
  assert.equal(parsePriceInput('0'), 0);
  assert.equal(parsePriceInput(''), null);
  assert.equal(parsePriceInput('1.999'), null);
});

test('hours are shown in a readable unit', () => {
  assert.equal(formatHours(0), '0 h');
  assert.equal(formatHours(0.5), '30 min');
  assert.equal(formatHours(2.25), '2.3 h');
  assert.equal(formatHours(120), '120 h');
});
