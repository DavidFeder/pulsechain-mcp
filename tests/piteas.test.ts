/**
 * Piteas client + prepare-intent — drives shipped src/data/piteas.ts (no re-implementation).
 */
import { describe, expect, it } from "vitest";
import {
  PITEAS_API_BASE,
  PITEAS_NATIVE_PLS,
  PITEAS_ROUTER,
  buildPiteasQuoteRequest,
  buildPiteasQuoteUrl,
  computeAmountOutMin,
  getPiteasQuote,
  hexOrDecToDecimalWei,
  isEvenHexData,
  normalizePiteasQuote,
  normalizePiteasToken,
  preparePiteasSwap,
  preparePiteasSwapFromResult,
  weiToHumanPls,
} from "../src/data/piteas.js";
import { parsePlsToWei } from "../src/wallet/value.js";
import { USDC_FROM_ETH_ADDRESS, WPLS_ADDRESS } from "../src/constants.js";
import { getRegisteredTools, resetToolRegistry } from "../src/tools/define.js";
import { registerAllTools } from "../src/tools/registry.js";
import type { AppConfig } from "../src/types.js";
import { REGISTERED_TOOL_COUNT_RESEARCH_ONLY } from "./helpers/toolInventory.js";

const baseConfig: Pick<AppConfig, "httpTimeoutMs"> = { httpTimeoutMs: 5_000 };

/** Even-length hex fixture (selector + four 32-byte words). */
const FIXTURE_CALLDATA =
  "0x8218b58f" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000015d38573d2feeb82e7ad5187ab8c1d52810b1f07" +
  "00000000000000000000000021957f94d6bb63fc2a2b110d16d07952899c6f11" +
  "00000000000000000000000000000000000000000000152d02c7e14af6800000" +
  "00000000000000000000000000000000000000000000000000000000000b4184";

function fixtureBody(overrides: Record<string, unknown> = {}) {
  return {
    srcToken: {
      address: WPLS_ADDRESS,
      symbol: "WPLS",
      decimals: 18,
      chainId: 369,
    },
    destToken: {
      address: USDC_FROM_ETH_ADDRESS,
      symbol: "USDC",
      decimals: 6,
      chainId: 369,
    },
    srcAmount: "0x152d02c7e14af6800000", // 100000e18
    destAmount: "0xb5ea0", // 745120
    gasUseEstimate: 1_665_000,
    gasUseEstimateUSD: 0.006,
    methodParameters: {
      calldata: FIXTURE_CALLDATA,
      value: "0x152d02c7e14af6800000",
    },
    route: {
      paths: [[], []],
      swaps: [{}, {}],
    },
    ...overrides,
  };
}

describe("normalizePiteasToken (shipped)", () => {
  it("maps PLS / native / zero address to Piteas PLS", () => {
    expect(normalizePiteasToken("PLS")).toEqual({
      ok: true,
      param: PITEAS_NATIVE_PLS,
      isNativePls: true,
    });
    expect(normalizePiteasToken("native").ok && normalizePiteasToken("native").param).toBe(
      "PLS",
    );
    expect(
      normalizePiteasToken("0x0000000000000000000000000000000000000000"),
    ).toMatchObject({ ok: true, param: "PLS", isNativePls: true });
  });

  it("maps eUSDC / USDC to bridged eUSDC address", () => {
    const a = normalizePiteasToken("eUSDC");
    const b = normalizePiteasToken("USDC");
    expect(a).toMatchObject({
      ok: true,
      param: USDC_FROM_ETH_ADDRESS,
      isNativePls: false,
    });
    expect(b).toMatchObject({ ok: true, param: USDC_FROM_ETH_ADDRESS });
  });

  it("keeps WPLS as address (not native PLS)", () => {
    expect(normalizePiteasToken("WPLS")).toMatchObject({
      ok: true,
      param: WPLS_ADDRESS,
      isNativePls: false,
    });
  });

  it("rejects unknown symbols and bad addresses", () => {
    expect(normalizePiteasToken("NOTAREALTOKEN").ok).toBe(false);
    expect(normalizePiteasToken("0x1234").ok).toBe(false);
  });
});

