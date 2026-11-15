import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { Store } from './database/store';
import { SecretStore } from './secrets';
import { SteamSession } from './steam/steamClient';
import { META_STEAM_FOLDER, META_STEAM_ID, META_STEAM_STATUS, needsPricing, runSync, SyncDeps } from './sync';
import { Call, FAKE_LOGIN_COOKIE, fakeFetch, fakeSafeStorage, FakeSteamScript, FakeSteamUser, historyPage, historyRow, noSleep, tempDir } from './testing/fakes';
import { summarize } from '../shared/value';
import type { SyncProgress } from '../shared/types';

const ME = 1000;
const STEAM_ID = '76561197960266728';
const DAY = 24 * 3600;
const BOUGHT = Date.parse('2021-06-01T00:00:00Z') / 1000;

/** A pretend Steam account: three games, one bought, one free, one keyed late. */
function steamScript(onLogOn?: FakeSteamScript['onLogOn']): FakeSteamScript {
  return {
    onLogOn: onLogOn ?? ((c) => c.succeed(ME, 'renewed-token')),
    licenses: [
      { package_id: 100, time_created: BOUGHT, payment_method: 2, owner_id: ME },
      { package_id: 0, time_created: BOUGHT - DAY, payment_method: 0, owner_id: ME },
      { package_id: 300, time_created: BOUGHT + 10 * DAY, payment_method: 1, owner_id: ME },
    ],
    packages: {
      100: { appids: [10], billingtype: 10 },
      0: { appids: [20] },
      300: { appids: [30], billingtype: 3 },
    },
  };
}

interface Harness {
  deps: SyncDeps;
  store: Store;
  secrets: SecretStore;
  fetch: ReturnType<typeof fakeFetch>;
  users: FakeSteamUser[];
  progress: SyncProgress[];
  clock: { now: number };
}

type Respond = (call: Call) => ReturnType<Parameters<typeof fakeFetch>[0]>;

function harness(opts: { library?: unknown; itad?: Respond; history?: Respond; script?: FakeSteamScript } = {}): Harness {
  const dir = tempDir();
  const store = new Store(path.join(dir, 'sync.db'));
  const secrets = SecretStore.inDirectory(dir, fakeSafeStorage());
  const clock = { now: 1700000000 };
  const users: FakeSteamUser[] = [];
  const progress: SyncProgress[] = [];
  const library = opts.library ?? {
    response: {
      games: [
        { appid: 10, name: 'Bought Game', playtime_forever: 600 },
        { appid: 20, name: 'Free Game', playtime_forever: 120 },
        { appid: 30, name: 'Keyed Game', playtime_forever: 0 },
      ],
    },
  };
  const itad =
    opts.itad ??
    ((call: Call) => {
      if (call.url.includes('/lookup/id/shop/61/')) {
        const ids = JSON.parse(call.body ?? '[]') as string[];
        return { body: Object.fromEntries(ids.map((id) => [id, `itad-${id.slice(4)}`])) };
      }
      const id = new URL(call.url).searchParams.get('id');
      const price = id === 'itad-10' ? 1999 : 2999;
      return {
        body: [
          { timestamp: '2021-05-20T00:00:00Z', shop: { id: 61 }, deal: { price: { amountInt: price, currency: 'USD' }, regular: { amountInt: price, currency: 'USD' }, cut: 0 } },
          { timestamp: '2020-01-01T00:00:00Z', shop: { id: 61 }, deal: { price: { amountInt: 4999, currency: 'USD' }, regular: { amountInt: 4999, currency: 'USD' }, cut: 0 } },
        ],
      };
    });
  const fetch = fakeFetch((call) => {
    if (call.url.startsWith('https://api.steampowered.com/')) return { body: library };
    if (call.url.startsWith('https://api.isthereanydeal.com/')) return itad(call);
    if (call.url.startsWith('https://store.steampowered.com/account/')) return (opts.history ?? (() => ({ body: historyPage([]) })))(call);
    return { status: 404 };
  });
  const deps: SyncDeps = {
    store,
    secrets,
    fetch,
    now: () => clock.now,
    sleep: noSleep,
    onProgress: (p) => progress.push(p),
    openSteam: () =>
      new SteamSession(
        () => {
          const u = new FakeSteamUser(opts.script ?? steamScript());
          users.push(u);
          return u;
        },
        { onRefreshToken: (t) => secrets.set('steamRefreshToken', t), onSteamGuard: async () => 'unused' }
      ),
  };
  return { deps, store, secrets, fetch, users, progress, clock };
}

