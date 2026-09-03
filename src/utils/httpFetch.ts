/**
 * Shared HTTP helper for explorer + PulseX subgraph only.
 *
 * Adds AbortController timeouts (same per-attempt `httpTimeoutMs` as before)
 * and bounded HTTP 429 retries that honor Retry-After with a short sleep cap.
 *
 * Do not use for Piteas, DexScreener, Switch, PulseSwap, or multi-RPC —
 * those clients already have their own 429 / spacing behavior.
 */

export const HTTP_429_MAX_ATTEMPTS = 3;
/** Hard cap on Retry-After sleep (seconds or HTTP-date). Keep this short. */
export const HTTP_429_RETRY_AFTER_CAP_MS = 2_000;

/**
 * - `get`: retry GET/HEAD only (explorer module + BlockScout v2).
 * - `query-post`: also retry POST (PulseX GraphQL query POSTs; read-only).
 *
 * Unknown mutating POSTs must leave `retry429` unset (no retry).
 */
export type Retry429Policy = "get" | "query-post";

export interface HttpFetchOptions {
  timeoutMs: number;
  retry429?: Retry429Policy;
  maxAttempts?: number;
  retryAfterCapMs?: number;
  fetchImpl?: typeof fetch;
}

export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number = Date.now(),
  capMs: number = HTTP_429_RETRY_AFTER_CAP_MS,
): number {
  const cap = Math.max(0, capMs);
  if (header == null) return 0;
  const trimmed = header.trim();
  if (trimmed === "") return 0;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    return Math.min(seconds * 1000, cap);
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return 0;
  return Math.min(Math.max(0, dateMs - nowMs), cap);
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function requestMethod(input: FetchInput, init?: FetchInit): string {
  if (init?.method) return String(init.method).toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return "GET";
}

export function shouldRetry429(
  input: FetchInput,
  init: FetchInit,
  policy: Retry429Policy | undefined,
): boolean {
  if (!policy) return false;
  const method = requestMethod(input, init);
  if (method === "GET" || method === "HEAD") return true;
  if (policy === "query-post" && method === "POST") return true;
  return false;
}

function readRetryAfter(res: Response): string | null {
  const headers = res.headers;
  if (headers == null || typeof headers.get !== "function") return null;
  return headers.get("retry-after");
}

function sleepMs(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * fetch with per-attempt AbortController timeout and optional bounded 429 retry.
 * Returns the Response (including exhausted 429) so callers map errors as today.
 * Abort/timeout is never treated as a 429 retry.
 */
export async function httpFetch(
  input: FetchInput,
  init: FetchInit,
  options: HttpFetchOptions,
): Promise<Response> {
  const timeoutMs = options.timeoutMs;
  const capMs = options.retryAfterCapMs ?? HTTP_429_RETRY_AFTER_CAP_MS;
  const maxAttempts = Math.max(
    1,
    options.retry429
      ? (options.maxAttempts ?? HTTP_429_MAX_ATTEMPTS)
      : 1,
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  let lastResponse: Response | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // AbortError and network failures propagate after finally (no 429 retry).
    try {
      lastResponse = await fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const retry =
      lastResponse.status === 429 &&
      attempt < maxAttempts &&
      shouldRetry429(input, init, options.retry429);

    if (!retry) return lastResponse;

    const delayMs = parseRetryAfterMs(readRetryAfter(lastResponse), Date.now(), capMs);
    await sleepMs(delayMs);
  }

  return lastResponse as Response;
}
