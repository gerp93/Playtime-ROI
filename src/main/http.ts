// A small fetch wrapper shared by the API clients. Error messages never
// contain the request URL, because the API keys travel in it.
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class HttpError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    message?: string
  ) {
    super(message ?? `${service} answered HTTP ${status}.`);
    this.name = 'HttpError';
  }
}

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a request, waiting and trying again (up to `retries` times) when the
 * service says it is busy (429) or fails on its side (5xx).
 */
export async function requestJson(
  fetchImpl: FetchLike,
  service: string,
  url: string,
  init: Parameters<FetchLike>[1] = {},
  opts: { retries?: number; sleep?: Sleep; timeoutMs?: number } = {}
): Promise<unknown> {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    let response;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000) : null;
    try {
      response = await fetchImpl(url, { ...init, signal: controller?.signal });
    } catch {
      if (timer) clearTimeout(timer);
      if (attempt < retries) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`${service} could not be reached.`);
    }
    if (timer) clearTimeout(timer);
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new Error(`${service} sent an answer that could not be read.`);
      }
    }
    const busy = response.status === 429 || response.status >= 500;
    if (busy && attempt < retries) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 120) * 1000 : 2000 * 2 ** attempt;
      await sleep(wait);
      continue;
    }
    throw new HttpError(service, response.status);
  }
}
