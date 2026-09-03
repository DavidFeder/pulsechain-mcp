import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildExplorerUrl,
  explorerGet,
  explorerLogsWindow,
  explorerV2Get,
  getLogsSoft,
} from "../src/data/explorer.js";
import type { AppConfig } from "../src/types.js";
import { ExplorerError, TimeoutError } from "../src/utils/errors.js";
import { HTTP_429_MAX_ATTEMPTS, HTTP_429_RETRY_AFTER_CAP_MS } from "../src/utils/httpFetch.js";

const baseConfig: AppConfig = {
  rpcUrl: "https://rpc.pulsechain.com",
  rpcUrls: ["https://rpc.pulsechain.com"],
  network: "mainnet",
  explorerApi: "https://api.scan.pulsechain.com/api",
  pulseXSubgraphV1: "https://example.com/v1",
  pulseXSubgraphV2: "https://example.com/v2",
  agentWalletEnabled: false,
  agentWalletMasterKey: undefined,
  agentWalletDir: "./data/wallets",
  agentWalletMultiprocStrict: false,
  agentWalletEnforceLegacyCaps: false,
  maxPlsPerTx: 100,
  maxPlsDaily: 1000,
  httpTransportPort: undefined,
  logLevel: "info",
  httpTimeoutMs: 5000,
};

describe("buildExplorerUrl", () => {
  it("appends module/action and skips empty params", () => {
    const url = buildExplorerUrl(baseConfig.explorerApi, {
      module: "account",
      action: "balance",
      address: "0xabc",
      contractaddress: undefined,
      page: 1,
    });
    expect(url).toContain("module=account");
    expect(url).toContain("action=balance");
    expect(url).toContain("address=0xabc");
    expect(url).toContain("page=1");
    expect(url).not.toContain("contractaddress");
  });

  it("works when base already has trailing path", () => {
    const url = buildExplorerUrl("https://api.scan.pulsechain.com/api", {
      module: "token",
      action: "getToken",
    });
    expect(url.startsWith("https://api.scan.pulsechain.com/api")).toBe(true);
    expect(url).toContain("module=token");
  });
});

