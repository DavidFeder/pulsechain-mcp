/**
 * Subgraph client URL selection + error mapping (mocked fetch, no live network).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/types.js";
import {
  AppError,
  SubgraphError,
  TimeoutError,
  mapUnknownError,
} from "../src/utils/errors.js";

const baseConfig: AppConfig = {
  rpcUrl: "https://rpc.pulsechain.com",
  rpcUrls: ["https://rpc.pulsechain.com"],
  network: "mainnet",
  explorerApi: "https://api.scan.pulsechain.com/api",
  pulseXSubgraphV1: "https://graph.example.test/v1",
  pulseXSubgraphV2: "https://graph.example.test/v2",
  agentWalletEnabled: false,
  agentWalletMasterKey: undefined,
  agentWalletDir: "./data/wallets",
  agentWalletMultiprocStrict: false,
  maxPlsPerTx: 100,
  maxPlsDaily: 1000,
  httpTransportPort: undefined,
  logLevel: "error",
  httpTimeoutMs: 5_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rankSubgraphPairsBySaneLiquidity (pair discovery ranking)", () => {
  it("prefers sane major-pool liquidity over absurd raw reserveUSD", async () => {
    const { rankSubgraphPairsBySaneLiquidity } = await import(
      "../src/data/subgraph.js"
    );
    const pairs = [
      {
        id: "0xpolluted",
        token0: {
          id: "0x1111111111111111111111111111111111111111",
          symbol: "SCAM",
          name: "Scam",
          decimals: "18",
          derivedUSD: "0",
        },
        token1: {
          id: "0xa1077a294dde1b09bb078844df40758a5d0f9a27",
          symbol: "WPLS",
          name: "WPLS",
          decimals: "18",
          derivedUSD: "0.00003",
        },
        reserve0: "1",
        reserve1: "1",
        reserveUSD: "9.9e30",
        volumeUSD: "1",
        totalTransactions: "1",
        token0Price: "1",
        token1Price: "1",
      },
      {
        id: "0xreal",
        token0: {
          id: "0x95b303987a60c71504d99aa1b13b4da07b0790ab",
          symbol: "PLSX",
          name: "PulseX",
          decimals: "18",
          derivedUSD: "0.00001",
        },
        token1: {
          id: "0xa1077a294dde1b09bb078844df40758a5d0f9a27",
          symbol: "WPLS",
          name: "WPLS",
          decimals: "18",
          derivedUSD: "0.00003",
        },
        reserve0: "1000000",
        reserve1: "1000000",
        reserveUSD: "5000000",
        volumeUSD: "100000",
        totalTransactions: "1000",
        token0Price: "1",
        token1Price: "1",
      },
    ];
    const ranked = rankSubgraphPairsBySaneLiquidity(pairs as never, 8);
    expect(ranked[0]!.id).toBe("0xreal");
    expect(ranked.map((p) => p.id)).toEqual(["0xreal", "0xpolluted"]);
    // Same comparator as fetchPairsForToken post-merge sort
    const rawOrder = [...pairs].sort(
      (a, b) => parseFloat(b.reserveUSD) - parseFloat(a.reserveUSD),
    );
    expect(rawOrder[0]!.id).toBe("0xpolluted"); // raw would wrongly put pollution first
  });
});

describe("getPulseXClient URL selection", () => {
  it("uses v1 and v2 subgraph URLs from config", async () => {
    const { getPulseXClient } = await import("../src/data/subgraph.js");
    const v1 = getPulseXClient(baseConfig, "v1");
    const v2 = getPulseXClient(baseConfig, "v2");
    // GraphQLClient exposes url on the instance
    expect((v1 as { url: string }).url).toBe(baseConfig.pulseXSubgraphV1);
    expect((v2 as { url: string }).url).toBe(baseConfig.pulseXSubgraphV2);
  });

  it("defaults to v2 URL", async () => {
    const { getPulseXClient } = await import("../src/data/subgraph.js");
    const client = getPulseXClient(baseConfig);
    expect((client as { url: string }).url).toBe(baseConfig.pulseXSubgraphV2);
  });

  it("throws SubgraphError when version URL missing", async () => {
    const { getPulseXClient } = await import("../src/data/subgraph.js");
    const empty: AppConfig = {
      ...baseConfig,
      pulseXSubgraphV1: "",
      pulseXSubgraphV2: "",
    };
    expect(() => getPulseXClient(empty, "v2")).toThrow(SubgraphError);
    expect(() => getPulseXClient(empty, "v1")).toThrow(/not configured|PULSEX/i);
  });
});

describe("subgraph requestSafe error mapping (mocked fetch)", () => {
  it("maps HTTP/network failures through mapUnknownError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      }),
    );

    const { fetchBundle } = await import("../src/data/subgraph.js");
    await expect(fetchBundle(baseConfig, "v2")).rejects.toMatchObject({
      code: expect.stringMatching(/NETWORK_ERROR|APP_ERROR|SUBGRAPH/),
    });
  });

  it("surfaces GraphQL error bodies as Subgraph/App errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          errors: [{ message: "subgraph indexing error" }],
        }),
        text: async () =>
          JSON.stringify({ errors: [{ message: "subgraph indexing error" }] }),
      })),
    );

    const { fetchToken } = await import("../src/data/subgraph.js");
    await expect(
      fetchToken(
        baseConfig,
        "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab",
        "v2",
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("returns parsed data when GraphQL succeeds", async () => {
    const payload = {
      data: {
        bundle: { id: "1", plsPrice: "0.00005" },
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(baseConfig.pulseXSubgraphV2);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchBundle } = await import("../src/data/subgraph.js");
    const res = await fetchBundle(baseConfig, "v2");
    expect(res.bundle?.plsPrice).toBe("0.00005");
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("mapUnknownError", () => {
  it("maps abort/timeout to TimeoutError", () => {
    const err = mapUnknownError(new Error("The operation was aborted"), "x");
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.code).toBe("TIMEOUT");
  });

  it("maps network failures", () => {
    const err = mapUnknownError(new Error("fetch failed"), "PulseX subgraph");
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.message).toMatch(/PulseX subgraph/);
  });

  it("maps graphql keywords to SubgraphError", () => {
    const err = mapUnknownError(new Error("GraphQL Error: bad query"), "sg");
    expect(err).toBeInstanceOf(SubgraphError);
  });

  it("passes through existing AppError", () => {
    const original = new SubgraphError("already mapped");
    expect(mapUnknownError(original, "ctx")).toBe(original);
  });

  it("wraps unknown errors as AppError", () => {
    const err = mapUnknownError("boom", "ctx");
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toMatch(/ctx/);
  });
});

describe("SWAPS_QUERY shape + token-filtered fetchSwapsAdvanced", () => {
  it("SWAPS_QUERY selects pair.token0/1.id (not symbol-only)", async () => {
    const { SWAPS_QUERY, SWAPS_GLOBAL_QUERY, SWAPS_BY_PAIRS_QUERY } =
      await import("../src/data/subgraph.js");
    const q = String(SWAPS_QUERY);
    const g = String(SWAPS_GLOBAL_QUERY);
    const batch = String(SWAPS_BY_PAIRS_QUERY);
    // Must request token ids so swapInvolvesToken can match without pairIds alone
    expect(q).toMatch(/token0\s*\{\s*id\s+symbol/);
    expect(q).toMatch(/token1\s*\{\s*id\s+symbol/);
    expect(g).toMatch(/token0\s*\{\s*id\s+symbol/);
    expect(g).toMatch(/token1\s*\{\s*id\s+symbol/);
    // Token-filtered path uses pair_in batch to avoid multi-query timeouts
    expect(batch).toMatch(/pair_in/);
    expect(batch).toMatch(/token0\s*\{\s*id\s+symbol/);
  });

  it("token filter keeps swaps when GraphQL returns symbol-only tokens (pair verified)", async () => {
    const plsx = "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab";
    const wpls = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
    const pairId = "0xcccccccccccccccccccccccccccccccccccccccc";

    vi.resetModules();
    vi.doMock("../src/data/subgraph.js", async () => {
      // We'll import actual and only spy after — better: mock request path via fetch
      return vi.importActual("../src/data/subgraph.js");
    });
    vi.doUnmock("../src/data/subgraph.js");

    // Drive shipped helpers with real response shape (no token ids)
    const {
      filterSwapsByToken,
      swapInvolvesToken,
      SWAPS_QUERY,
    } = await import("../src/data/subgraph.js");

    // Structural: shipped query must include ids so live path can match by token
    expect(String(SWAPS_QUERY)).toContain("id");

    // Live-historical shape: pair.id present, token0/1 only symbol
    const liveShape = [
      {
        id: "swap-a",
        timestamp: "1700000000",
        pair: {
          id: pairId,
          token0: { symbol: "PLSX" },
          token1: { symbol: "WPLS" },
        },
        amountUSD: "12.5",
      },
      {
        id: "swap-b",
        timestamp: "1700000001",
        pair: {
          id: "0xdddddddddddddddddddddddddddddddddddddddd",
          token0: { symbol: "SCAM" },
          token1: { symbol: "WPLS" },
        },
        amountUSD: "9",
      },
    ];

    // Id-only matching (bug): empties list
    expect(filterSwapsByToken(liveShape, plsx)).toEqual([]);

    // Shipped token path passes verified pairIds → keeps matching pair
    const allowed = [pairId];
    const kept = filterSwapsByToken(liveShape, plsx, allowed);
    expect(kept.map((s) => s.id)).toEqual(["swap-a"]);
    expect(swapInvolvesToken(liveShape[0]!, plsx, allowed)).toBe(true);
    expect(swapInvolvesToken(liveShape[1]!, plsx, allowed)).toBe(false);

    // With token ids present, still matches without pairIds
    const withIds = [
      {
        id: "swap-c",
        timestamp: "1",
        pair: {
          id: pairId,
          token0: { id: plsx.toLowerCase(), symbol: "PLSX" },
          token1: { id: wpls.toLowerCase(), symbol: "WPLS" },
        },
      },
    ];
    expect(filterSwapsByToken(withIds, plsx).map((s) => s.id)).toEqual([
      "swap-c",
    ]);
  });
});
