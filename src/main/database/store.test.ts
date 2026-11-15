import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { Store } from './store';
import { DatabaseSync } from 'node:sqlite';
import type { LocalSteamInfo } from '../steam/localFiles';
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

function libraryOf(store: Store): void {
  store.replaceGames(
    [
      { appId: 1, name: 'A', playtimeMinutes: 0, lastPlayed: null },
      { appId: 2, name: 'B', playtimeMinutes: 0, lastPlayed: null },
      { appId: 3, name: 'C', playtimeMinutes: 0, lastPlayed: null },
    ],
    1
  );
}

function localInfo(over: Partial<LocalSteamInfo> = {}): LocalSteamInfo {
  return {
    found: true,
    libraries: ['D:\\SteamLibrary'],
    installs: new Map([[1, { libraryPath: 'D:\\SteamLibrary', sizeOnDisk: 4096 }]]),
    hidden: new Set([2]),
    favorites: new Set([3]),
    ...over,
  };
}

test('local installs and favourites join onto games, and games set aside are left out of the list', () => {
  const store = open();
  libraryOf(store);
  store.saveLocalSteam(localInfo());
  const games = store.listGames();
  assert.deepEqual(games.map((g) => g.appId), [1, 3]);
  assert.equal(games[0].installed, true);
  assert.equal(games[0].installDrive, 'D:');
  assert.equal(games[0].sizeOnDiskBytes, 4096);
  assert.equal(games[1].installed, false);
  assert.equal(games[1].installDrive, null);
  assert.equal(games[1].favorite, true);
  assert.equal(store.countInstalledGames(), 1);
  store.close();
});

test('a collection that could not be read keeps its last saved values', () => {
  const store = open();
  libraryOf(store);
  store.saveLocalSteam(localInfo());
  store.saveLocalSteam(localInfo({ hidden: null, favorites: new Set([1]), installs: new Map() }));
  const games = store.listGames();
  assert.deepEqual(games.map((g) => g.appId), [1, 3], 'the earlier set stays');
  assert.equal(games[0].favorite, true);
  assert.equal(games[1].favorite, false);
  assert.equal(games[0].installed, false, 'installs are always replaced');
  store.saveLocalSteam(localInfo({ hidden: new Set(), favorites: new Set() }));
  assert.deepEqual(store.listGames().map((g) => g.appId), [1, 2, 3]);
  store.close();
});

test('a Steam folder that is not found clears everything local', () => {
  const store = open();
  libraryOf(store);
  store.saveLocalSteam(localInfo());
  store.saveLocalSteam({ found: false, libraries: [], installs: new Map(), hidden: null, favorites: null });
  const games = store.listGames();
  assert.equal(games.length, 3);
  assert.ok(games.every((g) => !g.installed && !g.favorite && g.installDrive === null));
  store.close();
});

test('a database made before the local tables gets them when opened', () => {
  const file = path.join(tempDir(), 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE games (app_id INTEGER PRIMARY KEY, name TEXT NOT NULL, playtime_minutes INTEGER NOT NULL DEFAULT 0, last_played INTEGER, updated_at INTEGER NOT NULL);');
  old.exec("INSERT INTO games VALUES (1, 'Old', 60, NULL, 1);");
  old.close();
  const store = new Store(file);
  const games = store.listGames();
  assert.equal(games.length, 1);
  assert.equal(games[0].installed, false);
  store.close();
});