test('with no Web API key the sync asks for it and touches nothing', async () => {
  const h = harness();
  const result = await runSync(h.deps);
  assert.equal(result.phase, 'needs-keys');
  assert.equal(h.fetch.calls.length, 0);
});

test('with a key but no Steam sign-in yet it asks to sign in', async () => {
  const h = harness();
  h.secrets.set('steamWebApiKey', 'WEBKEY');
  const result = await runSync(h.deps);
  assert.equal(result.phase, 'needs-login');
  assert.equal(h.fetch.calls.length, 0);
});

test('a first sync reads the library, purchase dates and prices', async () => {
  const h = harness();
  h.secrets.set('steamWebApiKey', 'WEBKEY');
  h.secrets.set('itadApiKey', 'ITADKEY');
  h.secrets.set('steamRefreshToken', 'old-token');

  const result = await runSync(h.deps);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.games, 3);
  assert.equal(result.pricesLookedUp, 2, 'the free game is not priced');
  assert.deepEqual(h.users[0].logOns, [{ refreshToken: 'old-token' }]);
  assert.equal(h.secrets.get('steamRefreshToken'), 'renewed-token', 'the renewed token is saved');
  assert.equal(h.store.getMeta(META_STEAM_ID), STEAM_ID);
  assert.equal(h.users[0].loggedOff, 1, 'the session is closed');

  const byId = new Map(h.store.listGames().map((g) => [g.appId, g]));
  assert.equal(byId.get(10)?.acquisition, 'purchase');
  assert.equal(byId.get(10)?.estimate?.price?.cents, 1999, 'the price on the purchase day, not before');
  assert.equal(byId.get(20)?.acquisition, 'free');
  assert.equal(byId.get(20)?.estimate, null);
  assert.equal(byId.get(30)?.acquisition, 'key');

  const summary = summarize(h.store.listGames());
  assert.equal(summary.totalSpentCents, 1999 + 2999);
  assert.deepEqual(summary.neverPlayed.map((g) => g.appId), [30]);
  assert.deepEqual(summary.ranked.map((g) => g.appId), [20, 10]);
  assert.ok(Math.abs((summary.ranked[1].costPerHour ?? 0) - 1.999) < 1e-9);

  // No secret appears in any progress message or the result.
  const shown = JSON.stringify([h.progress, result]);
  for (const secret of ['WEBKEY', 'ITADKEY', 'old-token', 'renewed-token']) assert.equal(shown.includes(secret), false);
});

test('a second sync only prices what changed', async () => {
  const h = harness();
  h.secrets.set('steamWebApiKey', 'WEBKEY');
  h.secrets.set('itadApiKey', 'ITADKEY');
  h.secrets.set('steamRefreshToken', 'old-token');
  await runSync(h.deps);
  const itadCallsAfterFirst = h.fetch.calls.filter((c) => c.url.includes('isthereanydeal')).length;

  h.clock.now += DAY;
  const second = await runSync(h.deps);
  assert.equal(second.ok, true);
  assert.equal(second.pricesLookedUp, 0);
  assert.equal(h.fetch.calls.filter((c) => c.url.includes('isthereanydeal')).length, itadCallsAfterFirst);
});

test('an expired Steam token is removed and the user is asked to sign in again', async () => {
  const h = harness({ script: steamScript((c) => c.emit('error', Object.assign(new Error('Expired'), { eresult: 27 }))) });
  h.secrets.set('steamWebApiKey', 'WEBKEY');
  h.secrets.set('steamRefreshToken', 'stale');
  const result = await runSync(h.deps);
  assert.equal(result.phase, 'needs-login');
  assert.equal(h.secrets.get('steamRefreshToken'), null);
});

