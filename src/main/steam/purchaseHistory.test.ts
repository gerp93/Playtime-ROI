import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPurchaseHistory, HistoryUnavailableError } from './purchaseHistory';
import { fakeFetch, historyPage, historyRow, noSleep } from '../testing/fakes';

const WEB = { sessionId: 'sess-1', cookies: ['steamLoginSecure=login-secret; Path=/; Secure', 'sessionid=sess-1'] };

const row = (id: string, date = 'Oct 2, 2026') => historyRow({ id, date, items: [`Game ${id}`], base: '$10.00', tax: '$1.00', total: '$11.00' });

test('the first page is read with the web cookies, in English', async () => {
  const f = fakeFetch(() => ({ body: historyPage([row('1'), row('2')]) }));
  const rows = await fetchPurchaseHistory(f, WEB, new Set(), { sleep: noSleep });
  assert.deepEqual(rows.map((r) => r.transId), ['1', '2']);
  assert.equal(f.calls.length, 1, 'no cursor, no more pages');
  assert.equal(f.calls[0].url, 'https://store.steampowered.com/account/history/?l=english');
  const cookie = f.calls[0].headers?.Cookie ?? '';
  assert.match(cookie, /steamLoginSecure=login-secret/);
  assert.equal(cookie.includes('Path=/'), false, 'only name=value pairs are sent');
});

test('"Load More" is followed until Steam gives no more cursor', async () => {
  const f = fakeFetch((call) => {
    if (call.method === 'GET') return { body: historyPage([row('1')], '{"wcnt":"1","wtime":1700}') };
    const cursor = new URLSearchParams(call.body).get('cursor[wtime]');
    if (cursor === '1700') return { body: { success: 1, html: row('2') + row('3'), cursor: { wcnt: '3', wtime: 1600 } } };
    return { body: { success: 1, html: row('4'), cursor: null } };
  });
  const rows = await fetchPurchaseHistory(f, WEB, new Set(), { sleep: noSleep });
  assert.deepEqual(rows.map((r) => r.transId), ['1', '2', '3', '4']);
  const posts = f.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  const form = new URLSearchParams(posts[0].body);
  assert.equal(form.get('cursor[wcnt]'), '1');
  assert.equal(form.get('sessionid'), 'sess-1');
  assert.match(posts[0].headers?.['Content-Type'] ?? '', /x-www-form-urlencoded/);
});

test('it stops at the page that holds a transaction it already has', async () => {
  const f = fakeFetch((call) => {
    if (call.method === 'GET') return { body: historyPage([row('9'), row('8')], '{"wcnt":"2"}') };
    return { body: { success: 1, html: row('7'), cursor: { wcnt: '3' } } };
  });
  const rows = await fetchPurchaseHistory(f, WEB, new Set(['8']), { sleep: noSleep });
  assert.deepEqual(rows.map((r) => r.transId), ['9', '8']);
  assert.equal(f.calls.length, 1, 'nothing below a known row is fetched again');

  const g = fakeFetch((call) => {
    if (call.method === 'GET') return { body: historyPage([row('9')], '{"wcnt":"1"}') };
    return { body: { success: 1, html: row('8') + row('7'), cursor: { wcnt: '3' } } };
  });
  const more = await fetchPurchaseHistory(g, WEB, new Set(['8']), { sleep: noSleep });
  assert.deepEqual(more.map((r) => r.transId), ['9', '8', '7']);
  assert.equal(g.calls.length, 2);
});

test('an answer with nothing in it ends the paging instead of looping', async () => {
  const f = fakeFetch((call) => (call.method === 'GET' ? { body: historyPage([row('1')], '{"wcnt":"1"}') } : { body: { success: 0, cursor: { wcnt: '1' } } }));
  const rows = await fetchPurchaseHistory(f, WEB, new Set(), { sleep: noSleep });
  assert.equal(rows.length, 1);
  assert.equal(f.calls.length, 2);
});

test('a sign-in page or a refusal means the history is unavailable', async () => {
  await assert.rejects(fetchPurchaseHistory(fakeFetch(() => ({ body: '<html>Sign in to Steam</html>' })), WEB, new Set(), { sleep: noSleep }), HistoryUnavailableError);
  await assert.rejects(fetchPurchaseHistory(fakeFetch(() => ({ status: 403 })), WEB, new Set(), { sleep: noSleep }), HistoryUnavailableError);
});

test('a failure never shows the cookies or the address', async () => {
  const f = fakeFetch(() => ({ status: 429 }));
  await assert.rejects(fetchPurchaseHistory(f, WEB, new Set(), { sleep: noSleep }), (err: unknown) => {
    const text = String(err instanceof Error ? err.message : err);
    return !text.includes('login-secret') && !text.includes('steampowered.com') && /HTTP 429/.test(text);
  });
});

test('an empty history is fine', async () => {
  const f = fakeFetch(() => ({ body: historyPage([]) }));
  assert.deepEqual(await fetchPurchaseHistory(f, WEB, new Set(), { sleep: noSleep }), []);
});
