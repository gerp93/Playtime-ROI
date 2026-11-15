// The Steam Web API's owned-games list: every game in the library with its
// total playtime. Needs the user's own Web API key.
import { FetchLike, HttpError, requestJson, Sleep } from '../http';
import type { OwnedGame } from '../database/store';

export const STEAM_API_BASE = 'https://api.steampowered.com';

export class SteamKeyRejectedError extends Error {
  constructor() {
    super('Steam refused the Web API key. Check it in Settings.');
    this.name = 'SteamKeyRejectedError';
  }
}

export class PrivateLibraryError extends Error {
  constructor() {
    super(
      "Steam returned no games. If your library isn't empty, set Game details to Public in your Steam profile's privacy settings."
    );
    this.name = 'PrivateLibraryError';
  }
}

export function parseOwnedGames(body: unknown): OwnedGame[] | null {
  const response = (body as { response?: Record<string, unknown> } | null)?.response;
  if (!response || !Array.isArray(response.games)) return null;
  const out: OwnedGame[] = [];
  for (const g of response.games as Record<string, unknown>[]) {
    const appId = Number(g.appid);
    if (!Number.isInteger(appId) || appId <= 0) continue;
    const lastPlayed = Number(g.rtime_last_played);
    out.push({
      appId,
      name: typeof g.name === 'string' && g.name.trim() !== '' ? g.name : `App ${appId}`,
      playtimeMinutes: Math.max(0, Number(g.playtime_forever) || 0),
      lastPlayed: Number.isFinite(lastPlayed) && lastPlayed > 0 ? lastPlayed : null,
    });
  }
  return out;
}

export async function getOwnedGames(
  fetchImpl: FetchLike,
  apiKey: string,
  steamId64: string,
  opts: { sleep?: Sleep } = {}
): Promise<OwnedGame[]> {
  if (!/^\d{17}$/.test(steamId64)) throw new Error('That is not a SteamID64.');
  const params = new URLSearchParams({
    key: apiKey,
    steamid: steamId64,
    include_appinfo: '1',
    include_played_free_games: '1',
    format: 'json',
  });
  let body: unknown;
  try {
    body = await requestJson(fetchImpl, 'Steam', `${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/?${params}`, {}, opts);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw new SteamKeyRejectedError();
    throw err;
  }
  const games = parseOwnedGames(body);
  if (!games) throw new PrivateLibraryError();
  return games;
}