describe("pure helpers (shipped)", () => {
  it("hexOrDecToDecimalWei converts hex and decimal", () => {
    expect(hexOrDecToDecimalWei("0xb5ea0")).toBe("745120");
    expect(hexOrDecToDecimalWei("745120")).toBe("745120");
    expect(hexOrDecToDecimalWei("0x152d02c7e14af6800000")).toBe(
      "100000000000000000000000",
    );
  });

  it("weiToHumanPls is human PLS for propose valuePls (not wei)", () => {
    // 1 PLS
    expect(weiToHumanPls("1000000000000000000")).toBe("1");
    // 100000 PLS (native sell size used in live lab)
    expect(weiToHumanPls("100000000000000000000000")).toBe("100000");
    expect(weiToHumanPls("0")).toBe("0");
    // Round-trip with wallet parsePlsToWei (shipped propose path)
    expect(parsePlsToWei(weiToHumanPls("1000000000000000000")).toString()).toBe(
      "1000000000000000000",
    );
    // Footgun: passing wei string to parsePlsToWei would explode — human must differ from wei for 1 PLS
    expect(weiToHumanPls("1000000000000000000")).not.toBe(
      "1000000000000000000",
    );
  });

  it("isEvenHexData rejects odd-length hex", () => {
    expect(isEvenHexData("0x8218b58f00")).toBe(true);
    expect(isEvenHexData("0x8218b58f0")).toBe(false);
    expect(isEvenHexData("8218b58f")).toBe(false);
  });

  it("computeAmountOutMin floors at 1% slip", () => {
    // 745120 * 0.99 = 737668.8 → floor 737668
    expect(computeAmountOutMin("745120", 1)).toBe("737668");
  });

  it("buildPiteasQuoteUrl includes PLS and amount", () => {
    const url = buildPiteasQuoteUrl({
      tokenInParam: "PLS",
      tokenOutParam: USDC_FROM_ETH_ADDRESS,
      amount: "1000",
      allowedSlippage: 1,
      account: "0x21957F94D6bB63Fc2A2B110d16D07952899c6f11",
    });
    expect(url.startsWith(`${PITEAS_API_BASE}/quote?`)).toBe(true);
    expect(url).toContain("tokenInAddress=PLS");
    expect(url).toContain("amount=1000");
    expect(url).toContain("allowedSlippage=1");
  });
});

describe("buildPiteasQuoteRequest (shipped)", () => {
  it("accepts PLS → eUSDC", () => {
    const r = buildPiteasQuoteRequest({
      tokenIn: "PLS",
      tokenOut: "eUSDC",
      amount: "1000000000000000000",
      allowedSlippage: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tokenInParam).toBe("PLS");
      expect(r.tokenOutParam).toBe(USDC_FROM_ETH_ADDRESS);
      expect(r.sellingNativePls).toBe(true);
    }
  });

  it("soft-fails same token and zero amount", () => {
    expect(
      buildPiteasQuoteRequest({
        tokenIn: "PLS",
        tokenOut: "PLS",
        amount: "1",
      }).ok,
    ).toBe(false);
    expect(
      buildPiteasQuoteRequest({
        tokenIn: "PLS",
        tokenOut: "eUSDC",
        amount: "0",
      }).ok,
    ).toBe(false);
  });
});

