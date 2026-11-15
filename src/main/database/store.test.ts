import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { Store } from './store';
import { tempDir } from '../testing/fakes';

function open(): Store {
  return new Store(path.join(tempDir(), 'test.db'));
}

test('the library is replaced while manual prices stay', () => {
  const store = open();
  store.replaceGames(
    [
      { appId: 1, name: 'b game', playtimeMinutes: 10, lastPlayed: null },
      { appId: 2, name: 'A game', playtimeMinutes: 0, lastPlayed: 5 },
    ],
    100
  );
  store.setManualPrice(1, { cents: 500, currency: 'USD' }, 100);
  store.replaceGames([{ appId: 1, name: 'b game', playtimeMinutes: 70, lastPlayed: 9 }], 200);
  const games = store.listGames();
  assert.equal(games.length, 1);
  assert.equal(games[0].playtimeMinutes, 70);
  assert.deepEqual(games[0].manualPrice, { cents: 500, currency: 'USD' });
  assert.equal(games[0].acquisition, 'unknown');
  store.setManualPrice(1, null, 300);
  assert.equal(store.listGames()[0].manualPrice, null);
  store.close();
});

test('acquisitions and estimates join onto the games', () => {
  const store = open();
  store.replaceGames([{ appId: 1, name: 'G', playtimeMinutes: 60, lastPlayed: null }], 1);
  store.replaceAcquisitions([
    { appId: 1, acquiredAt: 1500000000, acquisition: 'purchase', paymentMethod: 'CreditCard', packageId: 9, bundle: true, bundleSize: 2 },
  ]);
  store.saveEstimate({
    appId: 1,
    forDate: 1500000000,
    country: 'US',
    status: 'ok',
    price: { cents: 1999, currency: 'USD' },
    regular: { cents: 1999, currency: 'USD' },
    cut: 0,
    recordedAt: 1400000000,
    match: 'before',
    lookedUpAt: 2,
    error: null,
  });
  const [g] = store.listGames();
  assert.equal(g.acquiredAt, 1500000000);
  assert.equal(g.bundle, true);
  assert.equal(g.bundleSize, 2);
  assert.equal(g.estimate?.price?.cents, 1999);
  assert.equal(store.getEstimate(1)?.country, 'US');
  assert.equal(store.hasAcquisitions(), true);
  store.close();
});

test('bad manual prices are refused and meta values round-trip', () => {
  const store = open();
  assert.throws(() => store.setManualPrice(1, { cents: 1.5, currency: 'USD' }, 1));
  assert.throws(() => store.setManualPrice(1, { cents: 100, currency: 'usd' }, 1));
  store.setMeta('k', 'v');
  assert.equal(store.getMeta('k'), 'v');
  store.setMeta('k', null);
  assert.equal(store.getMeta('k'), null);
  store.close();
});

test('the data survives closing and reopening', () => {
  const file = path.join(tempDir(), 'again.db');
  const a = new Store(file);
  a.replaceGames([{ appId: 3, name: 'Kept', playtimeMinutes: 1, lastPlayed: null }], 1);
  a.close();
  const b = new Store(file);
  assert.equal(b.listGames()[0].name, 'Kept');
  b.close();
});
