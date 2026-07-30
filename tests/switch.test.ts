/**
 * Switch.win client + prepare-intent — drives shipped src/data/switch.ts (no re-implementation).
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  SWITCH_API_BASE,
  SWITCH_API_KEY_REQUEST_URL,
  SWITCH_AUTH_GUIDANCE,
  SWITCH_AUTH_OPERATOR_NEXT_STEP,
  SWITCH_NATIVE_SENTINEL,
  buildSwitchQuoteRequest,
  buildSwitchQuoteUrl,
  computeAmountOutMin,
  getSwitchQuote,
  hexOrDecToDecimalWei,
  isEvenHexData,
  normalizeSwitchQuote,
  normalizeSwitchToken,
  parseSwitchTx,
  percentToSlippageBps,
  prepareSwitchSwap,
  prepareSwitchSwapFromResult,
  resolveSwitchApiKey,
  switchAuthSoftFailFields,
  weiToHumanPls,
} from "../src/data/switch.js";
import { parsePlsToWei } from "../src/wallet/value.js";
import { USDC_FROM_ETH_ADDRESS, WPLS_ADDRESS } from "../src/constants.js";
import { getRegisteredTools, resetToolRegistry } from "../src/tools/define.js";
import { registerAllTools } from "../src/tools/registry.js";
import type { AppConfig } from "../src/types.js";

const baseConfig: Pick<AppConfig, "httpTimeoutMs"> = { httpTimeoutMs: 5_000 };

/** Even-length hex fixture (selector + args). */
const FIXTURE_CALLDATA =
  "0xabcdef01" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000015d38573d2feeb82e7ad5187ab8c1d52810b1f07" +
  "00000000000000000000000021957f94d6bb63fc2a2b110d16d07952899c6f11" +
  "0000000000000000000000000000000000000000000000000de0b6b3a7640000";

/** Documented sample router-shaped address from Switch docs (fixture only — prepare uses tx.to). */
const FIXTURE_ROUTER = "0x0305fcb5dA680EA6fd1B01A96C1949175B99d406";
const FIXTURE_SENDER = "0x21957F94D6bB63Fc2A2B110d16D07952899c6f11";

function fixtureBody(overrides: Record<string, unknown> = {}) {
  return {
    fromToken: SWITCH_NATIVE_SENTINEL,
    toToken: USDC_FROM_ETH_ADDRESS,
    receiver: FIXTURE_SENDER,
    totalAmountIn: "1000000000000000000",
    totalAmountOut: "800000",
    expectedOutputAmount: "797600",
    minAmountOut: "789624",
    fromTokenTax: { isTaxToken: false, buyTaxBps: 0, sellTaxBps: 0 },
    toTokenTax: { isTaxToken: false, buyTaxBps: 0, sellTaxBps: 0 },
    effectiveSlippageBps: 50,
    effectiveSlippagePercent: "0.5",
    paths: [{ adapter: "PulseXV2", amountIn: "1000000000000000000" }],
    tx: {
      to: FIXTURE_ROUTER,
      data: FIXTURE_CALLDATA,
      value: "1000000000000000000",
    },
    txFeeOnOutput: {
      to: FIXTURE_ROUTER,
      data: FIXTURE_CALLDATA,
      value: "1000000000000000000",
    },
    ...overrides,
  };
}

const metaBase = {
  tokenInParam: SWITCH_NATIVE_SENTINEL,
  tokenOutParam: USDC_FROM_ETH_ADDRESS,
  amount: "1000000000000000000",
  slippageBps: 50,
  allowedSlippage: 0.5,
  sender: FIXTURE_SENDER,
  feeOnOutput: false,
  sellingNativePls: true,
  apiKeyConfigured: true,
};

afterEach(() => {
  resetToolRegistry();
  delete process.env.SWITCH_API_KEY;
});