test('if Steam cannot be reached the library still updates from the Web API', async () => {
  const h = harness({ script: steamScript((c) => c.emit('error', Object.assign(new Error('NoConnection'), { eresult: 3 }))) });
  h.secrets.set('steamWebApiKey', 'WEBKEY');
  h.secrets.set('steamRefreshToken', 'tok');
  h.store.setMeta(META_STEAM_ID, STEAM_ID);
  const result = await runSync(h.deps);
  assert.equal(result.ok, true);
  assert.match(result.message, /purchase dates were not updated/);
  assert.equal(h.store.listGames().length, 3);
  assert.equal(h.secrets.get('steamRefreshToken'), 'tok', 'a network failure keeps the token');
});

test('without an ITAD key it syncs and says prices need a key', async () => {
  const h = harness();
  h.secrets.set('steamWebApiKey', 'WEBKEY');
  h.secrets.set('steamRefreshToken', 'tok');
  const result = await runSync(h.deps);
  assert.equal(result.ok, true);
  assert.match(result.message, /IsThereAnyDeal key/);
  assert.equal(h.fetch.calls.some((c) => c.url.includes('isthereanydeal')), false);
});

test('a game ITAD does not know is marked, and a failed lookup is retried next time', async () => {
  let fail = true;
  const h = harness({
    itad: (call) => {
      if (call.url.includes('/lookup/')) return { body: { 'app/10': 'itad-10', 'app/30': null } };
      if (fail) return { status: 404 };
      return { body: [{ timestamp: '2021-01-01T00:00:00Z', shop: { id: 61 }, deal: { price: { amountInt: 500, currency: 'USD' } } }] };
    },
  });
  h.secrets.set('steamWebApiKey', 'WEBKEY');
  h.secrets.set('itadApiKey', 'ITADKEY');
  h.secrets.set('steamRefreshToken', 'tok');
  await runSync(h.deps);
  assert.equal(h.store.getEstimate(30)?.status, 'not_found');
  assert.equal(h.store.getEstimate(10)?.status, 'error');
  fail = false;
  const again = await runSync(h.deps);
  assert.equal(again.pricesLookedUp, 1, 'only the failed one is looked up again');
  assert.equal(h.store.getEstimate(10)?.price?.cents, 500);
});

test('a found-nothing estimate is retried only after a month, and a new date reprices', () => {
  const base = { appId: 1, forDate: 100, country: 'US', price: null, regular: null, cut: null, recordedAt: null, match: null, error: null };
  assert.equal(needsPricing(null, 100, 'US', 0), true);
  assert.equal(needsPricing({ ...base, status: 'not_found', lookedUpAt: 0 }, 100, 'US', 10 * DAY), false);
  assert.equal(needsPricing({ ...base, status: 'not_found', lookedUpAt: 0 }, 100, 'US', 31 * DAY), true);
  assert.equal(needsPricing({ ...base, status: 'ok', lookedUpAt: 0 }, 100, 'US', 400 * DAY), false);
  assert.equal(needsPricing({ ...base, status: 'ok', lookedUpAt: 0 }, 101, 'US', 0), true);
  assert.equal(needsPricing({ ...base, status: 'ok', lookedUpAt: 0 }, 100, 'GB', 0), true);
});

function withKeys(h: Harness): void {
  h.secrets.set('steamWebApiKey', 'WEBKEY');
  h.secrets.set('itadApiKey', 'ITADKEY');
  h.secrets.set('steamRefreshToken', 'old-token');
}

/** Bought Game (app 10) came in on 2021-06-01; this is the receipt for it. */
const boughtGameReceipt = (total = '$12.34') => historyRow({ id: '501', date: 'Jun 1, 2021', items: ['Bought Game'], base: '$14.99', tax: '$0.99', total });

