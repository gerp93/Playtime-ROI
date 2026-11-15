import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountToCents, parseHistory, priceOnDate, PriceRecord } from './priceHistory';

const usd = (cents: number) => ({ cents, currency: 'USD' });
const records: PriceRecord[] = [
  { at: 300, price: usd(999), regular: usd(1999), cut: 50 },
  { at: 100, price: usd(1999), regular: usd(1999), cut: 0 },
  { at: 500, price: usd(1999), regular: usd(1999), cut: 0 },
];

test('the price on a day is the last change on or before it', () => {
  assert.equal(priceOnDate(records, 350)?.record.price.cents, 999);
  assert.equal(priceOnDate(records, 350)?.match, 'before');
  assert.equal(priceOnDate(records, 300)?.record.price.cents, 999);
  assert.equal(priceOnDate(records, 600)?.record.at, 500);
});

test('a purchase before the history starts uses the first record, marked after', () => {
  const pick = priceOnDate(records, 50);
  assert.equal(pick?.record.at, 100);
  assert.equal(pick?.match, 'after');
  assert.equal(priceOnDate([], 50), null);
});

test('amounts become cents without float drift', () => {
  assert.equal(amountToCents(19.99), 1999);
  assert.equal(amountToCents(0.29), 29);
  assert.equal(amountToCents('4.99'), 499);
  assert.equal(amountToCents('abc'), null);
});

test('ITAD history entries are parsed and other shops skipped', () => {
  const body = [
    {
      timestamp: '2020-06-25T17:00:00+02:00',
      shop: { id: 61, name: 'Steam' },
      deal: { price: { amount: 4.99, amountInt: 499, currency: 'USD' }, regular: { amount: 19.99, amountInt: 1999, currency: 'USD' }, cut: 75 },
    },
    { timestamp: '2020-01-01T00:00:00Z', shop: { id: 35 }, deal: { price: { amount: 1, currency: 'USD' } } },
    { timestamp: 'not a date', shop: { id: 61 }, deal: { price: { amount: 1, currency: 'USD' } } },
    { timestamp: '2019-01-01T00:00:00Z', shop: { id: 61 }, deal: { price: { amount: '9.99', currency: 'USD' } } },
  ];
  const parsed = parseHistory(body, 61);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { at: Date.parse('2020-06-25T15:00:00Z') / 1000, price: usd(499), regular: usd(1999), cut: 75 });
  assert.deepEqual(parsed[1].price, usd(999));
  assert.equal(parsed[1].regular, null);
  assert.deepEqual(parseHistory({ error: 'x' }, 61), []);
});