describe("normalizeSwitchToken (shipped)", () => {
  it("maps PLS / native / zero / sentinel to Switch native sentinel", () => {
    expect(normalizeSwitchToken("PLS")).toEqual({
      ok: true,
      param: SWITCH_NATIVE_SENTINEL,
      isNativePls: true,
    });
    expect(normalizeSwitchToken("native").ok && normalizeSwitchToken("native").param).toBe(
      SWITCH_NATIVE_SENTINEL,
    );
    expect(
      normalizeSwitchToken("0x0000000000000000000000000000000000000000"),
    ).toMatchObject({ ok: true, param: SWITCH_NATIVE_SENTINEL, isNativePls: true });
    expect(normalizeSwitchToken(SWITCH_NATIVE_SENTINEL)).toMatchObject({
      ok: true,
      param: SWITCH_NATIVE_SENTINEL,
      isNativePls: true,
    });
  });

  it("maps eUSDC / USDC to bridged eUSDC address", () => {
    expect(normalizeSwitchToken("eUSDC")).toMatchObject({
      ok: true,
      param: USDC_FROM_ETH_ADDRESS,
      isNativePls: false,
    });
    expect(normalizeSwitchToken("USDC")).toMatchObject({
      ok: true,
      param: USDC_FROM_ETH_ADDRESS,
    });
  });

  it("keeps WPLS as address (not native)", () => {
    expect(normalizeSwitchToken("WPLS")).toMatchObject({
      ok: true,
      param: WPLS_ADDRESS,
      isNativePls: false,
    });
  });

  it("rejects unknown symbols and bad addresses", () => {
    expect(normalizeSwitchToken("NOTAREALTOKEN").ok).toBe(false);
    expect(normalizeSwitchToken("0x1234").ok).toBe(false);
  });
});

describe("pure helpers (shipped)", () => {
  it("hexOrDecToDecimalWei / weiToHumanPls / isEvenHexData", () => {
    expect(hexOrDecToDecimalWei("0xb5ea0")).toBe("745120");
    expect(hexOrDecToDecimalWei("745120")).toBe("745120");
    expect(weiToHumanPls("1000000000000000000")).toBe("1");
    expect(weiToHumanPls("100000000000000000000000")).toBe("100000");
    expect(parsePlsToWei(weiToHumanPls("1000000000000000000")).toString()).toBe(
      "1000000000000000000",
    );
    expect(isEvenHexData(FIXTURE_CALLDATA)).toBe(true);
    expect(isEvenHexData("0xabc")).toBe(false);
  });

  it("percentToSlippageBps converts 0.5% → 50 bps", () => {
    expect(percentToSlippageBps(0.5)).toBe(50);
    expect(percentToSlippageBps(1)).toBe(100);
    expect(percentToSlippageBps(51)).toBeUndefined();
  });

  it("computeAmountOutMin floors at 1% slip", () => {
    expect(computeAmountOutMin("745120", 1)).toBe("737668");
  });

  it("parseSwitchTx requires address to + even hex data", () => {
    expect(
      parseSwitchTx({
        to: FIXTURE_ROUTER,
        data: FIXTURE_CALLDATA,
        value: "0",
      }),
    ).toMatchObject({ to: FIXTURE_ROUTER, data: FIXTURE_CALLDATA });
    expect(parseSwitchTx({ to: "not-addr", data: FIXTURE_CALLDATA })).toBeNull();
    expect(parseSwitchTx({ to: FIXTURE_ROUTER, data: "0xab" })).toBeNull();
    expect(parseSwitchTx(null)).toBeNull();
  });

  it("buildSwitchQuoteUrl uses from/to/amount/network and never hardcodes router", () => {
    const url = buildSwitchQuoteUrl({
      tokenInParam: SWITCH_NATIVE_SENTINEL,
      tokenOutParam: USDC_FROM_ETH_ADDRESS,
      amount: "1000",
      slippageBps: 50,
      sender: FIXTURE_SENDER,
    });
    expect(url.startsWith(`${SWITCH_API_BASE}/swap/quote?`)).toBe(true);
    expect(url).toContain("network=pulsechain");
    expect(url).toContain(`from=${encodeURIComponent(SWITCH_NATIVE_SENTINEL)}`);
    expect(url).toContain("amount=1000");
    expect(url).toContain("slippage=50");
    expect(url).toContain(`sender=${FIXTURE_SENDER}`);
    expect(url.toLowerCase()).not.toContain("0305fcb5");
  });

  it("resolveSwitchApiKey prefers options then env", () => {
    delete process.env.SWITCH_API_KEY;
    expect(resolveSwitchApiKey()).toBeUndefined();
    expect(resolveSwitchApiKey({ apiKey: "  opt-key  " })).toBe("opt-key");
    process.env.SWITCH_API_KEY = "env-key";
    expect(resolveSwitchApiKey()).toBe("env-key");
    expect(resolveSwitchApiKey({ apiKey: "opt" })).toBe("opt");
  });
});

