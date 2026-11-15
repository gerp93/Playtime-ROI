import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ItadClient, ItadKeyRejectedError } from './itad';
import { fakeFetch, noSleep } from './testing/fakes';

test('Steam ids are looked up in batches and unknown ones come back null', async () => {
  const f = fakeFetch((call) => {
    const ids = JSON.parse(call.body ?? '[]') as string[];
    return { body: Object.fromEntries(ids.map((id) => [id, id === 'app/2' ? null : `uuid-${id.slice(4)}`])) };
  });
  const ids = Array.from({ length: 250 }, (_, i) => i + 1);
  const map = await new ItadClient(f, 'KEY', { sleep: noSleep }).lookupSteamApps(ids);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].method, 'POST');
  assert.match(f.calls[0].url, /\/lookup\/id\/shop\/61\/v1\?key=KEY$/);
  assert.equal(map.get(1), 'uuid-1');
  assert.equal(map.get(2), null);
  assert.equal(map.get(250), 'uuid-250');
});

test('history asks for all of it, for Steam, in the chosen country', async () => {
  const f = fakeFetch(() => ({
    body: [{ timestamp: '2021-01-01T00:00:00Z', shop: { id: 61 }, deal: { price: { amountInt: 999, currency: 'EUR' }, regular: { amountInt: 1999, currency: 'EUR' }, cut: 50 } }],
  }));
  const history = await new ItadClient(f, 'KEY', { sleep: noSleep }).steamPriceHistory('uuid-1', 'DE');
  const url = new URL(f.calls[0].url);
  assert.equal(url.pathname, '/games/history/v2');
  assert.equal(url.searchParams.get('id'), 'uuid-1');
  assert.equal(url.searchParams.get('country'), 'DE');
  assert.equal(url.searchParams.get('shops'), '61');
  assert.equal(url.searchParams.get('since'), '2000-01-01T00:00:00Z');
  assert.deepEqual(history[0].price, { cents: 999, currency: 'EUR' });
});

test('a refused ITAD key is reported as such', async () => {
  await assert.rejects(new ItadClient(fakeFetch(() => ({ status: 403 })), 'K', { sleep: noSleep }).lookupSteamApps([1]), ItadKeyRejectedError);
});
