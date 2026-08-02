import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import type { AppConfig } from "../src/types.js";
import { TOKEN_QUERY, TOP_TOKENS_QUERY, BUNDLE_QUERY } from "../src/data/subgraph.js";
import { buildExplorerUrl } from "../src/data/explorer.js";

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

describe("subgraph query shapes (PulseX schema)", () => {
  it("TOKEN_QUERY uses derivedUSD / totalTransactions (not derivedETH/txCount)", () => {
    expect(TOKEN_QUERY).toContain("derivedUSD");
    expect(TOKEN_QUERY).toContain("derivedPLS");
    expect(TOKEN_QUERY).toContain("totalTransactions");
    expect(TOKEN_QUERY).not.toContain("derivedETH");
    expect(TOKEN_QUERY).not.toMatch(/\btxCount\b/);
  });

  it("TOP_TOKENS and BUNDLE match PulseX field names", () => {
    expect(TOP_TOKENS_QUERY).toContain("derivedUSD");
    expect(BUNDLE_QUERY).toContain("plsPrice");
  });
});

describe("get_token_price handler (mocked subgraph)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns price envelope from mocked GraphQL", async () => {
    const tokenId = "0x95b303987a60c71504d99aa1b13b4da07b0790ab";

    const payload = {
      data: {
        token: {
          id: tokenId,
          symbol: "PLSX",
          name: "PulseX",
          decimals: "18",
          totalSupply: "1000000000000000000000",
          tradeVolume: "0",
          tradeVolumeUSD: "1000",
          untrackedVolumeUSD: "0",
          totalTransactions: "10",
          totalLiquidity: "5000",
          derivedPLS: "0.8",
          derivedUSD: "0.00001",
        },
        tokenDayDatas: [
          {
            id: "1",
            date: 1_700_000_000,
            priceUSD: "0.00001",
            totalLiquidityToken: "5000",
            totalLiquidityUSD: "50",
            totalLiquidityPLS: "10000",
            dailyVolumeToken: "100",
            dailyVolumePLS: "80",
            dailyVolumeUSD: "1",
            dailyTxns: "5",
          },
          {
            id: "2",
            date: 1_699_913_600,
            priceUSD: "0.000009",
            totalLiquidityToken: "5000",
            totalLiquidityUSD: "45",
            totalLiquidityPLS: "10000",
            dailyVolumeToken: "90",
            dailyVolumePLS: "70",
            dailyVolumeUSD: "0.9",
            dailyTxns: "4",
          },
        ],
        bundle: { id: "1", plsPrice: "0.0000125" },
      },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("example.com")) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => payload,
            text: async () => JSON.stringify(payload),
          };
        }
        return {
          ok: false,
          status: 404,
          headers: new Headers(),
          json: async () => ({}),
          text: async () => "",
        };
      }),
    );

    const { fetchToken, fetchTokenDayData, fetchBundle } = await import(
      "../src/data/subgraph.js"
    );

    // graphql-request uses fetch with the document; our mock returns full data blob
    // so each request gets the same fixture — enough for unit integration of parsers.
    const token = await fetchToken(baseConfig, tokenId, "v2");
    expect(token.token?.symbol).toBe("PLSX");
    expect(token.token?.derivedUSD).toBe("0.00001");

    const days = await fetchTokenDayData(baseConfig, tokenId, 3, "v2");
    expect(days.tokenDayDatas.length).toBeGreaterThan(0);

    const bundle = await fetchBundle(baseConfig, "v2");
    expect(bundle.bundle?.plsPrice).toBe("0.0000125");
  });
});