describe("normalizePiteasQuote + preparePiteasSwap (shipped)", () => {
  const meta = {
    tokenInParam: "PLS",
    tokenOutParam: USDC_FROM_ETH_ADDRESS,
    amount: "100000000000000000000000",
    allowedSlippage: 1,
    account: "0x21957F94D6bB63Fc2A2B110d16D07952899c6f11",
    sellingNativePls: true,
  };

  it("normalizes fixture with exact calldata and router", () => {
    const n = normalizePiteasQuote(fixtureBody(), meta);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.data.amountOut).toBe("745120");
    expect(n.data.amountIn).toBe("100000000000000000000000");
    expect(n.data.amountOutMin).toBe("737668");
    expect(n.data.methodParameters.calldata).toBe(FIXTURE_CALLDATA);
    expect(n.data.router).toBe(PITEAS_ROUTER);
    expect(n.data.valueWei).toBe("100000000000000000000000");
    // valuePls is human PLS (100000), not wei — for propose_agent_tx
    expect(n.data.valuePls).toBe("100000");
    expect(n.data.valuePls).not.toBe(n.data.valueWei);
    expect(parsePlsToWei(n.data.valuePls!).toString()).toBe(n.data.valueWei);
    expect(n.data.quoteReady).toBe(true);
    expect(n.data.chainId).toBe(369);
    expect(n.data.route?.pathCount).toBe(2);
    expect(n.data.decodeNote).toMatch(/unknown/i);
    expect(n.data.note).toMatch(/not a guaranteed best-price/i);
  });

  it("refuses missing or odd-length calldata (never invents)", () => {
    const missing = normalizePiteasQuote({ destAmount: "1" }, meta);
    expect(missing.ok).toBe(false);
    const odd = normalizePiteasQuote(
      fixtureBody({
        methodParameters: { calldata: "0xabc", value: "0x1" },
      }),
      meta,
    );
    expect(odd.ok).toBe(false);
  });

  it("refuses native-in with zero value", () => {
    const n = normalizePiteasQuote(
      fixtureBody({
        methodParameters: { calldata: FIXTURE_CALLDATA, value: "0x0" },
      }),
      meta,
    );
    expect(n.ok).toBe(false);
  });

  it("prepare maps to router + exact data + value without broadcast", () => {
    const n = normalizePiteasQuote(fixtureBody(), meta);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    const p = preparePiteasSwap(n.data);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.broadcast).toBe(false);
    expect(p.advisory).toBe(true);
    expect(p.intent.to).toBe(PITEAS_ROUTER);
    expect(p.intent.data).toBe(FIXTURE_CALLDATA);
    expect(p.intent.valueWei).toBe("100000000000000000000000");
    // Critical: valuePls for propose_agent_tx must be human PLS, not wei
    expect(p.intent.valuePls).toBe("100000");
    expect(p.intent.valuePls).not.toBe(p.intent.valueWei);
    expect(parsePlsToWei(p.intent.valuePls).toString()).toBe(p.intent.valueWei);
    expect(p.review.sellingNativePls).toBe(true);
    expect(p.review.amountOutMin).toBe("737668");
    expect(p.review.localDecodeExpect).toBe("unknown_selector_likely");
    expect(p.methodParameters.calldata).toBe(n.data.methodParameters.calldata);
    expect(p.nextStep).toMatch(/propose_agent_tx/);
    expect(p.nextStep).toMatch(/valuePls: intent\.valuePls/);
    expect(p.nextStep).toMatch(/human PLS/i);
    expect(p.nextStep).not.toMatch(/valuePls or valueWei/);
    expect(p.note).toMatch(/never pass valueWei as valuePls/i);
  });

  it("prepare 1 PLS intent valuePls is '1' not 1e18 wei (propose footgun)", () => {
    const onePlsWei = "1000000000000000000";
    const body = fixtureBody({
      srcAmount: "0xde0b6b3a7640000", // 1e18
      methodParameters: {
        calldata: FIXTURE_CALLDATA,
        value: "0xde0b6b3a7640000",
      },
    });
    const n = normalizePiteasQuote(body, {
      ...meta,
      amount: onePlsWei,
    });
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.data.valueWei).toBe(onePlsWei);
    expect(n.data.valuePls).toBe("1");
    const p = preparePiteasSwap(n.data);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.intent.valuePls).toBe("1");
    expect(p.intent.valueWei).toBe(onePlsWei);
    // If agent wrongly used valueWei as valuePls, parse would be 1e18 PLS
    expect(parsePlsToWei(p.intent.valuePls).toString()).toBe(onePlsWei);
    expect(parsePlsToWei(p.intent.valueWei).toString()).not.toBe(onePlsWei);
  });

  it("preparePiteasSwapFromResult fails soft on quote failure", () => {
    const p = preparePiteasSwapFromResult({
      ok: false,
      source: "piteas",
      reason: "upstream down",
      advisory: true,
    });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.broadcast).toBe(false);
      expect(p.reason).toMatch(/failed quote/i);
    }
  });
});