describe("buildSwitchQuoteRequest (shipped)", () => {
  it("accepts PLS → eUSDC with percent slip → bps", () => {
    const r = buildSwitchQuoteRequest({
      tokenIn: "PLS",
      tokenOut: "eUSDC",
      amount: "1000000000000000000",
      allowedSlippage: 1,
      sender: FIXTURE_SENDER,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tokenInParam).toBe(SWITCH_NATIVE_SENTINEL);
      expect(r.tokenOutParam).toBe(USDC_FROM_ETH_ADDRESS);
      expect(r.sellingNativePls).toBe(true);
      expect(r.slippageBps).toBe(100);
      expect(r.allowedSlippage).toBe(1);
      expect(r.sender).toBe(FIXTURE_SENDER);
    }
  });

  it("account aliases to sender", () => {
    const r = buildSwitchQuoteRequest({
      tokenIn: "WPLS",
      tokenOut: "eUSDC",
      amount: "1",
      account: FIXTURE_SENDER,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sender).toBe(FIXTURE_SENDER);
      expect(r.sellingNativePls).toBe(false);
    }
  });

  it("soft-fails same token and zero amount", () => {
    expect(
      buildSwitchQuoteRequest({
        tokenIn: "PLS",
        tokenOut: "PLS",
        amount: "1",
      }).ok,
    ).toBe(false);
    expect(
      buildSwitchQuoteRequest({
        tokenIn: "PLS",
        tokenOut: "eUSDC",
        amount: "0",
      }).ok,
    ).toBe(false);
  });
});

describe("normalizeSwitchQuote + prepareSwitchSwap (shipped)", () => {
  it("normalizes fixture with exact tx.to/data/value (no hardcoded router sole source)", () => {
    const n = normalizeSwitchQuote(fixtureBody(), metaBase);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.data.amountOut).toBe("797600");
    expect(n.data.amountIn).toBe("1000000000000000000");
    expect(n.data.amountOutMin).toBe("789624");
    expect(n.data.tx.data).toBe(FIXTURE_CALLDATA);
    expect(n.data.tx.to).toBe(FIXTURE_ROUTER);
    expect(n.data.valueWei).toBe("1000000000000000000");
    expect(n.data.valuePls).toBe("1");
    expect(parsePlsToWei(n.data.valuePls!).toString()).toBe(n.data.valueWei);
    expect(n.data.quoteReady).toBe(true);
    expect(n.data.decodeNote).toMatch(/unknown|review_carefully|goSwitch/i);
    expect(n.data.note).toMatch(/not a guaranteed best-price/i);
  });

  it("refuses missing or odd-length tx data when no amountOut", () => {
    const missing = normalizeSwitchQuote({ expectedOutputAmount: "0" }, metaBase);
    expect(missing.ok).toBe(false);
    const odd = normalizeSwitchQuote(
      fixtureBody({
        expectedOutputAmount: "0",
        totalAmountOut: "0",
        minAmountOut: "0",
        tx: { to: FIXTURE_ROUTER, data: "0xabc", value: "1" },
      }),
      metaBase,
    );
    expect(odd.ok).toBe(false);
  });

  it("refuses native-in with zero tx.value", () => {
    const n = normalizeSwitchQuote(
      fixtureBody({
        tx: { to: FIXTURE_ROUTER, data: FIXTURE_CALLDATA, value: "0" },
      }),
      metaBase,
    );
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.reason).toMatch(/tx\.value is zero/i);
  });

  it("prepare maps to upstream to + exact data + value without broadcast", () => {
    const n = normalizeSwitchQuote(fixtureBody(), metaBase);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    const p = prepareSwitchSwap(n.data);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.broadcast).toBe(false);
    expect(p.advisory).toBe(true);
    expect(p.intent.to).toBe(FIXTURE_ROUTER);
    expect(p.intent.to).toBe(n.data.tx.to);
    expect(p.intent.data).toBe(FIXTURE_CALLDATA);
    expect(p.intent.valueWei).toBe("1000000000000000000");
    expect(p.intent.valuePls).toBe("1");
    expect(parsePlsToWei(p.intent.valuePls).toString()).toBe(p.intent.valueWei);
    expect(p.review.sellingNativePls).toBe(true);
    expect(p.review.amountOutMin).toBe("789624");
    expect(p.review.routerFromUpstream).toBe(p.intent.to);
    expect(p.review.localDecodeExpect).toBe("unknown_selector_likely");
    expect(p.tx.data).toBe(n.data.tx.data);
    expect(p.nextStep).toMatch(/propose_agent_tx/);
    expect(p.nextStep).toMatch(/valuePls: intent\.valuePls/);
    expect(p.nextStep).toMatch(/never hardcode/i);
    expect(p.note).toMatch(/never a hardcoded router/i);
  });

  it("prepare fails soft without inventing when quote not ready", () => {
    const n = normalizeSwitchQuote(
      {
        fromToken: SWITCH_NATIVE_SENTINEL,
        toToken: USDC_FROM_ETH_ADDRESS,
        expectedOutputAmount: "100",
        totalAmountIn: "1",
        // no tx
      },
      { ...metaBase, sender: undefined },
    );
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.data.quoteReady).toBe(false);
    const p = prepareSwitchSwap(n.data);
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.broadcast).toBe(false);
      expect(p.reason).toMatch(/prepare-ready|sender|calldata|even-length|not ready|quoteReady/i);
    }
  });

  it("prepareSwitchSwapFromResult fails soft on quote failure", () => {
    const p = prepareSwitchSwapFromResult({
      ok: false,
      source: "switch",
      reason: "upstream down",
      advisory: true,
    });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.broadcast).toBe(false);
      expect(p.reason).toMatch(/failed quote/i);
    }
  });

  it("to always comes from upstream tx, not a module constant sole source", () => {
    const altRouter = "0x1111111111111111111111111111111111111111";
    const n = normalizeSwitchQuote(
      fixtureBody({
        tx: { to: altRouter, data: FIXTURE_CALLDATA, value: "1000000000000000000" },
      }),
      metaBase,
    );
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    const p = prepareSwitchSwap(n.data);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.intent.to).toBe(altRouter);
    expect(p.intent.to).not.toBe(FIXTURE_ROUTER);
  });
});

