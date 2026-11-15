import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, requestJson } from './http';
import { fakeFetch, noSleep } from './testing/fakes';

test('a busy answer is tried again, then the real answer is returned', async () => {
  let n = 0;
  const waits: number[] = [];
  const f = fakeFetch(() => (++n < 3 ? { status: n === 1 ? 429 : 503, headers: { 'retry-after': '5' } } : { body: { ok: 1 } }));
  const body = await requestJson(f, 'Test', 'https://x/?key=SECRET', {}, { sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(body, { ok: 1 });
  assert.deepEqual(waits, [5000, 5000]);
});

test('a refused request is not retried, and its error never shows the URL', async () => {
  const f = fakeFetch(() => ({ status: 403 }));
  await assert.rejects(
    requestJson(f, 'Test', 'https://x/?key=SECRET', {}, { sleep: noSleep }),
    (err: unknown) => err instanceof HttpError && err.status === 403 && !err.message.includes('SECRET')
  );
  assert.equal(f.calls.length, 1);
});

test('a network failure gives up after the retries without the URL', async () => {
  const f = fakeFetch(() => new Error('ECONNRESET https://x/?key=SECRET'));
  await assert.rejects(requestJson(f, 'Test', 'https://x/?key=SECRET', {}, { sleep: noSleep, retries: 2 }), (err: Error) => {
    assert.equal(err.message, 'Test could not be reached.');
    return true;
  });
  assert.equal(f.calls.length, 3);
});
