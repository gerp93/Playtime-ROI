// IsThereAnyDeal (https://docs.isthereanydeal.com): finds each Steam game's
// ITAD id, then its Steam price history, to estimate what it cost on the
// day it was bought. Needs the user's own free ITAD API key. Nothing here
// signs in or spends anything.
import { FetchLike, HttpError, requestJson, Sleep } from './http';
import { parseHistory, PriceRecord } from '../shared/priceHistory';

export const ITAD_API_BASE = 'https://api.isthereanydeal.com';
/** ITAD's shop id for Steam. */
export const STEAM_SHOP_ID = 61;
/** How many Steam ids go in one lookup request. */
const LOOKUP_BATCH = 200;
/** Ask for the whole history: ITAD's default is only the last three months. */
const HISTORY_SINCE = '2000-01-01T00:00:00Z';

export class ItadKeyRejectedError extends Error {
  constructor() {
    super('IsThereAnyDeal refused the API key. Check it in Settings.');
    this.name = 'ItadKeyRejectedError';
  }
}

function keyCheck(err: unknown): never {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw new ItadKeyRejectedError();
  throw err;
}

export class ItadClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly apiKey: string,
    private readonly opts: { sleep?: Sleep } = {}
  ) {}

  /** Steam app id -> ITAD game id (or null when ITAD doesn't know it). */
  async lookupSteamApps(appIds: number[]): Promise<Map<number, string | null>> {
    const result = new Map<number, string | null>();
    for (let i = 0; i < appIds.length; i += LOOKUP_BATCH) {
      const batch = appIds.slice(i, i + LOOKUP_BATCH);
      const url = `${ITAD_API_BASE}/lookup/id/shop/${STEAM_SHOP_ID}/v1?${new URLSearchParams({ key: this.apiKey })}`;
      let body: unknown;
      try {
        body = await requestJson(
          this.fetchImpl,
          'IsThereAnyDeal',
          url,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch.map((id) => `app/${id}`)) },
          this.opts
        );
      } catch (err) {
        keyCheck(err);
      }
      const map = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      for (const id of batch) {
        const value = map[`app/${id}`];
        result.set(id, typeof value === 'string' && value !== '' ? value : null);
      }
    }
    return result;
  }

  /** Every Steam price change ITAD has recorded for one game, in one country. */
  async steamPriceHistory(itadId: string, country: string): Promise<PriceRecord[]> {
    const params = new URLSearchParams({
      key: this.apiKey,
      id: itadId,
      country,
      shops: String(STEAM_SHOP_ID),
      since: HISTORY_SINCE,
    });
    let body: unknown;
    try {
      body = await requestJson(this.fetchImpl, 'IsThereAnyDeal', `${ITAD_API_BASE}/games/history/v2?${params}`, {}, this.opts);
    } catch (err) {
      keyCheck(err);
    }
    return parseHistory(body, STEAM_SHOP_ID);
  }
}