describe("getSwitchQuote HTTP fail-soft (shipped)", () => {
  it("soft-fails validation without network", async () => {
    const result = await getSwitchQuote(baseConfig, {
      tokenIn: "PLS",
      tokenOut: "PLS",
      amount: "1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.source).toBe("switch");
      expect(result.advisory).toBe(true);
      expect(result.reason).toMatch(/differ/i);
    }
  });

  it("soft-fails with operator-gated guidance when SWITCH_API_KEY missing", async () => {
    delete process.env.SWITCH_API_KEY;
    const result = await getSwitchQuote(baseConfig, {
      tokenIn: "PLS",
      tokenOut: "eUSDC",
      amount: "1000",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.authRequired).toBe(true);
      expect(result.operatorGated).toBe(true);
      expect(result.status).toBe(401);
      expect(result.requestApiKeyUrl).toBe(SWITCH_API_KEY_REQUEST_URL);
      expect(result.requestApiKeyUrl).toMatch(/docs\.switch\.win\/aggregator\/request-api-key/);
      expect(result.preferKeyless).toBe("piteas_quote");
      expect(result.nextStep).toBe(SWITCH_AUTH_OPERATOR_NEXT_STEP);
      expect(result.nextStep).toMatch(/operator/i);
      expect(result.nextStep).toMatch(/piteas_quote/);
      expect(result.reason).toBe(SWITCH_AUTH_GUIDANCE.missingKey);
      expect(result.reason).toMatch(/operator-gated|not available in-app|cannot usefully/i);
      expect(result.reason).toMatch(/piteas_quote/);
      // Never invent or embed a real key value
      expect(result.reason).not.toMatch(/sk_|api[_-]?key\s*=\s*[a-zA-Z0-9]{16,}/i);
    }
  });

  it("soft-fails on HTTP 401 from upstream with operator nextStep", async () => {
    const result = await getSwitchQuote(
      baseConfig,
      { tokenIn: "PLS", tokenOut: "eUSDC", amount: "1000" },
      {
        apiKey: "test-key",
        fetchImpl: async () =>
          ({
            ok: false,
            status: 401,
            json: async () => ({ error: "Unauthorized" }),
          }) as Response,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.authRequired).toBe(true);
      expect(result.operatorGated).toBe(true);
      expect(result.requestApiKeyUrl).toBe(SWITCH_API_KEY_REQUEST_URL);
      expect(result.preferKeyless).toBe("piteas_quote");
      expect(result.nextStep).toMatch(/Ask the operator/i);
      expect(result.reason).toBe(SWITCH_AUTH_GUIDANCE.unauthorized);
    }
  });

  it("soft-fails on HTTP 403 with operator-gated fields", async () => {
    const result = await getSwitchQuote(
      baseConfig,
      { tokenIn: "PLS", tokenOut: "eUSDC", amount: "1000" },
      {
        apiKey: "bad-key",
        fetchImpl: async () =>
          ({
            ok: false,
            status: 403,
            json: async () => ({ error: "Forbidden" }),
          }) as Response,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.authRequired).toBe(true);
      expect(result.operatorGated).toBe(true);
      expect(result.preferKeyless).toBe("piteas_quote");
      expect(result.reason).toBe(SWITCH_AUTH_GUIDANCE.forbidden);
    }
  });

  it("switchAuthSoftFailFields is pure and points at request docs + piteas", () => {
    const f = switchAuthSoftFailFields();
    expect(f.authRequired).toBe(true);
    expect(f.operatorGated).toBe(true);
    expect(f.requestApiKeyUrl).toBe(
      "https://docs.switch.win/aggregator/request-api-key",
    );
    expect(f.preferKeyless).toBe("piteas_quote");
    expect(f.nextStep).toMatch(/not self-serve/i);
  });

  it("soft-fails on HTTP 429", async () => {
    const result = await getSwitchQuote(
      baseConfig,
      { tokenIn: "PLS", tokenOut: "eUSDC", amount: "1000" },
      {
        apiKey: "test-key",
        fetchImpl: async () =>
          ({
            ok: false,
            status: 429,
            json: async () => ({ error: "rate" }),
          }) as Response,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(429);
      expect(result.reason).toMatch(/rate limit/i);
    }
  });

  it("success path uses real URL builder + normalizer (mock fetch) and prepare", async () => {
    let hitUrl = "";
    let hitHeaders: HeadersInit | undefined;
    const result = await getSwitchQuote(
      baseConfig,
      {
        tokenIn: "PLS",
        tokenOut: USDC_FROM_ETH_ADDRESS,
        amount: "1000000000000000000",
        allowedSlippage: 0.5,
        sender: FIXTURE_SENDER,
      },
      {
        apiKey: "test-key-xyz",
        fetchImpl: async (url, init) => {
          hitUrl = String(url);
          hitHeaders = init?.headers;
          return {
            ok: true,
            status: 200,
            json: async () => fixtureBody(),
          } as Response;
        },
      },
    );
    expect(hitUrl).toContain("network=pulsechain");
    expect(hitUrl).toContain("from=");
    expect(hitUrl).toContain("amount=1000000000000000000");
    expect(hitUrl).toContain("slippage=50");
    const hdr = hitHeaders as Record<string, string>;
    expect(hdr["x-api-key"] ?? (hitHeaders as Headers)?.get?.("x-api-key")).toBeTruthy();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("switch");
      expect(result.advisory).toBe(true);
      expect(result.data.tx.to).toBe(FIXTURE_ROUTER);
      expect(result.data.tx.data).toBe(FIXTURE_CALLDATA);
      expect(result.data.amountOut).toBe("797600");
      const prep = prepareSwitchSwap(result.data);
      expect(prep.ok).toBe(true);
      if (prep.ok) {
        expect(prep.intent.data).toBe(result.data.tx.data);
        expect(prep.intent.to).toBe(result.data.tx.to);
        expect(prep.broadcast).toBe(false);
        expect(prep.intent.valuePls).toBe("1");
      }
    }
  });

  it("soft-fails when upstream omits usable tx and amountOut", async () => {
    const result = await getSwitchQuote(
      baseConfig,
      { tokenIn: "PLS", tokenOut: "eUSDC", amount: "1000", sender: FIXTURE_SENDER },
      {
        apiKey: "k",
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ expectedOutputAmount: "0" }),
          }) as Response,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/tx|amountOut|calldata/i);
    }
  });
});