test('a game with a receipt costs what the receipt says, and is not looked up as an estimate', async () => {
  const h = harness({ history: () => ({ body: historyPage([boughtGameReceipt()]) }) });
  withKeys(h);
  const result = await runSync(h.deps);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.pricesLookedUp, 1, 'only the keyed game is estimated');
  assert.match(result.message, /1 priced from receipts/);

  const bought = h.store.listGames().find((g) => g.appId === 10);
  assert.deepEqual(bought?.receipt?.price, { cents: 1234, currency: 'USD' });
  assert.equal(bought?.receipt?.split, false);
  assert.equal(h.store.getEstimate(10), null, 'ITAD was not asked about it');
  assert.equal(h.fetch.calls.some((c) => c.url.includes('isthereanydeal') && c.url.includes('itad-10')), false);

  const summary = summarize(h.store.listGames());
  const valued = [...summary.ranked, ...summary.neverPlayed].find((g) => g.appId === 10);
  assert.equal(valued?.basis, 'receipt');
  assert.equal(summary.totalSpentCents, 1234 + 2999);
  assert.equal(summary.receiptCount, 1);
});

test('the receipts are read with the web cookies, once, and the cookies are never shown or saved', async () => {
  const h = harness({ history: () => ({ body: historyPage([boughtGameReceipt()]) }) });
  withKeys(h);
  const result = await runSync(h.deps);
  const history = h.fetch.calls.filter((c) => c.url.startsWith('https://store.steampowered.com/'));
  assert.equal(history.length, 1);
  assert.match(history[0].headers?.Cookie ?? '', new RegExp(FAKE_LOGIN_COOKIE));
  const shown = JSON.stringify([h.progress, result]);
  assert.equal(shown.includes(FAKE_LOGIN_COOKIE), false);
  assert.ok(h.progress.some((p) => p.phase === 'reading-receipts'));
  assert.equal(JSON.stringify(h.store.listReceipts()).includes(FAKE_LOGIN_COOKIE), false);
  assert.equal(h.users[0].loggedOff, 1);
});

test('a later sync keeps the saved receipts and does not page back through them', async () => {
  let pages = 0;
  const h = harness({
    history: (call) => {
      pages += 1;
      if (call.method === 'POST') return { body: { success: 1, html: historyRow({ id: '400', date: 'Jan 5, 2020', items: ['Old Thing'], total: '$1.00' }), cursor: null } };
      return { body: historyPage([boughtGameReceipt()], '{"wcnt":"1"}') };
    },
  });
  withKeys(h);
  await runSync(h.deps);
  assert.equal(pages, 2, 'the first sync reads both pages');
  assert.equal(h.store.listReceipts().length, 2);

  pages = 0;
  const again = await runSync(h.deps);
  assert.equal(again.ok, true);
  assert.equal(pages, 1, 'the second stops at the receipt it already has');
  assert.equal(h.store.listGames().find((g) => g.appId === 10)?.receipt?.price.cents, 1234);
});

test('when the purchase history cannot be read the sync still finishes, on estimates', async () => {
  const h = harness({ history: () => ({ body: '<html>Sign in to Steam</html>' }) });
  withKeys(h);
  const result = await runSync(h.deps);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /Receipt prices were not updated: Steam did not show the purchase history/);
  assert.equal(h.store.listGames().find((g) => g.appId === 10)?.receipt, null);
  assert.equal(h.store.getEstimate(10)?.price?.cents, 1999, 'the estimate is still used');
});

test('a server error from the store is a note, not a failure', async () => {
  const h = harness({ history: () => ({ status: 503 }) });
  withKeys(h);
  const result = await runSync(h.deps);
  assert.equal(result.ok, true);
  assert.match(result.message, /Receipt prices were not updated: The Steam store answered HTTP 503/);
});

test('receipts saved earlier still apply when this sync could not sign in to Steam', async () => {
  const h = harness();
  withKeys(h);
  h.store.setMeta(META_STEAM_ID, STEAM_ID);
  h.store.saveReceipts([
    { transId: '501', date: BOUGHT, kind: 'purchase', typeLabel: 'Purchase', items: ['Bought Game'], listCents: 1499, discountPct: null, taxCents: 99, totalCents: 1234, symbol: '$' },
  ]);
  h.deps.openSteam = () =>
    new SteamSession(() => new FakeSteamUser(steamScript((c) => c.emit('error', Object.assign(new Error('NoConnection'), { eresult: 3 })))), {
      onRefreshToken: () => undefined,
      onSteamGuard: async () => 'unused',
    });
  const offline = await runSync(h.deps);
  assert.match(offline.message, /purchase dates were not updated/);
  // No license date was read, so only the exact name can match; it does, from the saved receipt, with no web request.
  assert.equal(h.store.listGames().find((g) => g.appId === 10)?.receipt?.price.cents, 1234);
  assert.equal(h.fetch.calls.some((c) => c.url.startsWith('https://store.steampowered.com/')), false);
});

