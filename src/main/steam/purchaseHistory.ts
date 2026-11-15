// Reads the account's purchase history from store.steampowered.com with the
// signed-in web session: the first page, then "Load More Transactions" until
// the end, or until a page holds a transaction that is already saved (new
// rows are always on top, so everything below it is known). Read-only: it only
// ever reads two pages of the user's own account. The cookies are used for the
// requests and nowhere else; errors never say what they were.
import { HttpError, requestJson, requestText, realSleep } from '../http';
import type { FetchLike, Sleep } from '../http';
import type { WebSession } from './steamClient';
import { cursorFrom, parseHistoryPage, parseHistoryRows } from '../../shared/purchaseHistory';
import type { HistoryRow } from '../../shared/purchaseHistory';

const STORE = 'https://store.steampowered.com';
const SERVICE = 'The Steam store';
/** A guard against a cursor that never ends; 50 rows a page is far more than any account needs. */
const MAX_PAGES = 200;
const PAUSE_BETWEEN_PAGES_MS = 600;

/** Steam answered with something other than the history: the web sign-in did not take. */
export class HistoryUnavailableError extends Error {
  constructor() {
    super('Steam did not show the purchase history.');
    this.name = 'HistoryUnavailableError';
  }
}

function headers(web: WebSession, extra: Record<string, string> = {}): Record<string, string> {
  const pairs = web.cookies.map((c) => c.split(';')[0].trim()).filter((c) => /^[\w-]+=/.test(c));
  if (!pairs.some((c) => c.startsWith('sessionid='))) pairs.push(`sessionid=${web.sessionId}`);
  if (!pairs.some((c) => c.startsWith('Steam_Language='))) pairs.push('Steam_Language=english');
  return { Cookie: pairs.join('; '), 'Accept-Language': 'en-US,en;q=0.9', ...extra };
}

/**
 * The history rows, newest first. Stops after the page that contains a
 * transaction in `known`, since everything below it was read before.
 */
export async function fetchPurchaseHistory(
  fetchImpl: FetchLike,
  web: WebSession,
  known: ReadonlySet<string>,
  opts: { sleep?: Sleep } = {}
): Promise<HistoryRow[]> {
  const sleep = opts.sleep ?? realSleep;
  let html: string;
  try {
    html = await requestText(fetchImpl, SERVICE, `${STORE}/account/history/?l=english`, { headers: headers(web) }, { sleep });
  } catch (err) {
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw new HistoryUnavailableError();
    throw err;
  }
  const first = parseHistoryPage(html);
  if (!first.hasTable) throw new HistoryUnavailableError();

  const rows = [...first.rows];
  let cursor = first.cursor;
  let caughtUp = first.rows.some((r) => known.has(r.transId));
  for (let page = 1; cursor && !caughtUp && page < MAX_PAGES; page++) {
    await sleep(PAUSE_BETWEEN_PAGES_MS);
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(cursor)) form.set(`cursor[${k}]`, v);
    form.set('sessionid', web.sessionId);
    const answer = (await requestJson(
      fetchImpl,
      SERVICE,
      `${STORE}/account/AjaxLoadMoreHistory/?l=english`,
      {
        method: 'POST',
        headers: headers(web, {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: STORE,
          Referer: `${STORE}/account/history/`,
        }),
        body: form.toString(),
      },
      { sleep }
    )) as { html?: unknown; cursor?: unknown } | null;
    const more = typeof answer?.html === 'string' ? parseHistoryRows(answer.html) : [];
    rows.push(...more);
    caughtUp = more.some((r) => known.has(r.transId));
    cursor = more.length === 0 ? null : cursorFrom(answer?.cursor);
  }
  return rows;
}