describe("Switch tool registration", () => {
  it("registers switch_quote and switch_prepare_swap as RO analytics", () => {
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
      maxPlsPerTx: 100,
      maxPlsDaily: 1000,
      logLevel: "error" as const,
    };
    registerAllTools(server as never, cfg as AppConfig);
    expect(names).toContain("switch_quote");
    expect(names).toContain("switch_prepare_swap");
    expect(names).toContain("piteas_quote");
    const meta = getRegisteredTools();
    for (const n of ["switch_quote", "switch_prepare_swap"]) {
      const t = meta.find((m) => m.name === n);
      expect(t?.category).toBe("analytics");
      expect(t?.write).toBe(false);
      expect(t?.description).toMatch(/not|never|advisory|does NOT/i);
    }
    expect(meta.find((m) => m.name === "switch_quote")?.description).toMatch(
      /SWITCH_API_KEY|x-api-key|best-price|oracle/i,
    );
    expect(meta.find((m) => m.name === "switch_quote")?.description).toMatch(
      /operator-gated|not self-serve|request-api-key|piteas_quote/i,
    );
    expect(meta.find((m) => m.name === "switch_prepare_swap")?.description).toMatch(
      /piteas|SWITCH_API_KEY|request-api-key/i,
    );
    // 92 prior + switch_quote + switch_prepare_swap
    expect(meta.length).toBe(94);
  });
});
