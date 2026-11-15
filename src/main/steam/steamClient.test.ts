import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SteamAuthError, SteamCancelledError, SteamSession } from './steamClient';
import { FakeSteamUser } from '../testing/fakes';
import type { SteamGuardRequest } from '../../shared/types';

function session(user: FakeSteamUser, guard: (r: SteamGuardRequest) => Promise<string> = async () => 'CODE1') {
  const tokens: string[] = [];
  const s = new SteamSession(() => user, { onRefreshToken: (t) => tokens.push(t), onSteamGuard: guard });
  return { s, tokens };
}

test('a password sign-in asks for Steam Guard, saves the token and reads licenses', async () => {
  const user = new FakeSteamUser({
    onLogOn: (c) =>
      c.emit('steamGuard', 'gmail.com', (code: string) => {
        assert.equal(code, 'AB12C');
        c.succeed(1000, 'tok-1');
      }, false),
    licenses: [{ package_id: 5, time_created: 1500000000, payment_method: 2, owner_id: 1000 }],
    packages: { 5: { appids: [10, 11], billingtype: 1 } },
  });
  const asked: SteamGuardRequest[] = [];
  const { s, tokens } = session(user, async (r) => {
    asked.push(r);
    return ' AB12C ';
  });
  const account = await s.signIn({ accountName: 'me', password: 'pw' });
  assert.equal(account.accountId, 1000);
  assert.equal(account.steamId64, '76561197960266728');
  assert.deepEqual(asked, [{ domain: 'gmail.com', lastCodeWrong: false }]);
  assert.deepEqual(tokens, ['tok-1']);
  const licenses = await s.licenses();
  assert.equal(licenses.length, 1);
  const pkgs = await s.packageDetails([5, 5]);
  assert.deepEqual(pkgs.get(5)?.appIds, [10, 11]);
  assert.deepEqual(user.productInfoCalls, [[5]]);
  s.close();
  assert.equal(user.loggedOff, 1);
});

test('a refresh-token sign-in sends only the token', async () => {
  const user = new FakeSteamUser({ onLogOn: (c) => c.succeed() });
  const { s } = session(user);
  await s.signIn({ refreshToken: 'saved' });
  assert.deepEqual(user.logOns, [{ refreshToken: 'saved' }]);
});

test('a wrong password is an auth error; a dropped connection is not', async () => {
  const bad = new FakeSteamUser({ onLogOn: (c) => c.emit('error', Object.assign(new Error('InvalidPassword'), { eresult: 5 })) });
  await assert.rejects(session(bad).s.signIn({ accountName: 'a', password: 'b' }), (err: unknown) => err instanceof SteamAuthError && err.eresult === 5);
  const down = new FakeSteamUser({ onLogOn: (c) => c.emit('error', Object.assign(new Error('NoConnection'), { eresult: 3 })) });
  await assert.rejects(session(down).s.signIn({ refreshToken: 't' }), (err: unknown) => !(err instanceof SteamAuthError));
});

test('cancelling the Steam Guard prompt logs off and rejects', async () => {
  const user = new FakeSteamUser({ onLogOn: (c) => c.emit('steamGuard', null, () => assert.fail('no code expected'), false) });
  const { s } = session(user, async () => {
    throw new Error('cancelled');
  });
  await assert.rejects(s.signIn({ accountName: 'a', password: 'b' }), SteamCancelledError);
  assert.equal(user.loggedOff, 1);
});
