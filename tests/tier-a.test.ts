/**
 * Tier A clients (BlockScout soft helpers, DefiLlama, PulseSwap) — drives
 * shipped URL/body builders, normalizers, and fail-soft HTTP boundaries.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFILLAMA_API_BASE,
  DEFILLAMA_CHAIN_NAME,
  DEFILLAMA_PROTOCOL_CHAIN,
  buildDefiLlamaChainsUrl,
  buildDefiLlamaProtocolsUrl,
  extractPulseChainTvlFromChainTvls,
  findPulseChainRow,
  getPulseChainProtocols,
  getPulseChainTvl,
  isPulseChainLabel,
  normalizePulseChainProtocols,
  normalizePulseChainTvl,
} from "../src/data/defillama.js";
import {
  PULSESWAP_API_BASE,
  PULSESWAP_NATIVE_PLS,
  PULSESWAP_PLATFORMS,
  buildPulseSwapQuoteBody,
  buildPulseSwapQuoteUrl,
  getPulseSwapQuote,
  isPulseSwapPlatform,
  normalizePulseSwapQuote,
} from "../src/data/pulseswap.js";
import {
  getContractAbiSoft,
  getLogsSoft,
  getTokenOverviewSoft,
} from "../src/data/explorer.js";
import {
  WPLS_ADDRESS,
  HEX_ADDRESS,
  PLSX_ADDRESS,
} from "../src/constants.js";
import type { AppConfig } from "../src/types.js";
import { getRegisteredTools, resetToolRegistry } from "../src/tools/define.js";
import { registerAllTools } from "../src/tools/registry.js";
import { REGISTERED_TOOL_COUNT_RESEARCH_ONLY } from "./helpers/toolInventory.js";

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
  logLevel: "error",
  httpTimeoutMs: 5000,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetToolRegistry();
});

// ── DefiLlama ────────────────────────────────────────────────────────────

describe("DefiLlama URL builders (shipped)", () => {
  it("chains and protocols URLs hit api.llama.fi", () => {
    expect(buildDefiLlamaChainsUrl()).toBe(
      `${DEFILLAMA_API_BASE}/v2/chains`,
    );
    expect(buildDefiLlamaProtocolsUrl()).toBe(
      `${DEFILLAMA_API_BASE}/protocols`,
    );
    expect(DEFILLAMA_CHAIN_NAME).toBe("PulseChain");
    expect(DEFILLAMA_PROTOCOL_CHAIN).toBe("Pulse");
  });
});

describe("DefiLlama normalizers (shipped)", () => {
  it("isPulseChainLabel matches Pulse / PulseChain", () => {
    expect(isPulseChainLabel("Pulse")).toBe(true);
    expect(isPulseChainLabel("PulseChain")).toBe(true);
    expect(isPulseChainLabel("Ethereum")).toBe(false);
  });

  it("extractPulseChainTvlFromChainTvls prefers bare Pulse", () => {
    expect(
      extractPulseChainTvlFromChainTvls({
        Pulse: 1_000,
        "Pulse-staking": 50,
        Ethereum: 9_000,
      }),
    ).toBe(1_000);
    expect(extractPulseChainTvlFromChainTvls(null)).toBeNull();
  });

  it("findPulseChainRow + normalizePulseChainTvl", () => {
    const body = [
      { name: "Ethereum", tvl: 50e9 },
      {
        name: "PulseChain",
        tvl: 52_000_000,
        tokenSymbol: "PLS",
        gecko_id: "pulsechain",
      },
    ];
    expect(findPulseChainRow(body)?.name).toBe("PulseChain");
    const n = normalizePulseChainTvl(body, "2026-01-01T00:00:00.000Z");
    expect(n).not.toBeNull();
    expect(n!.tvl).toBe(52_000_000);
    expect(n!.tokenSymbol).toBe("PLS");
    expect(n!.note).toMatch(/advisory/i);
  });

  it("normalizePulseChainProtocols ranks by pulseTvl and filters Dexs", () => {
    const body = [
      {
        name: "PulseX V2",
        slug: "pulsex-v2",
        category: "Dexs",
        tvl: 16e6,
        chains: ["Pulse"],
        chainTvls: { Pulse: 16e6 },
      },
      {
        name: "Other Lend",
        slug: "lend",
        category: "Lending",
        tvl: 2e6,
        chains: ["Pulse"],
        chainTvls: { Pulse: 2e6 },
      },
      {
        name: "EthOnly",
        slug: "eth",
        category: "Dexs",
        tvl: 1e9,
        chains: ["Ethereum"],
        chainTvls: { Ethereum: 1e9 },
      },
    ];
    const all = normalizePulseChainProtocols(body, { limit: 10 });
    expect(all.protocolCount).toBe(2);
    expect(all.protocols[0].name).toBe("PulseX V2");
    expect(all.note).toMatch(/advisory|Pulse/i);

    const dexs = normalizePulseChainProtocols(body, {
      limit: 10,
      category: "Dexs",
    });
    expect(dexs.protocolCount).toBe(1);
    expect(dexs.protocols[0].slug).toBe("pulsex-v2");
  });
});

describe("DefiLlama soft-fail HTTP (shipped)", () => {
  it("getPulseChainTvl soft-fails on network error", async () => {
    const result = await getPulseChainTvl(baseConfig, {
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.source).toBe("defillama");
      expect(result.reason).toMatch(/network|ECONNRESET/i);
    }
  });

  it("getPulseChainTvl soft-fails on HTTP 500", async () => {
    const result = await getPulseChainTvl(baseConfig, {
      fetchImpl: async () =>
        ({
          ok: false,
          status: 500,
          json: async () => ({}),
        }) as Response,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.source).toBe("defillama");
    }
  });

  it("getPulseChainTvl success path normalizes fixture", async () => {
    const result = await getPulseChainTvl(baseConfig, {
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => [
            { name: "PulseChain", tvl: 12_345, tokenSymbol: "PLS" },
          ],
        }) as Response,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("defillama");
      expect(result.advisory).toBe(true);
      expect(result.data.tvl).toBe(12_345);
    }
  });

  it("getPulseChainProtocols soft-fails on timeout abort", async () => {
    const result = await getPulseChainProtocols(baseConfig, {
      fetchImpl: async (_url, init) => {
        const err = new Error("aborted");
        err.name = "AbortError";
        // honor abort signal if present
        void init;
        throw err;
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/timed out/i);
    }
  });
});

// ── PulseSwap ────────────────────────────────────────────────────────────

describe("PulseSwap builders (shipped)", () => {
  it("quote URLs and platforms", () => {
    expect(buildPulseSwapQuoteUrl("standard")).toBe(
      `${PULSESWAP_API_BASE}/quotes`,
    );
    expect(buildPulseSwapQuoteUrl("advanced")).toBe(
      `${PULSESWAP_API_BASE}/quotes/advanced`,
    );
    expect(isPulseSwapPlatform("mixed")).toBe(true);
    expect(isPulseSwapPlatform("pulsex")).toBe(false);
    expect(PULSESWAP_PLATFORMS).toContain("pulsex_v2");
  });

  it("buildPulseSwapQuoteBody forces chainId 369 and field names", () => {
    const built = buildPulseSwapQuoteBody({
      fromToken: PULSESWAP_NATIVE_PLS,
      toToken: WPLS_ADDRESS,
      amountIn: "1000000000000000000",
      platform: "pulsex_v2",
      slippage: 0.5,
    });
    expect(built.error).toBeUndefined();
    expect(built.body.chainId).toBe(369);
    expect(built.body.fromToken).toBe(PULSESWAP_NATIVE_PLS);
    expect(built.body.toToken).toBe(WPLS_ADDRESS);
    expect(built.body.amountIn).toBe("1000000000000000000");
    expect(built.body.platform).toBe("pulsex_v2");
    expect(built.body.slippage).toBe(0.5);
    expect(built.path).toBe("/quotes");
  });

  it("buildPulseSwapQuoteBody rejects bad platform and wrong chain", () => {
    const badPlat = buildPulseSwapQuoteBody({
      fromToken: WPLS_ADDRESS,
      toToken: HEX_ADDRESS,
      amountIn: "1",
      platform: "not_a_dex",
    });
    expect(badPlat.error).toMatch(/Invalid platform/i);

    const badChain = buildPulseSwapQuoteBody({
      fromToken: WPLS_ADDRESS,
      toToken: HEX_ADDRESS,
      amountIn: "1",
      chainId: 1,
    });
    expect(badChain.error).toMatch(/chainId|369/i);
  });

  it("normalizePulseSwapQuote exposes amountIn/out and quoteReady", () => {
    const data = normalizePulseSwapQuote(
      {
        success: true,
        message: "OK",
        timestamp: "t",
        data: {
          success: true,
          quoteId: "q1",
          amountIn: "1000",
          amountOut: "900",
          amountOutUSD: "1.2",
          gasEstimate: 120000,
          tx: null,
        },
      },
      {
        platform: "mixed",
        chainId: 369,
        fromToken: WPLS_ADDRESS,
        toToken: HEX_ADDRESS,
        slippage: 1,
        mode: "standard",
        requestAmountIn: "1000",
      },
    );
    expect(data.amountIn).toBe("1000");
    expect(data.amountInRequested).toBe("1000");
    expect(data.amountInUpstream).toBe("1000");
    expect(data.amountOut).toBe("900");
    expect(data.quoteReady).toBe(true);
    expect(data.priceUsdReady).toBe(true);
    expect(data.executionReady).toBe(false);
    expect(data.amountInUpstreamZero).toBe(false);
    expect(data.note).toMatch(/advisory|not a swap execution/i);
    expect(data.txAdvisory).toBeNull();
  });

  it("normalizePulseSwapQuote echoes request amountIn when upstream is 0/empty", () => {
    const requested = "5000000000000000000";
    const zeroed = normalizePulseSwapQuote(
      {
        success: true,
        data: {
          success: true,
          amountIn: "0",
          amountOut: "123456",
          amountOutUSD: "0",
          gasEstimate: 99_000,
        },
      },
      {
        platform: "mixed",
        chainId: 369,
        fromToken: WPLS_ADDRESS,
        toToken: HEX_ADDRESS,
        slippage: 0.5,
        mode: "standard",
        requestAmountIn: requested,
      },
    );
    expect(zeroed.amountIn).toBe(requested);
    expect(zeroed.amountInRequested).toBe(requested);
    expect(zeroed.amountInUpstream).toBe("0");
    expect(zeroed.amountOut).toBe("123456");
    // H3: advisory amountOut ok, but not USD-priced and never execution-ready
    expect(zeroed.quoteReady).toBe(true);
    expect(zeroed.priceUsdReady).toBe(false);
    expect(zeroed.executionReady).toBe(false);
    expect(zeroed.amountInUpstreamZero).toBe(true);
    expect(zeroed.note).toMatch(/amountInRequested|upstream|advisory|executionReady|priceUsdReady/i);

    const empty = normalizePulseSwapQuote(
      {
        success: true,
        data: {
          success: true,
          amountIn: "",
          amountOut: "99",
        },
      },
      {
        platform: "mixed",
        chainId: 369,
        fromToken: WPLS_ADDRESS,
        toToken: HEX_ADDRESS,
        slippage: 0.5,
        mode: "standard",
        requestAmountIn: "42",
      },
    );
    expect(empty.amountIn).toBe("42");
    expect(empty.amountInUpstream).toBe(""); // raw empty string preserved
    expect(empty.quoteReady).toBe(true);
    expect(empty.priceUsdReady).toBe(false);
    expect(empty.executionReady).toBe(false);
    expect(empty.amountInUpstreamZero).toBe(true);

    // Non-zero upstream still wins over request for amountIn field
    const upstreamWins = normalizePulseSwapQuote(
      {
        success: true,
        data: {
          success: true,
          amountIn: "777",
          amountOut: "1",
        },
      },
      {
        platform: "mixed",
        chainId: 369,
        fromToken: WPLS_ADDRESS,
        toToken: HEX_ADDRESS,
        slippage: 0.5,
        mode: "standard",
        requestAmountIn: "999",
      },
    );
    expect(upstreamWins.amountIn).toBe("777");
    expect(upstreamWins.amountInRequested).toBe("999");
    expect(upstreamWins.amountInUpstream).toBe("777");
    expect(upstreamWins.amountInUpstreamZero).toBe(false);
    expect(upstreamWins.executionReady).toBe(false);
  });

  it("normalizePulseSwapQuote does not invent quoteReady when amountOut is zero", () => {
    const data = normalizePulseSwapQuote(
      {
        success: true,
        data: {
          success: true,
          amountIn: "0",
          amountOut: "0",
        },
      },
      {
        platform: "mixed",
        chainId: 369,
        fromToken: WPLS_ADDRESS,
        toToken: HEX_ADDRESS,
        slippage: 0.5,
        mode: "standard",
        requestAmountIn: "1000",
      },
    );
    expect(data.amountIn).toBe("1000");
    expect(data.quoteReady).toBe(false);
  });

  it("normalizePulseSwapQuote attaches tx advisory warning when present", () => {
    const data = normalizePulseSwapQuote(
      {
        success: true,
        data: {
          success: true,
          amountIn: "1",
          amountOut: "2",
          tx: {
            from: "0xabc",
            to: "0xdef",
            data: "0xdead",
            value: "0x0",
          },
        },
      },
      {
        platform: "mixed",
        chainId: 369,
        fromToken: WPLS_ADDRESS,
        toToken: HEX_ADDRESS,
        slippage: 0.5,
        mode: "advanced",
        requestAmountIn: "1",
      },
    );
    expect(data.txAdvisory?.data).toBe("0xdead");
    expect(data.txAdvisory?.warning).toMatch(/does not broadcast|advisory/i);
  });
});

describe("PulseSwap soft-fail HTTP (shipped)", () => {
  it("getPulseSwapQuote soft-fails on validation (no network)", async () => {
    const result = await getPulseSwapQuote(baseConfig, {
      fromToken: WPLS_ADDRESS,
      toToken: WPLS_ADDRESS,
      amountIn: "1",
      platform: "mixed",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.source).toBe("pulseswap");
      expect(result.reason).toMatch(/differ|fromToken/i);
    }
  });

  it("getPulseSwapQuote soft-fails on HTTP 429", async () => {
    const result = await getPulseSwapQuote(
      baseConfig,
      {
        fromToken: WPLS_ADDRESS,
        toToken: HEX_ADDRESS,
        amountIn: "1000",
        platform: "mixed",
      },
      {
        fetchImpl: async () =>
          ({
            ok: false,
            status: 429,
            json: async () => ({ message: "rate" }),
          }) as Response,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.reason).toMatch(/rate limit/i);
    }
  });

  it("getPulseSwapQuote success path uses real body builder + normalizer", async () => {
    let posted: unknown;
    const result = await getPulseSwapQuote(
      baseConfig,
      {
        fromToken: WPLS_ADDRESS,
        toToken: HEX_ADDRESS,
        amountIn: "5000000000000000000",
        platform: "pulsex_v2",
        slippage: 1,
      },
      {
        fetchImpl: async (_url, init) => {
          posted = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              message: "OK",
              data: {
                success: true,
                quoteId: "live-fixture",
                amountIn: "5000000000000000000",
                amountOut: "12345",
                gasEstimate: 99_000,
              },
            }),
          } as Response;
        },
      },
    );
    expect(posted).toMatchObject({
      chainId: 369,
      platform: "pulsex_v2",
      fromToken: WPLS_ADDRESS,
      toToken: HEX_ADDRESS,
      amountIn: "5000000000000000000",
      slippage: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("pulseswap");
      expect(result.data.amountOut).toBe("12345");
      expect(result.data.amountIn).toBe("5000000000000000000");
      expect(result.data.amountInRequested).toBe("5000000000000000000");
      expect(result.data.quoteReady).toBe(true);
      expect(result.advisory).toBe(true);
    }
  });

  it("getPulseSwapQuote echoes request amountIn when upstream returns 0", async () => {
    const requested = "2500000000000000000";
    const result = await getPulseSwapQuote(
      baseConfig,
      {
        fromToken: WPLS_ADDRESS,
        toToken: HEX_ADDRESS,
        amountIn: requested,
        platform: "mixed",
        slippage: 0.5,
      },
      {
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                success: true,
                quoteId: "zero-in-fixture",
                amountIn: "0",
                amountOut: "888",
                amountOutUSD: "0",
                gasEstimate: 50_000,
              },
            }),
          }) as Response,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.amountIn).toBe(requested);
      expect(result.data.amountInRequested).toBe(requested);
      expect(result.data.amountInUpstream).toBe("0");
      expect(result.data.amountOut).toBe("888");
      expect(result.data.quoteReady).toBe(true);
      expect(result.data.priceUsdReady).toBe(false);
      expect(result.data.executionReady).toBe(false);
      expect(result.data.amountInUpstreamZero).toBe(true);
      expect(result.advisory).toBe(true);
    }
  });

  it("getPulseSwapQuote soft-fails when outer success false", async () => {
    const result = await getPulseSwapQuote(
      baseConfig,
      {
        fromToken: WPLS_ADDRESS,
        toToken: HEX_ADDRESS,
        amountIn: "1",
        platform: "mixed",
      },
      {
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              success: false,
              data: null,
              message: "Validation failed: bad",
            }),
          }) as Response,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/Validation failed/i);
    }
  });
});

// ── BlockScout soft helpers ──────────────────────────────────────────────

describe("BlockScout soft-fail helpers (shipped)", () => {
  it("getTokenOverviewSoft succeeds with partial v1 metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("module=token") && url.includes("getToken")) {
          return {
            ok: true,
            json: async () => ({
              status: "1",
              message: "OK",
              result: {
                name: "HEX",
                symbol: "HEX",
                decimals: "8",
                totalSupply: "1000",
              },
            }),
          };
        }
        // v2 and holders fail
        return {
          ok: false,
          status: 500,
          json: async () => ({ message: "err" }),
          text: async () => "err",
        };
      }),
    );

    const result = await getTokenOverviewSoft(baseConfig, HEX_ADDRESS, {
      holderLimit: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("blockscout");
      expect(result.data.symbol).toBe("HEX");
      expect(result.data.sourcesUsed).toContain("explorer_getToken");
      expect(result.data.note).toMatch(/BlockScout|scan\.pulsechain/i);
    }
  });

  it("getTokenOverviewSoft soft-fails when all sources fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => "",
      })),
    );
    const result = await getTokenOverviewSoft(baseConfig, PLSX_ADDRESS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.source).toBe("blockscout");
      expect(result.reason).toMatch(/failed/i);
    }
  });

  it("getContractAbiSoft parses verified ABI fixture", async () => {
    const abi = [
      {
        type: "function",
        name: "balanceOf",
        inputs: [{ name: "a", type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("action=getabi")) {
          return {
            ok: true,
            json: async () => ({
              status: "1",
              message: "OK",
              result: JSON.stringify(abi),
            }),
          };
        }
        if (url.includes("action=getsourcecode")) {
          return {
            ok: true,
            json: async () => ({
              status: "1",
              message: "OK",
              result: [
                {
                  ContractName: "WPLS",
                  CompilerVersion: "v0.5.0",
                  ABI: JSON.stringify(abi),
                },
              ],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    const result = await getContractAbiSoft(baseConfig, WPLS_ADDRESS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verified).toBe(true);
      expect(result.data.contractName).toBe("WPLS");
      expect(Array.isArray(result.data.abi)).toBe(true);
      expect(result.source).toBe("blockscout");
    }
  });

  it("getLogsSoft soft-fails on explorer error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "0",
          message: "Something went wrong.",
          result: null,
        }),
      })),
    );
    const result = await getLogsSoft(baseConfig, {
      address: WPLS_ADDRESS,
      fromBlock: 1,
      toBlock: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.source).toBe("blockscout");
    }
  });

  it("getLogsSoft sets truncated when returned logs hit offset", async () => {
    const offset = 3;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: Array.from({ length: offset }, (_, i) => ({
            transactionHash: `0x${i}`,
          })),
        }),
      })),
    );
    const result = await getLogsSoft(baseConfig, {
      address: WPLS_ADDRESS,
      fromBlock: 10,
      toBlock: 20,
      page: 1,
      offset,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.logs).toHaveLength(offset);
      expect(result.data.truncated).toBe(true);
      expect(result.data.window).toEqual({
        fromBlock: 10,
        toBlock: 20,
        offset,
        page: 1,
      });
      expect(result.data.note).toMatch(/not full history/i);
    }
  });

  it("getLogsSoft sets truncated false when under offset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [{ transactionHash: "0x1" }],
        }),
      })),
    );
    const result = await getLogsSoft(baseConfig, {
      address: WPLS_ADDRESS,
      offset: 50,
      page: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.truncated).toBe(false);
      expect(result.data.window.offset).toBe(50);
      expect(result.data.window.page).toBe(2);
      expect(result.data.window.fromBlock).toBe(0);
      expect(result.data.window.toBlock).toBe("latest");
    }
  });
});

// ── Tool registration ────────────────────────────────────────────────────

describe("Tier A tool registration", () => {
  it("registers all Tier A tools under analytics", () => {
    const names: string[] = [];
    const server = {
      registerTool: (name: string) => {
        names.push(name);
      },
    };
    registerAllTools(server as never, baseConfig);
    const tierA = [
      "blockscout_token_overview",
      "blockscout_contract_abi",
      "blockscout_address_activity",
      "blockscout_event_logs",
      "defillama_pulsechain_tvl",
      "defillama_pulsechain_protocols",
      "pulseswap_quote",
      "piteas_quote",
      "piteas_prepare_swap",
      "switch_quote",
      "switch_prepare_swap",
    ];
    for (const n of tierA) {
      expect(names).toContain(n);
    }
    const meta = getRegisteredTools();
    for (const n of tierA) {
      const t = meta.find((m) => m.name === n);
      expect(t?.category).toBe("analytics");
      expect(t?.write).toBe(false);
    }
    // Research-only inventory (writes omitted)
    expect(meta.length).toBe(REGISTERED_TOOL_COUNT_RESEARCH_ONLY);
  });
});