test('a receipt shared with an add-on is split, and a refund with no purchase behind it is ignored', async () => {
  const h = harness({
    history: () => ({
      body: historyPage([
        historyRow({ id: '503', date: 'Jun 4, 2021', items: ['Keyed Game', 'Refund'], type: 'Refund', total: '$5.00' }),
        historyRow({ id: '502', date: 'Jun 1, 2021', items: ['Bought Game', 'Bought Game - Soundtrack'], base: ['-50%', '$20.00', '$10.00'], total: '$10.00' }),
      ]),
    }),
  });
  withKeys(h);
  await runSync(h.deps);
  const bought = h.store.listGames().find((g) => g.appId === 10);
  assert.equal(bought?.receipt?.split, true);
  assert.equal(bought?.receipt?.itemCount, 2);
  assert.ok((bought?.receipt?.price.cents ?? 0) > 0 && (bought?.receipt?.price.cents ?? 0) < 1000, 'its share, not the whole receipt');
  const valued = summarize(h.store.listGames()).ranked.find((g) => g.appId === 10);
  assert.ok(valued?.flags.some((f) => /Shared receipt/.test(f)));
});

function withSteamFolder(h: Harness, read: SyncDeps['readSteamFolder']): void {
  h.deps.readSteamFolder = read;
  h.secrets.set('steamWebApiKey', 'WEBKEY');
  h.secrets.set('itadApiKey', 'ITADKEY');
  h.secrets.set('steamRefreshToken', 'tok');
}

test('the Steam folder is read on every sync, with its status saved', async () => {
  const h = harness();
  const seen: unknown[] = [];
  withSteamFolder(h, (opts) => {
    seen.push(opts);
    return {
      found: true,
      libraries: ['/a', '/b'],
      installs: new Map([[10, { libraryPath: '/a', sizeOnDisk: 99 }]]),
      hidden: new Set([20]),
      favorites: new Set(),
    };
  });
  h.store.setMeta(META_STEAM_FOLDER, '/custom/steam');
  const result = await runSync(h.deps);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(seen, [{ folder: '/custom/steam', steamId64: STEAM_ID }]);
  assert.equal(h.store.getMeta(META_STEAM_STATUS), 'Found 2 libraries and 1 installed game.');
  assert.equal(result.games, 2, 'a game set aside in Steam is not counted');
  assert.equal(h.store.listGames().find((g) => g.appId === 10)?.installed, true);
  assert.equal(h.store.getEstimate(20), null, 'and is not priced');
});

test('a Steam folder that is not found clears the local data and says so', async () => {
  const h = harness();
  withSteamFolder(h, () => ({ found: true, libraries: ['/a'], installs: new Map([[10, { libraryPath: '/a', sizeOnDisk: 1 }]]), hidden: new Set([20]), favorites: null }));
  await runSync(h.deps);
  h.deps.readSteamFolder = () => ({ found: false, libraries: [], installs: new Map(), hidden: null, favorites: null });
  const result = await runSync(h.deps);
  assert.equal(result.games, 3);
  assert.equal(h.store.getMeta(META_STEAM_STATUS), 'Steam folder not found.');
  assert.ok(h.store.listGames().every((g) => !g.installed));
});

test('a Steam folder that throws never fails the sync', async () => {
  const h = harness();
  withSteamFolder(h, () => {
    throw new Error('locked');
  });
  const result = await runSync(h.deps);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.games, 3);
  assert.equal(result.pricesLookedUp, 2);
  assert.equal(h.store.getMeta(META_STEAM_STATUS), 'Could not read the Steam folder.');
});