function hangUntilAbort(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (!signal) return;
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

describe("explorerGet", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns result on status 1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: { symbol: "WPLS" },
        }),
      })),
    );

    const result = await explorerGet(baseConfig, {
      module: "token",
      action: "getToken",
    });
    expect(result).toEqual({ symbol: "WPLS" });
  });

  it("returns empty array for soft not-found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "0",
          message: "No transactions found",
          result: [],
        }),
      })),
    );

    const result = await explorerGet(baseConfig, {
      module: "account",
      action: "txlist",
    });
    expect(result).toEqual([]);
  });

  it("throws ExplorerError on hard failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "0",
          message: "NOTOK invalid",
          result: null,
        }),
      })),
    );

    await expect(
      explorerGet(baseConfig, { module: "account", action: "balance" }),
    ).rejects.toBeInstanceOf(ExplorerError);
  });

  it("throws on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      })),
    );

    await expect(
      explorerGet(baseConfig, { module: "stats", action: "ethsupply" }),
    ).rejects.toBeInstanceOf(ExplorerError);
  });

  it("uses config.explorerApi base URL in fetch", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url.startsWith(baseConfig.explorerApi)).toBe(true);
      expect(url).toContain("module=account");
      expect(url).toContain("action=balance");
      return {
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: "12345",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await explorerGet(baseConfig, {
      module: "account",
      action: "balance",
      address: "0x0000000000000000000000000000000000000001",
    });
    expect(result).toBe("12345");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps invalid JSON to ExplorerError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      })),
    );

    await expect(
      explorerGet(baseConfig, { module: "account", action: "balance" }),
    ).rejects.toThrow(ExplorerError);
  });

  it("maps network throw to ExplorerError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );

    await expect(
      explorerGet(baseConfig, { module: "account", action: "balance" }),
    ).rejects.toBeInstanceOf(ExplorerError);
  });

  it("throws ExplorerError with status on HTTP 400/500 (callers soft-fail)", async () => {
    for (const status of [400, 500]) {
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status,
        json: async () => ({}),
      }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        await explorerGet(baseConfig, {
          module: "contract",
          action: "getcontractcreation",
        });
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ExplorerError);
        expect((err as ExplorerError).message).toMatch(
          new RegExp(`HTTP ${status}`),
        );
        expect((err as ExplorerError).status).toBe(status);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("retries HTTP 429 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "0" }),
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          status: "1",
          message: "OK",
          result: { symbol: "WPLS" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await explorerGet(baseConfig, {
      module: "token",
      action: "getToken",
    });
    expect(result).toEqual({ symbol: "WPLS" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps Retry-After sleep on 429", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "120" }),
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: "1",
          message: "OK",
          result: "123",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const p = explorerGet(baseConfig, {
      module: "account",
      action: "balance",
    });
    await vi.advanceTimersByTimeAsync(HTTP_429_RETRY_AFTER_CAP_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe("123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exhausted 429 throws ExplorerError with status", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: new Headers(),
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await explorerGet(baseConfig, { module: "stats", action: "ethsupply" });
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExplorerError);
      expect((err as ExplorerError).status).toBe(429);
      expect((err as ExplorerError).message).toMatch(/HTTP 429/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(HTTP_429_MAX_ATTEMPTS);
  });

  it("maps abort/timeout to TimeoutError (not 429)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(hangUntilAbort));
    const p = explorerGet(
      { ...baseConfig, httpTimeoutMs: 5_000 },
      { module: "stats", action: "ethsupply" },
    );
    const settled = p.then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await settled;
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(/explorer API/);
    expect((err as Error).message).not.toMatch(/429/);
  });
});

describe("explorerV2Get 429 + timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries 429 then returns JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "0" }),
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ address: "0xabc", symbol: "WPLS" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await explorerV2Get(baseConfig, "/tokens/0xabc");
    expect(result).toEqual({ address: "0xabc", symbol: "WPLS" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("exhausted 429 throws ExplorerError with status", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await explorerV2Get(baseConfig, "/tokens/0xabc");
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExplorerError);
      expect((err as ExplorerError).status).toBe(429);
    }
    expect(fetchMock).toHaveBeenCalledTimes(HTTP_429_MAX_ATTEMPTS);
  });

  it("maps abort/timeout to TimeoutError for explorer API v2", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(hangUntilAbort));
    const p = explorerV2Get(
      { ...baseConfig, httpTimeoutMs: 5_000 },
      "/tokens/0xabc",
    );
    const settled = p.then(
      () => "resolved",
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await settled;
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as Error).message).toMatch(/explorer API v2/);
  });
});

describe("getLogsSoft exhausted 429", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("soft-fails with the ExplorerError 429 status in reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({}),
      })),
    );
    const result = await getLogsSoft(baseConfig, {
      address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/429/);
    }
  });
});

describe("getContractCreation / getTokenInfo surface ExplorerError for soft-fail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getContractCreation propagates HTTP 400 as ExplorerError (not bare throw)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({}),
      })),
    );
    const { getContractCreation } = await import("../src/data/explorer.js");
    await expect(
      getContractCreation(
        baseConfig,
        "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
      ),
    ).rejects.toBeInstanceOf(ExplorerError);
  });

  it("getTokenInfo propagates HTTP 500 as ExplorerError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })),
    );
    const { getTokenInfo } = await import("../src/data/explorer.js");
    await expect(
      getTokenInfo(baseConfig, "0xA1077a294dDE1B09bB078844df40758a5D0f9a27"),
    ).rejects.toBeInstanceOf(ExplorerError);
  });
});

describe("explorerLogsWindow", () => {
  it("marks truncated when length hits offset", () => {
    const logs = [{ id: 1 }, { id: 2 }];
    expect(explorerLogsWindow(logs, { offset: 2, fromBlock: 0, toBlock: "latest", page: 1 })).toEqual({
      truncated: true,
      window: { fromBlock: 0, toBlock: "latest", offset: 2, page: 1 },
    });
  });

  it("is not truncated when under offset or non-array", () => {
    expect(explorerLogsWindow([{ id: 1 }], { offset: 10 }).truncated).toBe(false);
    expect(explorerLogsWindow({ result: [{ id: 1 }] }, { offset: 1 }).truncated).toBe(false);
  });
});
