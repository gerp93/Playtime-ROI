import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getOwnedGames, PrivateLibraryError, SteamKeyRejectedError } from './webApi';
import { fakeFetch, noSleep } from '../testing/fakes';

const STEAM_ID = '76561197960266728';

test('owned games are read with names, playtime and last played', async () => {
  const f = fakeFetch(() => ({
    body: {
      response: {
        game_count: 3,
        games: [
          { appid: 620, name: 'Portal 2', playtime_forever: 1234, rtime_last_played: 1700000000 },
          { appid: 70, playtime_forever: 0, rtime_last_played: 0 },
          { appid: 'bad' },
        ],
      },
    },
  }));
  const games = await getOwnedGames(f, 'KEY', STEAM_ID, { sleep: noSleep });
  assert.deepEqual(games, [
    { appId: 620, name: 'Portal 2', playtimeMinutes: 1234, lastPlayed: 1700000000 },
    { appId: 70, name: 'App 70', playtimeMinutes: 0, lastPlayed: null },
  ]);
  const url = new URL(f.calls[0].url);
  assert.equal(url.pathname, '/IPlayerService/GetOwnedGames/v1/');
  assert.equal(url.searchParams.get('steamid'), STEAM_ID);
  assert.equal(url.searchParams.get('include_appinfo'), '1');
  assert.equal(url.searchParams.get('include_played_free_games'), '1');
});

test('a private library and a bad key are told apart', async () => {
  await assert.rejects(getOwnedGames(fakeFetch(() => ({ body: { response: {} } })), 'K', STEAM_ID, { sleep: noSleep }), PrivateLibraryError);
  await assert.rejects(getOwnedGames(fakeFetch(() => ({ status: 401 })), 'K', STEAM_ID, { sleep: noSleep }), SteamKeyRejectedError);
  await assert.rejects(getOwnedGames(fakeFetch(() => ({ body: {} })), 'K', '123', { sleep: noSleep }), /SteamID64/);
});