describe("getPiteasQuote HTTP fail-soft (shipped)", () => {
  it("soft-fails validation without network", async () => {
    const result = await getPiteasQuote(baseConfig, {
      tokenIn: "PLS",
      tokenOut: "PLS",
      amount: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.source).toBe("piteas");
      expect(result.advisory).toBe(true);
      expect(result.reason).toMatch(/differ/i);
    }
  });

  it("soft-fails on HTTP 429", async () => {
    const result = await getPiteasQuote(
      baseConfig,
      {
        tokenIn: "PLS",
        tokenOut: "eUSDC",
        amount: "1000",
      },
      {
        skipSpacing: true,
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

  it("success path uses real URL builder + normalizer (mock fetch)", async () => {
    let hitUrl = "";
    const result = await getPiteasQuote(
      baseConfig,
      {
        tokenIn: "PLS",
        tokenOut: USDC_FROM_ETH_ADDRESS,
        amount: "100000000000000000000000",
        allowedSlippage: 1,
        account: "0x21957F94D6bB63Fc2A2B110d16D07952899c6f11",
      },
      {
        skipSpacing: true,
        fetchImpl: async (url) => {
          hitUrl = String(url);
          return {
            ok: true,
            status: 200,
            json: async () => fixtureBody(),
          } as Response;
        },
      },
    );
    expect(hitUrl).toContain("tokenInAddress=PLS");
    expect(hitUrl).toContain("amount=100000000000000000000000");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("piteas");
      expect(result.advisory).toBe(true);
      expect(result.data.router).toBe(PITEAS_ROUTER);
      expect(result.data.methodParameters.calldata).toBe(FIXTURE_CALLDATA);
      expect(result.data.amountOut).toBe("745120");
      // prepare from same payload
      const prep = preparePiteasSwap(result.data);
      expect(prep.ok).toBe(true);
      if (prep.ok) {
        expect(prep.intent.data).toBe(result.data.methodParameters.calldata);
        expect(prep.intent.to).toBe(PITEAS_ROUTER);
        expect(prep.broadcast).toBe(false);
      }
    }
  });

  it("soft-fails when upstream omits methodParameters", async () => {
    const result = await getPiteasQuote(
      baseConfig,
      { tokenIn: "PLS", tokenOut: "eUSDC", amount: "1000" },
      {
        skipSpacing: true,
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ destAmount: "1", srcAmount: "1" }),
          }) as Response,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/methodParameters|calldata/i);
    }
  });
});

describe("Piteas tool registration", () => {
  it("registers Piteas quote, prepare, and accumulation planner as RO analytics", () => {
    resetToolRegistry();
    const names: string[] = [];
    const server = {
      registerTool: (name: string) => {
        names.push(name);
      },
    };
    const cfg = {
      ...baseConfig,
      rpcUrl: "https://rpc.pulsechain.com",
      rpcUrls: ["https://rpc.pulsechain.com"],
      network: "mainnet" as const,
      explorerApi: "https://api.scan.pulsechain.com/api",
      pulseXSubgraphV1: "https://example.com/v1",
      pulseXSubgraphV2: "https://example.com/v2",
      agentWalletEnabled: false,
      agentWalletDir: "./data/wallets-test",
      agentWalletMultiprocStrict: false,
      agentWalletEnforceLegacyCaps: false,
      maxPlsPerTx: 100,
      maxPlsDaily: 1000,
      logLevel: "error" as const,
    };
    registerAllTools(server as never, cfg as AppConfig);
    expect(names).toContain("piteas_quote");
    expect(names).toContain("piteas_prepare_swap");
    expect(names).toContain("piteas_accumulation_plan");
    const meta = getRegisteredTools();
    for (const n of [
      "piteas_quote",
      "piteas_prepare_swap",
      "piteas_accumulation_plan",
    ]) {
      const t = meta.find((m) => m.name === n);
      expect(t?.category).toBe("analytics");
      expect(t?.write).toBe(false);
      expect(t?.description).toMatch(/not|never|advisory|does NOT/i);
    }
    expect(meta.find((m) => m.name === "piteas_quote")?.description).toMatch(
      /best-price|oracle|Preferred aggregator/i,
    );
    expect(meta.length).toBe(REGISTERED_TOOL_COUNT_RESEARCH_ONLY);
  });
});