describe("get_token_safety helpers with mocked explorer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("buildExplorerUrl includes contract getsourcecode params", () => {
    const url = buildExplorerUrl(baseConfig.explorerApi, {
      module: "contract",
      action: "getsourcecode",
      address: "0x95b303987a60c71504d99aa1b13b4da07b0790ab",
    });
    expect(url).toContain("module=contract");
    expect(url).toContain("action=getsourcecode");
  });

  it("getContractSourceCode returns array on status 1", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [
            {
              SourceCode: "contract Foo {}",
              ABI: '[{"name":"owner"}]',
              ContractName: "Foo",
            },
          ],
        }),
      })),
    );

    const { getContractSourceCode } = await import("../src/data/explorer.js");
    const src = await getContractSourceCode(
      baseConfig,
      "0x95b303987a60c71504d99aa1b13b4da07b0790ab",
    );
    expect(src[0]?.ContractName).toBe("Foo");
    expect(src[0]?.SourceCode).toContain("Foo");
  });

  it("getTokenHolders uses BlockScout v2 path", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("/api/v2/tokens/");
      expect(url).toContain("/holders");
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              address: {
                hash: "0x1111111111111111111111111111111111111111",
                is_contract: false,
              },
              value: "1000000000000000000",
              token: {
                total_supply: "10000000000000000000",
                decimals: "18",
              },
            },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getTokenHolders } = await import("../src/data/explorer.js");
    const res = await getTokenHolders(
      baseConfig,
      "0x95b303987a60c71504d99aa1b13b4da07b0790ab",
      { limit: 10 },
    );
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.value).toBe("1000000000000000000");
  });
});

describe("registerAnalyticsTools exports free-tier names", () => {
  it("registers get_* free tools on a mock server", async () => {
    const registered: string[] = [];
    const server = {
      registerTool: (
        name: string,
        _config?: unknown,
        _cb?: unknown,
      ) => {
        registered.push(name);
      },
    };

    const { registerAnalyticsTools } = await import(
      "../src/tools/analytics/index.js"
    );
    const { resetToolRegistry, getRegisteredTools } = await import(
      "../src/tools/define.js"
    );
    resetToolRegistry();
    registerAnalyticsTools(server as never, baseConfig);

    const free = [
      "get_token_price",
      "get_token_info",
      "get_token_history",
      "get_top_tokens",
      "get_top_pairs",
      "get_market_overview",
      "get_token_safety",
      "get_token_liquidity",
      "get_honeypots",
      "get_bridge_stats",
      "get_holder_leagues",
    ];
    for (const name of free) {
      expect(registered).toContain(name);
    }
    const meta = getRegisteredTools();
    expect(meta.filter((t) => t.category === "analytics").length).toBeGreaterThanOrEqual(
      free.length,
    );
  }, 10_000);
});

type McpHandler = (args?: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureToolHandlers(): {
  handlers: Map<string, McpHandler>;
  server: { registerTool: (...args: unknown[]) => void };
} {
  const handlers = new Map<string, McpHandler>();
  return {
    handlers,
    server: {
      registerTool: (name: unknown, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1];
        if (typeof name === "string" && typeof cb === "function") {
          handlers.set(name, cb as McpHandler);
        }
      },
    },
  };
}

function parseToolJson(res: {
  content: Array<{ type: string; text: string }>;
}): { ok: boolean; data?: Record<string, unknown>; error?: string } {
  return JSON.parse(res.content[0]!.text) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: string;
  };
}

function bodyOkFalse(res: {
  content: Array<{ type: string; text: string }>;
}): boolean {
  try {
    const body = parseToolJson(res);
    return body.ok === false;
  } catch {
    return true;
  }
}

