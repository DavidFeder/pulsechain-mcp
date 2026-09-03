import { describe, expect, it, vi, afterEach } from "vitest";
import { buildExplorerUrl, explorerGet, explorerLogsWindow } from "../src/data/explorer.js";
import type { AppConfig } from "../src/types.js";
import { ExplorerError } from "../src/utils/errors.js";

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

describe("explorerGet", () => {
  afterEach(() => {
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
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status,
          json: async () => ({}),
        })),
      );
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
