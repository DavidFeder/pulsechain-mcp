import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HTTP_429_MAX_ATTEMPTS,
  HTTP_429_RETRY_AFTER_CAP_MS,
  httpFetch,
  parseRetryAfterMs,
  shouldRetry429,
} from "../src/utils/httpFetch.js";

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function hangUntilAbort(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(abortError());
    if (!signal) return;
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function mockRes(
  status: number,
  extra: { retryAfter?: string; body?: unknown } = {},
): Response {
  const headers = extra.retryAfter
    ? new Headers({ "retry-after": extra.retryAfter })
    : new Headers();
  const body = extra.body ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds and caps them", () => {
    expect(parseRetryAfterMs("0", 0, 2_000)).toBe(0);
    expect(parseRetryAfterMs("1", 0, 2_000)).toBe(1_000);
    expect(parseRetryAfterMs("2", 0, 2_000)).toBe(2_000);
    expect(parseRetryAfterMs("120", 0, 2_000)).toBe(2_000);
    expect(parseRetryAfterMs(" 3 ", 0, HTTP_429_RETRY_AFTER_CAP_MS)).toBe(
      HTTP_429_RETRY_AFTER_CAP_MS,
    );
  });

  it("parses HTTP-date and caps the delta", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    const soon = "Wed, 21 Oct 2015 07:28:01 GMT";
    const later = "Wed, 21 Oct 2015 07:30:00 GMT";
    expect(parseRetryAfterMs(soon, now, 2_000)).toBe(1_000);
    expect(parseRetryAfterMs(later, now, 2_000)).toBe(2_000);
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:27:00 GMT", now, 2_000)).toBe(
      0,
    );
  });

  it("returns 0 for missing or invalid values", () => {
    expect(parseRetryAfterMs(null)).toBe(0);
    expect(parseRetryAfterMs("")).toBe(0);
    expect(parseRetryAfterMs("not-a-date")).toBe(0);
    expect(parseRetryAfterMs("1.5")).toBe(0);
  });
});

describe("shouldRetry429", () => {
  it("retries GET/HEAD for get policy and POST only for query-post", () => {
    expect(shouldRetry429("https://x", { method: "GET" }, "get")).toBe(true);
    expect(shouldRetry429("https://x", { method: "HEAD" }, "get")).toBe(true);
    expect(shouldRetry429("https://x", { method: "POST" }, "get")).toBe(false);
    expect(shouldRetry429("https://x", { method: "POST" }, "query-post")).toBe(
      true,
    );
    expect(shouldRetry429("https://x", { method: "PUT" }, "query-post")).toBe(
      false,
    );
    expect(shouldRetry429("https://x", { method: "POST" }, undefined)).toBe(
      false,
    );
  });
});

describe("httpFetch 429 retry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries 429 then 200 and succeeds", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockRes(429, { retryAfter: "0" }))
      .mockResolvedValueOnce(mockRes(200, { body: { ok: true } }));

    const res = await httpFetch("https://example.test/api", { method: "GET" }, {
      timeoutMs: 5_000,
      retry429: "get",
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries GraphQL query POSTs under query-post policy", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockRes(429, { retryAfter: "0" }))
      .mockResolvedValueOnce(mockRes(200));

    const res = await httpFetch(
      "https://graph.example.test",
      { method: "POST", body: JSON.stringify({ query: "{ _meta { block { number } } }" }) },
      { timeoutMs: 5_000, retry429: "query-post", fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry unknown mutating POSTs (get policy)", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mockRes(429));
    const res = await httpFetch(
      "https://example.test",
      { method: "POST", body: "{}" },
      { timeoutMs: 5_000, retry429: "get", fetchImpl },
    );
    expect(res.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry 400 or 500", async () => {
    for (const status of [400, 500, 503]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mockRes(status));
      const res = await httpFetch("https://example.test", { method: "GET" }, {
        timeoutMs: 5_000,
        retry429: "get",
        fetchImpl,
      });
      expect(res.status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("honors Retry-After seconds but caps sleep", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockRes(429, { retryAfter: "120" }))
      .mockResolvedValueOnce(mockRes(200));

    const p = httpFetch("https://example.test", { method: "GET" }, {
      timeoutMs: 30_000,
      retry429: "get",
      retryAfterCapMs: HTTP_429_RETRY_AFTER_CAP_MS,
      fetchImpl,
    });

    await vi.advanceTimersByTimeAsync(HTTP_429_RETRY_AFTER_CAP_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const res = await p;
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("caps HTTP-date Retry-After", async () => {
    vi.useFakeTimers({ now: Date.parse("Wed, 21 Oct 2015 07:28:00 GMT") });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        mockRes(429, { retryAfter: "Wed, 21 Oct 2015 07:35:00 GMT" }),
      )
      .mockResolvedValueOnce(mockRes(200));

    const p = httpFetch("https://example.test", { method: "GET" }, {
      timeoutMs: 30_000,
      retry429: "get",
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(HTTP_429_RETRY_AFTER_CAP_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the 429 response after retries are exhausted", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(mockRes(429));
    const res = await httpFetch("https://example.test", { method: "GET" }, {
      timeoutMs: 5_000,
      retry429: "get",
      fetchImpl,
    });
    expect(res.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(HTTP_429_MAX_ATTEMPTS);
  });

  it("does not retry AbortError / timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(hangUntilAbort);
    const p = httpFetch("https://example.test", { method: "GET" }, {
      timeoutMs: 5_000,
      retry429: "get",
      fetchImpl,
    });
    const settled = p.then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not treat a later abort as a 429", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockRes(429, { retryAfter: "0" }))
      .mockImplementationOnce(hangUntilAbort);

    const p = httpFetch("https://example.test", { method: "GET" }, {
      timeoutMs: 1_000,
      retry429: "get",
      fetchImpl,
    });
    const settled = p.then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await settled;
    expect((err as Error).name).toBe("AbortError");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