describe("analytics tools parse mocked GraphQL", () => {
  const tokenId = "0x95b303987a60c71504d99aa1b13b4da07b0790ab";

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function stubGraphQl(payloadForBody: (body: string) => unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        // Explorer / non-subgraph → soft fail so tools can still use subgraph
        if (!url.includes("example.com")) {
          return {
            ok: false,
            status: 404,
            headers: new Headers(),
            json: async () => ({}),
            text: async () => "",
          };
        }
        const body =
          typeof init?.body === "string"
            ? init.body
            : init?.body
              ? String(init.body)
              : "";
        const payload = payloadForBody(body);
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        };
      }),
    );
  }

  it("get_token_price returns price envelope from mocked GraphQL", async () => {
    stubGraphQl(() => ({
      data: {
        token: {
          id: tokenId,
          symbol: "PLSX",
          name: "PulseX",
          decimals: "18",
          totalSupply: "1000000000000000000000",
          tradeVolume: "0",
          tradeVolumeUSD: "1000",
          untrackedVolumeUSD: "0",
          totalTransactions: "10",
          totalLiquidity: "5000",
          derivedPLS: "0.8",
          derivedUSD: "0.00001",
        },
        tokenDayDatas: [
          {
            id: "1",
            date: 1_700_000_000,
            priceUSD: "0.00001",
            totalLiquidityToken: "5000",
            totalLiquidityUSD: "50",
            totalLiquidityPLS: "10000",
            dailyVolumeToken: "100",
            dailyVolumePLS: "80",
            dailyVolumeUSD: "1",
            dailyTxns: "5",
          },
          {
            id: "2",
            date: 1_699_913_600,
            priceUSD: "0.000009",
            totalLiquidityToken: "5000",
            totalLiquidityUSD: "45",
            totalLiquidityPLS: "10000",
            dailyVolumeToken: "90",
            dailyVolumePLS: "70",
            dailyVolumeUSD: "0.9",
            dailyTxns: "4",
          },
        ],
        bundle: { id: "1", plsPrice: "0.0000125" },
      },
    }));

    const { handlers, server } = captureToolHandlers();
    const { registerFreeTierAnalyticsTools } = await import(
      "../src/tools/analytics/freeTier.js"
    );
    const { resetToolRegistry } = await import("../src/tools/define.js");
    resetToolRegistry();
    registerFreeTierAnalyticsTools(server as never, baseConfig);

    const res = await handlers.get("get_token_price")!({
      address: "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab",
      version: "v2",
    });
    expect(res.isError).toBeFalsy();
    const body = parseToolJson(res);
    expect(body.ok).toBe(true);
    expect(body.data?.symbol).toBe("PLSX");
    expect(body.data?.price_usd).toBe(0.00001);
    expect(body.data?.price_pls).toBe(0.8);
    expect(body.data?.pls_usd).toBe(0.0000125);
    expect(body.data?.price_change_24h).toBeCloseTo(
      ((0.00001 - 0.000009) / 0.000009) * 100,
      5,
    );
    expect(body.data?.subgraph).toBe("v2");
  });

  it("get_token_info parses token + pairs GraphQL", async () => {
    const pair = {
      id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      token0: {
        id: tokenId,
        symbol: "PLSX",
        name: "PulseX",
        decimals: "18",
        derivedUSD: "0.00001",
      },
      token1: {
        id: "0xa1077a294dde1b09bb078844df40758a5d0f9a27",
        symbol: "WPLS",
        name: "Wrapped PLS",
        decimals: "18",
        derivedUSD: "0.0000125",
      },
      reserve0: "1000",
      reserve1: "2000",
      reserveUSD: "100",
      volumeUSD: "50",
      totalTransactions: "9",
      token0Price: "1",
      token1Price: "2",
    };

    stubGraphQl((body) => {
      if (body.includes("TopTokens") || body.includes("tokens(")) {
        return { data: { tokens: [] } };
      }
      if (body.includes("pairs(") || body.includes("PairsToken")) {
        return { data: { pairs: [pair] } };
      }
      return {
        data: {
          token: {
            id: tokenId,
            symbol: "PLSX",
            name: "PulseX",
            decimals: "18",
            totalSupply: "1000000000000000000000",
            tradeVolume: "0",
            tradeVolumeUSD: "999",
            untrackedVolumeUSD: "0",
            totalTransactions: "42",
            totalLiquidity: "5000",
            derivedPLS: "0.8",
            derivedUSD: "0.00001",
          },
        },
      };
    });

    const { handlers, server } = captureToolHandlers();
    const { registerFreeTierAnalyticsTools } = await import(
      "../src/tools/analytics/freeTier.js"
    );
    const { resetToolRegistry } = await import("../src/tools/define.js");
    resetToolRegistry();
    registerFreeTierAnalyticsTools(server as never, baseConfig);

    const res = await handlers.get("get_token_info")!({
      address: "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab",
      version: "v2",
    });
    const body = parseToolJson(res);
    expect(body.ok).toBe(true);
    expect(body.data?.symbol).toBe("PLSX");
    expect(body.data?.name).toBe("PulseX");
    expect(body.data?.decimals).toBe(18);
    expect(body.data?.trade_volume_usd).toBe(999);
    expect(Array.isArray(body.data?.pairs)).toBe(true);
    expect((body.data?.pairs as unknown[]).length).toBeGreaterThan(0);
    expect(body.data?.links).toBeTruthy();
    // Nested pair sides: catalogued WPLS gets display_symbol/origin; never invent unknowns
    const nested = (body.data?.pairs as Array<Record<string, unknown>>)[0];
    expect(nested.token1_display_symbol).toMatch(/WPLS/i);
    expect(nested.token1_origin).toBeTruthy();
  });

  it("get_token_info soft-fails when subgraph token GraphQL errors but catalog knows address", async () => {
    const eusdc = "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07";
    stubGraphQl(() => {
      // Force token + pairs queries to fail so only catalog identity remains
      throw new Error("database unavailable");
    });

    const { handlers, server } = captureToolHandlers();
    const { registerFreeTierAnalyticsTools } = await import(
      "../src/tools/analytics/freeTier.js"
    );
    const { resetToolRegistry } = await import("../src/tools/define.js");
    resetToolRegistry();
    registerFreeTierAnalyticsTools(server as never, baseConfig);

    const res = await handlers.get("get_token_info")!({
      address: eusdc,
      version: "v2",
    });
    const body = parseToolJson(res);
    expect(body.ok).toBe(true);
    expect(body.data?.display_symbol).toBe("eUSDC");
    expect(body.data?.token_origin).toBe("bridged");
    expect(body.data?.partial).toBe(true);
    expect(body.data?.token_origin).toBeTruthy();
    // Must not invent origin keys beyond catalog for this known address
    expect(body.data?.display_symbol).not.toBe("USDC"); // display prefers eUSDC
  });

  it("get_token_info still hard-fails for unknown address when all sources fail", async () => {
    const unknown = "0x1111111111111111111111111111111111111111";
    stubGraphQl(() => {
      throw new Error("database unavailable");
    });

    const { handlers, server } = captureToolHandlers();
    const { registerFreeTierAnalyticsTools } = await import(
      "../src/tools/analytics/freeTier.js"
    );
    const { resetToolRegistry } = await import("../src/tools/define.js");
    resetToolRegistry();
    registerFreeTierAnalyticsTools(server as never, baseConfig);

    const res = await handlers.get("get_token_info")!({
      address: unknown,
      version: "v2",
    });
    // Tool surface may set isError; body.ok false is the shipped error envelope
    expect(res.isError === true || bodyOkFalse(res)).toBe(true);
  });

  it("get_top_tokens maps tradeVolumeUSD / derivedUSD fields", async () => {
    stubGraphQl(() => ({
      data: {
        tokens: [
          {
            id: tokenId,
            symbol: "PLSX",
            name: "PulseX",
            decimals: "18",
            tradeVolumeUSD: "12345.6",
            totalLiquidity: "1000",
            totalTransactions: "77",
            derivedPLS: "0.5",
            derivedUSD: "0.00002",
          },
          {
            id: "0x2b591e99afe9f32eaa6214f7b7629768c40eeb39",
            symbol: "HEX",
            name: "HEX",
            decimals: "8",
            tradeVolumeUSD: "999",
            totalLiquidity: "500",
            totalTransactions: "10",
            derivedPLS: "1",
            derivedUSD: "0.01",
          },
        ],
      },
    }));

    const { handlers, server } = captureToolHandlers();
    const { registerFreeTierAnalyticsTools } = await import(
      "../src/tools/analytics/freeTier.js"
    );
    const { resetToolRegistry } = await import("../src/tools/define.js");
    resetToolRegistry();
    registerFreeTierAnalyticsTools(server as never, baseConfig);

    const res = await handlers.get("get_top_tokens")!({
      sort_by: "volume",
      limit: 10,
      version: "v2",
    });
    const body = parseToolJson(res);
    expect(body.ok).toBe(true);
    expect(body.data?.sort_by).toBe("volume");
    const tokens = body.data?.tokens as Array<Record<string, unknown>>;
    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.symbol).toBe("PLSX");
    expect(tokens[0]!.price_usd).toBe(0.00002);
    expect(tokens[0]!.volume_usd_cumulative).toBe(12345.6);
    expect(tokens[0]!.tx_count).toBe(77);
    // Catalogued addresses get origin / display_symbol; raw symbol stays subgraph ticker
    expect(tokens[0]!.display_symbol).toBeTruthy();
    expect(tokens[0]!.token_origin).toBeTruthy();
    expect(tokens[1]!.symbol).toBe("HEX");
    expect(tokens[1]!.display_symbol).toMatch(/pHEX|HEX/i);
    expect(tokens[1]!.token_origin).toBeTruthy();
    expect(String(body.data?.note ?? "")).toMatch(/display_symbol|catalog/i);
  });

  it("get_top_pairs attaches catalog side labels and non-USD price note", async () => {
    const { HEX_ADDRESS, FORK_DAI_ADDRESS, WPLS_ADDRESS } = await import(
      "../src/constants.js"
    );
    stubGraphQl(() => ({
      data: {
        pairs: [
          {
            id: "0xpairhex",
            reserveUSD: "1000000",
            volumeUSD: "500000",
            totalTransactions: "100",
            reserve0: "1",
            reserve1: "2",
            token0Price: "0.5",
            token1Price: "2",
            token0: { id: HEX_ADDRESS, symbol: "HEX" },
            token1: { id: WPLS_ADDRESS, symbol: "WPLS" },
          },
          {
            id: "0xpairpdai",
            reserveUSD: "200000",
            volumeUSD: "10000",
            totalTransactions: "10",
            reserve0: "1",
            reserve1: "1",
            token0Price: "1",
            token1Price: "1",
            token0: { id: FORK_DAI_ADDRESS, symbol: "DAI" },
            token1: {
              id: "0x00000000000000000000000000000000000000cc",
              symbol: "UNK",
            },
          },
        ],
      },
    }));

    const { handlers, server } = captureToolHandlers();
    const { registerFreeTierAnalyticsTools } = await import(
      "../src/tools/analytics/freeTier.js"
    );
    const { resetToolRegistry } = await import("../src/tools/define.js");
    resetToolRegistry();
    registerFreeTierAnalyticsTools(server as never, baseConfig);

    const res = await handlers.get("get_top_pairs")!({
      sort_by: "volume",
      limit: 10,
      version: "v2",
    });
    const body = parseToolJson(res);
    expect(body.ok).toBe(true);
    const pairs = body.data?.pairs as Array<Record<string, unknown>>;
    expect(pairs.length).toBeGreaterThanOrEqual(2);

    const hexPair = pairs.find((p) => p.pair_address === "0xpairhex")!;
    expect(hexPair.token0_display_symbol).toMatch(/pHEX|HEX/i);
    expect(hexPair.token0_origin).toBeTruthy();
    expect(hexPair.token0_price).toBe(0.5); // pair-relative, not asserted as USD

    const pdaiPair = pairs.find((p) => p.pair_address === "0xpairpdai")!;
    expect(pdaiPair.token0_display_symbol).toMatch(/pDAI|DAI/i);
    expect(pdaiPair.token0_origin).toBeTruthy();
    // Unknown UNK side: no invented labels
    expect(pdaiPair.token1_display_symbol).toBeUndefined();
    expect(pdaiPair.token1_origin).toBeUndefined();

    expect(String(body.data?.price_fields_note ?? body.data?.note ?? "")).toMatch(
      /not usd|pair-relative/i,
    );
  });
});
