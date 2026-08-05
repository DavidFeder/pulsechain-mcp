import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PiteasQuoteResult } from "../src/data/piteas.js";
import type { AppConfig } from "../src/types.js";
import {
  buildPiteasAccumulationPlan,
  registerPiteasAccumulationPlanTool,
  type PiteasAccumulationPlanDeps,
} from "../src/tools/analytics/piteasAccumulationPlan.js";
import { latestAdaptiveBatch } from "../src/tools/analytics/piteas-accumulation/adaptiveSearch.js";

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

const EUSDC = "0x15d38573d2feeb82e7ad5187ab8c1d52810b1f07";
const PHIAT = "0x96e035ae0905efac8f733f133462f971cfa45db1";
const ACCOUNT = "0x21957f94d6bb63fc2a2b110d16d07952899c6f11";
const CALLDATA = "0x8218b58f" + "00".repeat(96);
const WARNING =
  "Executing the first chunk changes pool and route state. Later chunks cannot be assumed to receive the same quote.";

function rawHuman(value: string, decimals = 18): string {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`).toString();
}

function quote(
  amountIn: string,
  outputTokensHuman: string,
  opts: {
    minOutHuman?: string;
    pathCount?: number;
    swapCount?: number;
    gasUsd?: number | null;
    gasUse?: number | null;
    impact?: number | null;
    blockNumber?: string | null;
    quoteTimestamp?: string | null;
    quoteIdentifier?: string | null;
    expiresAt?: string | null;
    responseFingerprint?: string | null;
    cacheHeaders?: Record<string, string> | null;
    endpoint?: string;
    retryCount?: number;
    protocols?: string[];
    pools?: string[];
    tokenPath?: string[];
    allocations?: Array<Record<string, unknown>>;
    routeSignature?: string;
  } = {},
): PiteasQuoteResult {
  const out = rawHuman(outputTokensHuman, 18);
  const minOut = rawHuman(opts.minOutHuman ?? outputTokensHuman, 18);
  const pathCount = opts.pathCount ?? 1;
  const swapCount = opts.swapCount ?? 1;
  const protocols = opts.protocols ?? ["PulseX"];
  const pools = opts.pools ?? ["0x0000000000000000000000000000000000000001"];
  const tokenPath = opts.tokenPath ?? [EUSDC, PHIAT];
  const allocations = opts.allocations ?? [];
  const routeSignature =
    opts.routeSignature ??
    JSON.stringify({
      protocols,
      pools,
      tokenPath: tokenPath.map((token) => token.toLowerCase()),
      router: "0x6bf228eb7f8ad948d37ded07e595efddfaaf88a6",
      fallbackStructure:
        protocols.length === 0 && pools.length === 0
          ? { pathCount, swapCount }
          : undefined,
    });
  return {
    ok: true,
    source: "piteas",
    advisory: true,
    data: {
      srcToken: { address: EUSDC, symbol: "eUSDC", decimals: 6, chainId: 369 },
      destToken: { address: PHIAT, symbol: "PHIAT", decimals: 18, chainId: 369 },
      amountIn,
      amountOut: out,
      amountOutMin: minOut,
      valueWei: "0",
      valuePls: "0",
      gasUseEstimate: opts.gasUse ?? 250000,
      gasUseEstimateUSD: "gasUsd" in opts ? opts.gasUsd! : 0.02,
      priceImpactPercent: opts.impact ?? null,
      blockNumber: opts.blockNumber === undefined ? "123" : opts.blockNumber,
      quoteTimestamp:
        opts.quoteTimestamp === undefined
          ? "2026-08-02T00:00:00.000Z"
          : opts.quoteTimestamp,
      quoteIdentifier: opts.quoteIdentifier ?? null,
      expiresAt: opts.expiresAt ?? null,
      responseFingerprint: opts.responseFingerprint ?? null,
      cacheHeaders: opts.cacheHeaders ?? null,
      endpoint: opts.endpoint ?? "https://sdk.piteas.io/quote",
      retryCount: opts.retryCount ?? 0,
      methodParameters: { calldata: CALLDATA, value: "0x0" },
      router: "0x6BF228eb7F8ad948d37deD07E595EfddfaAF88A6",
      route: {
        pathCount,
        swapCount,
        protocols,
        pools,
        tokenPath,
        router: "0x6BF228eb7F8ad948d37deD07E595EfddfaAF88A6",
        allocations,
        signature: routeSignature,
        note: "mock route summary",
      },
      tokenInParam: EUSDC,
      tokenOutParam: PHIAT,
      allowedSlippage: 0.5,
      account: ACCOUNT,
      chainId: 369,
      quoteReady: true,
      note: "mock quote",
      decodeNote: "mock decode note",
    },
  };
}

function quoteFailure(reason: string, status?: number): PiteasQuoteResult {
  return {
    ok: false,
    source: "piteas",
    reason,
    status,
    advisory: true,
  };
}

function depsFor(
  outputsByAmount: Record<string, PiteasQuoteResult | PiteasQuoteResult[]>,
  now?: () => Date,
): PiteasAccumulationPlanDeps {
  return {
    getPiteasQuote: vi.fn(async (_cfg, req) => {
      const fixture = outputsByAmount[req.amount];
      const result = Array.isArray(fixture) ? (fixture.shift() ?? fixture.at(-1)) : fixture;
      return (
        result ?? {
          ok: false,
          source: "piteas",
          reason: `missing fixture for ${req.amount}`,
          advisory: true,
        }
      );
    }),
    now,
  };
}

function clockedDepsFor(
  outputsByAmount: Record<string, PiteasQuoteResult | PiteasQuoteResult[]>,
  startMs = Date.parse("2026-08-02T00:00:00.000Z"),
  stepMs = 1000,
): PiteasAccumulationPlanDeps {
  let tick = 0;
  return depsFor(outputsByAmount, () => new Date(startMs + tick++ * stepMs));
}

function section<T extends Record<string, unknown>>(
  payload: Record<string, unknown>,
  key: string,
): T {
  return payload[key] as T;
}

describe("piteas_accumulation_plan", () => {
  it("uses verified eUSDC and PHIAT addresses and converts exact human decimals", async () => {
    const deps = depsFor({
      "1": quote("1", "0.000001"),
      "5000000": quote("5000000", "500"),
      "10000000": quote("10000000", "950"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC.toUpperCase().replace("0X", "0x"),
      phiatAddress: PHIAT,
      totalBudgetHuman: "10",
      quoteSizeLadderHuman: ["5", "0.000001", "10", "5"],
      eUsdcDecimals: 6,
      phiatDecimals: 18,
      account: ACCOUNT,
    }, deps);

    const request = section(plan, "request");
    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    expect(request.eUsdcAddress).toBe(EUSDC);
    expect(request.phiatAddress).toBe(PHIAT);
    expect(request.quoteSizeLadderHuman).toEqual(["0.000001", "5", "10"]);
    expect(points.map((point) => point.inputRaw)).toEqual(["1", "5000000", "10000000"]);
    expect(points[0]?.outputRaw).toBe("1000000000000");
    expect(points[1]?.minimumOutputHuman).toBe("500");
    expect(deps.getPiteasQuote).toHaveBeenCalledWith(baseConfig, expect.objectContaining({
      tokenIn: EUSDC,
      tokenOut: PHIAT,
      amount: "1",
      account: ACCOUNT,
    }));
  });

  it("accepts public tokenIn tokenOut and quoteSizesHuman aliases", async () => {
    const deps = depsFor({
      "5000000": quote("5000000", "500"),
      "10000000": quote("10000000", "950"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      tokenIn: EUSDC,
      tokenOut: PHIAT,
      totalBudgetHuman: "10",
      quoteSizesHuman: ["5"],
      eUsdcDecimals: 6,
      phiatDecimals: 18,
      maxPriceImpactPercent: 3,
      includeGasEstimate: true,
      confirmationMode: "individual_pairs",
      focusedRefresh: false,
    }, deps);

    const request = section(plan, "request");
    expect(request.tokenIn).toBe(EUSDC);
    expect(request.tokenOut).toBe(PHIAT);
    expect(request.eUsdcAddress).toBe(EUSDC);
    expect(request.phiatAddress).toBe(PHIAT);
    expect(request.quoteSizesHuman).toEqual(["5", "10"]);
    expect(request.quoteSizeLadderHuman).toEqual(["5", "10"]);
    expect(request.maxPriceImpactPercent).toBe(3);
    expect(request.priceImpactThresholdsPercent).toEqual([3]);
    expect(request.includeGasEstimate).toBe(true);
    expect(deps.getPiteasQuote).toHaveBeenCalledWith(baseConfig, expect.objectContaining({
      tokenIn: EUSDC,
      tokenOut: PHIAT,
      amount: "5000000",
    }));
  });

  it("rejects ambiguous USDC symbols before quote calls", async () => {
    const deps = depsFor({});
    await expect(
      buildPiteasAccumulationPlan(baseConfig, {
        eUsdcAddress: "USDC",
        phiatAddress: PHIAT,
        totalBudgetHuman: "10",
      }, deps),
    ).rejects.toThrow(/invalid address/i);
    expect(deps.getPiteasQuote).not.toHaveBeenCalled();
  });

  it("orders generated ladders and returns partial quote failures", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000"),
      "30000000": quote("30000000", "2700"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      confirmationMode: "individual_pairs",
    }, deps);

    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    const quality = section<{ partialFailures: unknown[]; warnings: string[] }>(plan, "dataQuality");
    expect(points.map((point) => point.inputHuman)).toEqual(["10", "20", "30"]);
    expect(points[1]?.quoteReady).toBe(false);
    expect(quality.partialFailures).toHaveLength(1);
    expect(quality.warnings).toContain(
      "One or more Piteas quote sizes failed; plan categories use partial results.",
    );
  });

  it("detects route changes and quote values spanning different blocks", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000", { pathCount: 1, swapCount: 1, blockNumber: "123" }),
      "20000000": quote("20000000", "1900", { pathCount: 2, swapCount: 3, blockNumber: "124" }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "20",
      chunkSizeHuman: "10",
    }, deps);

    const depth = section<Record<string, unknown>>(plan, "quotedMarketDepth");
    const routeChanges = depth.routeChanges as unknown[];
    const quality = section<{ warnings: string[] }>(plan, "dataQuality");
    expect(routeChanges).toHaveLength(1);
    expect(quality.warnings).toContain("Piteas route composition changes across the quote ladder.");
    expect(quality.warnings).toContain(
      "Quote values span different reported blocks; compare points with caution.",
    );
  });

  it("uses cumulative sequential approximation instead of multiplying the first chunk", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000"),
      "20000000": quote("20000000", "1900"),
      "30000000": quote("30000000", "2700"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      priceImpactThresholdsPercent: [99],
    }, deps);

    const independent = plan.independentQuoteComparison as Array<Record<string, unknown>>;
    const sequential = section<{ rows: Array<Record<string, unknown>>; estimatedOutputHuman: string }>(
      plan,
      "conservativeSequentialEstimate",
    );
    expect(independent[0]?.sameStateRepeatedOutputExcludingRemainderHuman).toBe("3000");
    expect(sequential.rows.map((row) => row.incrementalOutputHuman)).toEqual([
      "1000",
      "900",
      "800",
    ]);
    expect(sequential.estimatedOutputHuman).toBe("2700");
    expect((section<{ assumptions: string[] }>(plan, "dataQuality").assumptions)).toContain(
      "conservativeSequentialEstimate uses incrementalOutput(k) = Q(k * chunkSize) - Q((k - 1) * chunkSize) from the cumulative quote curve.",
    );
  });

  it("includes the same-state quote warning verbatim", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "10",
      quoteSizeLadderHuman: ["10"],
    }, deps);

    expect(section<{ warnings: string[] }>(plan, "dataQuality").warnings).toContain(WARNING);
    expect(section<{ warning: string }>(plan, "buySideDepthEstimate").warning).toBe(WARNING);
  });

  it("flags excessive gas for small chunks", async () => {
    const deps = depsFor({
      "1000000": quote("1000000", "100", { gasUsd: 0.25 }),
      "2000000": quote("2000000", "190", { gasUsd: 0.25 }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "2",
      chunkSizeHuman: "1",
      maxGasCostPercentOfChunk: 1,
    }, deps);

    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    expect(points[0]?.gasWarning).toMatch(/above the configured threshold/);
    expect(section<{ warnings: string[] }>(plan, "dataQuality").warnings).toContain(
      "One or more small chunks have excessive gas estimate relative to chunk size.",
    );
  });

  it("accepts high-precision Piteas gas USD estimates", async () => {
    const deps = depsFor({
      "50000000": quote("50000000", "5000", { gasUsd: 0.012934865122926572 }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "50",
      quoteSizeLadderHuman: ["50"],
      focusedRefresh: false,
    }, deps);

    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    expect(points[0]?.gasUseEstimateUSD).toBe(0.012934865122926572);
    expect(points[0]?.gasCostPercentOfChunk).toBe("0.02");
  });

  it("records price-impact threshold crossings", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000", { impact: 0.2 }),
      "20000000": quote("20000000", "1800", { impact: 2.5 }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "20",
      chunkSizeHuman: "10",
      priceImpactThresholdsPercent: [2],
    }, deps);

    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    const depth = section<{ thresholdCrossings: Array<Record<string, unknown>> }>(
      plan,
      "quotedMarketDepth",
    );
    expect(points[1]?.thresholdCrossed).toBe(true);
    expect(depth.thresholdCrossings[0]?.firstCrossedAtInputHuman).toBe("20");
  });

  it("applies the maximum-price stop rule", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000"),
      "20000000": quote("20000000", "500"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "20",
      chunkSizeHuman: "10",
      maximumAcceptableAveragePrice: "0.02",
      priceImpactThresholdsPercent: [99],
    }, deps);

    const sequential = section<{ rows: Array<Record<string, unknown>> }>(
      plan,
      "conservativeSequentialEstimate",
    );
    const staged = section<Record<string, Record<string, unknown>>>(plan, "plans").stagedEntryPlan;
    expect(sequential.rows[1]?.stopReasons).toContain("maximum_average_price_exceeded");
    expect((staged.stopConditions as string[]).join("\n")).toMatch(/average execution price exceeds 0\.02/);
    expect(staged.maximumAcceptableAveragePrice).toBe("0.02");
  });

  it("preserves null when USD gas values are unavailable", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000", { gasUsd: null }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "10",
      quoteSizeLadderHuman: ["10"],
    }, deps);

    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    expect(points[0]?.gasUseEstimateUSD).toBeNull();
    expect(points[0]?.gasCostPercentOfChunk).toBeNull();
    expect(section<{ warnings: string[] }>(plan, "dataQuality").warnings).toContain(
      "Piteas gasUseEstimateUSD was unavailable for one or more quote points.",
    );
  });

  it("classifies stitched retries and withholds recommendations when every source is stale", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000", { retryCount: 1 }),
      "20000000": quote("20000000", "1900", { retryCount: 1 }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "20",
      chunkSizeHuman: "10",
      focusedRefresh: false,
    }, deps);

    const snapshot = section<Record<string, unknown>>(plan, "quoteSnapshot");
    const coherence = section<Record<string, unknown>>(plan, "coherence");
    const plans = section<Record<string, unknown>>(plan, "plans");
    expect(snapshot.coherenceClass).toBe("stitched_multi_state");
    expect(snapshot.coherenceReasons).toContain("one or more quote points report retryCount > 0");
    expect(coherence.recommendationStatus).toBe("requote_required");
    expect(plans.recommendationStatus).toBe("requote_required");
  });

  it("marks excessive block spread as stitched multi-state", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000", { blockNumber: "100" }),
      "20000000": quote("20000000", "1900", { blockNumber: "105" }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "20",
      chunkSizeHuman: "10",
      maxSnapshotBlockSpread: 1,
      focusedRefresh: false,
    }, deps);

    const snapshot = section<Record<string, unknown>>(plan, "quoteSnapshot");
    expect(snapshot.minimumBlock).toBe("100");
    expect(snapshot.maximumBlock).toBe("105");
    expect(snapshot.blockSpread).toBe("5");
    expect(snapshot.coherenceClass).toBe("stitched_multi_state");
  });

  it("separates local clusters and labels better larger-size averages as discontinuities", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000", {
        protocols: ["PulseX"],
        pools: ["0x0000000000000000000000000000000000000001"],
        routeSignature: "route-a",
      }),
      "20000000": quote("20000000", "2500", {
        protocols: ["NineMM"],
        pools: ["0x0000000000000000000000000000000000000002"],
        routeSignature: "route-b",
      }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "20",
      chunkSizeHuman: "10",
      focusedRefresh: false,
    }, deps);

    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    const checks = section<Record<string, unknown>>(plan, "monotonicityChecks");
    const depth = section<{ localQuoteClusters: Array<Record<string, unknown>> }>(
      plan,
      "quotedMarketDepth",
    );
    expect(checks.averagePriceImprovedAtLargerSize).toBe(true);
    expect(checks.routeDiscontinuity).toBe(true);
    expect(depth.localQuoteClusters).toHaveLength(2);
    expect(points[1]?.marginalPriceScope).toBe("cluster_first_quote");
    expect(points[1]?.crossStateMarginalPriceExecutable).toBe(false);
    expect(points[1]?.crossStateMarginalPrice).not.toBeNull();
  });

  it("re-quotes a focused ladder around the broad decision boundary", async () => {
    const outputs: Record<string, PiteasQuoteResult> = {
      "50000000": quote("50000000", "5000"),
      "75000000": quote("75000000", "7350"),
      "100000000": quote("100000000", "9600"),
      "110000000": quote("110000000", "10450"),
      "120000000": quote("120000000", "11200"),
      "130000000": quote("130000000", "11950"),
      "140000000": quote("140000000", "12650"),
      "150000000": quote("150000000", "13000"),
    };
    const deps = depsFor(outputs);

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "600",
      quoteSizeLadderHuman: ["50", "150"],
      priceImpactThresholdsPercent: [1],
      focusedRefresh: true,
    }, deps);

    const focused = section<{
      quoteSizeLadderHuman: string[];
      complete: boolean;
      likelyDecisionBoundaryHuman: string;
    }>(plan, "focusedRefresh");
    expect(focused.likelyDecisionBoundaryHuman).toBe("150");
    expect(focused.quoteSizeLadderHuman).toEqual([
      "50",
      "75",
      "100",
      "110",
      "120",
      "130",
      "140",
      "150",
    ]);
    expect(focused.complete).toBe(true);
  });

  it("verifies telescoping equality and labels independent totals as non-sequential", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000"),
      "20000000": quote("20000000", "1900"),
      "30000000": quote("30000000", "2700"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      priceImpactThresholdsPercent: [99],
      focusedRefresh: false,
    }, deps);

    const sequential = section<Record<string, unknown>>(plan, "conservativeSequentialEstimate");
    const total = sequential.cumulativeCurveTotal as Record<string, unknown>;
    expect(total.outputHuman).toBe("2700");
    expect(sequential.sumOfIncrementalOutputsHuman).toBe("2700");
    expect(sequential.telescopingEqualityVerified).toBe(true);
    expect(sequential.independentRepeatedQuoteTotalHuman).toBe("3000");
    expect(sequential.independentTotalIsSequentialForecast).toBe(false);
  });

  it("allows recommendations from a coherent focused refresh even when broad discovery is stitched", async () => {
    const deps = depsFor({
      "50000000": [
        quote("50000000", "5000", { retryCount: 1 }),
        quote("50000000", "5000"),
      ],
      "150000000": [
        quote("150000000", "13000", { retryCount: 1 }),
        quote("150000000", "13000"),
      ],
      "75000000": quote("75000000", "7350"),
      "100000000": quote("100000000", "9600"),
      "110000000": quote("110000000", "10450"),
      "120000000": quote("120000000", "11200"),
      "130000000": quote("130000000", "11950"),
      "140000000": quote("140000000", "12650"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "600",
      quoteSizeLadderHuman: ["50", "150"],
      priceImpactThresholdsPercent: [1],
      focusedRefresh: true,
    }, deps);

    const broadSnapshot = section<Record<string, unknown>>(plan, "quoteSnapshot");
    const plans = section<Record<string, unknown>>(plan, "plans");
    expect(broadSnapshot.coherenceClass).toBe("stitched_multi_state");
    expect(plans.recommendationStatus).toBe("available");
    expect(plans.recommendationSource).toBe("focused_refresh");
  });

  it("returns first_quote_only instead of available for one coherent point", async () => {
    const deps = depsFor({
      "50000000": quote("50000000", "5000"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "50",
      quoteSizeLadderHuman: ["50"],
      focusedRefresh: false,
    }, deps);

    const plans = section<Record<string, Record<string, unknown>>>(plan, "plans");
    const staged = plans.stagedEntryPlan;
    expect(plans.recommendationStatus).toBe("first_quote_only");
    expect(plans.firstTrancheObservation).toMatchObject({
      inputHuman: "50",
      outputHuman: "5000",
      requoteRequiredBeforeExecution: true,
    });
    expect(staged.recommendedMaximumTranche).toBeNull();
    expect(staged).not.toHaveProperty("maximumTrancheUnderThresholdHuman");
  });

  it("keeps two coherent points at partial_boundary without a marginal trend", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000"),
      "20000000": quote("20000000", "1900"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "20",
      chunkSizeHuman: "10",
      priceImpactThresholdsPercent: [99],
      focusedRefresh: false,
    }, deps);

    const plans = section<{
      recommendationStatus: string;
      recommendationEvidence: Record<string, unknown>;
      recommendedMaximumTranche: unknown;
    }>(plan, "plans");
    expect(plans.recommendationStatus).toBe("partial_boundary");
    expect(plans.recommendationEvidence.hasAveragePriceTrend).toBe(false);
    expect(plans.recommendationEvidence.hasMarginalCurve).toBe(false);
    expect(plans.recommendedMaximumTranche).toBeNull();
  });

  it("requires a bracket before recommending a maximum tranche", async () => {
    const unbracketed = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      priceImpactThresholdsPercent: [99],
      focusedRefresh: false,
    }, depsFor({
      "10000000": quote("10000000", "1000"),
      "20000000": quote("20000000", "1900"),
      "30000000": quote("30000000", "2700"),
    }));
    const unbracketedPlans = section<Record<string, Record<string, unknown>>>(
      unbracketed,
      "plans",
    );
    expect(unbracketedPlans.recommendationStatus).toBe("partial_boundary");
    expect(unbracketedPlans.thresholdBoundaryBracketed).toBe(false);
    expect(unbracketedPlans.largestObservedBelowThreshold).toMatchObject({
      inputHuman: "30",
    });
    expect(unbracketedPlans.recommendedMaximumTranche).toBeNull();

    const bracketed = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, depsFor({
      "10000000": quote("10000000", "1000"),
      "20000000": quote("20000000", "1800"),
      "30000000": quote("30000000", "2500"),
    }));
    const bracketedPlans = section<Record<string, Record<string, unknown>>>(
      bracketed,
      "plans",
    );
    expect(bracketedPlans.recommendationStatus).toBe("available");
    expect(bracketedPlans.thresholdBoundaryBracketed).toBe(true);
    expect(bracketedPlans.largestObservedBelowThreshold).toMatchObject({
      inputHuman: "10",
    });
    expect(bracketedPlans.firstObservedAboveThreshold).toMatchObject({
      inputHuman: "20",
    });
    expect(bracketedPlans.recommendedMaximumTranche).toMatchObject({
      inputHuman: "10",
    });
  });

  it("keeps a structurally unchanged route clustered when only allocations change", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000", {
        allocations: [{ percent: "50000", protocol: "PulseX" }],
      }),
      "20000000": quote("20000000", "1900", {
        allocations: [{ percent: "60000", protocol: "PulseX" }],
      }),
      "30000000": quote("30000000", "2700", {
        allocations: [{ percent: "70000", protocol: "PulseX" }],
      }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      priceImpactThresholdsPercent: [99],
      focusedRefresh: false,
    }, deps);

    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    const depth = section<{ localQuoteClusters: Array<Record<string, unknown>>; routeChanges: Array<Record<string, unknown>> }>(
      plan,
      "quotedMarketDepth",
    );
    expect(depth.localQuoteClusters).toHaveLength(1);
    expect(points[1]?.routeChangedFromPreviousQuote).toBe(false);
    expect(points[1]?.routeChangeDetails).toMatchObject({
      structuralRouteChanged: false,
      allocationChanged: true,
      onlyEconomicValuesChanged: true,
    });
    expect(depth.routeChanges[0]?.routeChangeDetails).toMatchObject({
      allocationChanged: true,
    });
  });

  it("excludes dynamic quote amounts from the structural route signature", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000"),
      "20000000": quote("20000000", "1900"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "20",
      chunkSizeHuman: "10",
      focusedRefresh: false,
    }, deps);

    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    expect(points[0]?.structuralRouteSignature).toBe(points[1]?.structuralRouteSignature);
    expect(points[0]?.economicRouteFingerprint).not.toBe(points[1]?.economicRouteFingerprint);
    expect(points[1]?.routeChangeDetails).toMatchObject({
      structuralRouteChanged: false,
      onlyEconomicValuesChanged: true,
    });
  });

  it("does not split every quote on low-confidence fallback metadata alone", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000", { protocols: [], pools: [], pathCount: 1 }),
      "20000000": quote("20000000", "1900", { protocols: [], pools: [], pathCount: 2 }),
      "30000000": quote("30000000", "2700", { protocols: [], pools: [], pathCount: 3 }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      focusedRefresh: false,
    }, deps);

    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    const depth = section<{ localQuoteClusters: Array<Record<string, unknown>> }>(
      plan,
      "quotedMarketDepth",
    );
    const plans = section<{ recommendationStatus: string; recommendationEvidence: Record<string, unknown> }>(
      plan,
      "plans",
    );
    expect(depth.localQuoteClusters).toHaveLength(1);
    expect(points[1]?.routeSignatureConfidence).toBe("low");
    expect(points[1]?.routeChangedFromPreviousQuote).toBe(false);
    expect(plans.recommendationStatus).toBe("available");
    expect(plans.recommendationBasis).toBe("best_route_envelope");
    expect(plans.recommendationEvidence.routeConfidence).toBe("low");
  });

  it("propagates candidateChunkCounts through the MCP schema and handler", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000"),
    });
    const registrations = new Map<
      string,
      {
        meta: { inputSchema: { safeParse: (value: unknown) => { success: boolean } } };
        cb: (args?: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        }>;
      }
    >();
    const server = {
      registerTool: (name: string, meta: unknown, cb: unknown) => {
        registrations.set(name, {
          meta: meta as { inputSchema: { safeParse: (value: unknown) => { success: boolean } } },
          cb: cb as (args?: Record<string, unknown>) => Promise<{
            content: Array<{ type: string; text: string }>;
            isError?: boolean;
          }>,
        });
      },
    };

    registerPiteasAccumulationPlanTool(server as never, baseConfig, deps);
    const registration = registrations.get("piteas_accumulation_plan")!;
    expect(registration.meta.inputSchema.safeParse({
      tokenIn: EUSDC,
      tokenOut: PHIAT,
      totalBudgetHuman: "10",
      quoteSizesHuman: ["10"],
      candidateChunkCounts: [4, 2, 4],
      maxPriceImpactPercent: 3,
      includeGasEstimate: true,
    }).success).toBe(true);
    expect(registration.meta.inputSchema.safeParse({
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "10",
      quoteSizeLadderHuman: ["10"],
      candidateChunkCounts: [4, 2, 4],
      confirmationMode: "adaptive",
      referenceAmountCandidatesHuman: ["5", "10"],
      confirmationCandidateSizesHuman: ["10"],
      maximumBatchWindowMs: 45_000,
      maximumReferenceDriftPercent: 0.5,
      quoteConcurrency: 2,
      maximumAdaptiveRounds: 3,
      maximumBracketWidthHuman: "5",
    }).success).toBe(true);
    expect(registration.meta.inputSchema.safeParse({
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "10",
      candidateChunkCounts: [2.5],
    }).success).toBe(false);
    expect(registration.meta.inputSchema.safeParse({
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "10",
      quoteConcurrency: 99,
    }).success).toBe(false);

    const response = await registration.cb({
      tokenIn: EUSDC,
      tokenOut: PHIAT,
      totalBudgetHuman: "10",
      quoteSizesHuman: ["10"],
      candidateChunkCounts: [4, 2, 4],
      maxPriceImpactPercent: 3,
      includeGasEstimate: false,
      confirmationMode: "individual_pairs",
      focusedRefresh: false,
    });
    const body = JSON.parse(response.content[0]!.text) as {
      ok: boolean;
      data: { request: Record<string, unknown> };
    };
    expect(response.isError).toBeFalsy();
    expect(body.ok).toBe(true);
    expect(body.data.request.tokenIn).toBe(EUSDC);
    expect(body.data.request.tokenOut).toBe(PHIAT);
    expect(body.data.request.quoteSizesHuman).toEqual(["10"]);
    expect(body.data.request.maxPriceImpactPercent).toBe(3);
    expect(body.data.request.priceImpactThresholdsPercent).toEqual([3]);
    expect(body.data.request.includeGasEstimate).toBe(false);
    expect(body.data.request.candidateChunkCounts).toEqual([2, 4]);
    expect(body.data.request.confirmationMode).toBe("individual_pairs");
  });

  it("does not return available when the focused refresh is incomplete", async () => {
    const quoteFailure: PiteasQuoteResult = {
      ok: false,
      source: "piteas",
      reason: "mock focused failure",
      advisory: true,
    };
    const deps = depsFor({
      "10000000": [
        quote("10000000", "1000"),
        quote("10000000", "1000"),
      ],
      "20000000": [
        quote("20000000", "1800"),
        quoteFailure,
      ],
      "30000000": [
        quote("30000000", "2500"),
        quote("30000000", "2500"),
      ],
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      focusedQuoteLadderHuman: ["10", "20", "30"],
      priceImpactThresholdsPercent: [5],
      focusedRefresh: true,
    }, deps);

    const plans = section<{ recommendationStatus: string; recommendationEvidence: Record<string, unknown> }>(
      plan,
      "plans",
    );
    expect(section<Record<string, unknown>>(plan, "focusedRefresh").focusedRefreshStatus)
      .toBe("incomplete");
    expect(plans.recommendationStatus).toBe("available");
    expect(plans.recommendationBasis).toBe("best_route_envelope");
    expect(plans.recommendationEvidence.focusedRefreshStatus).toBe("incomplete");
    expect(plans.recommendedMaximumTranche).toMatchObject({ inputHuman: "10" });
  });

  it("keeps different best routes in one envelope and brackets cross-route thresholds", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000", {
        protocols: ["PulseX"],
        pools: ["0x0000000000000000000000000000000000000001"],
      }),
      "20000000": quote("20000000", "1800", {
        protocols: ["NineMM"],
        pools: ["0x0000000000000000000000000000000000000002"],
      }),
      "30000000": quote("30000000", "2500", {
        protocols: ["Phux"],
        pools: ["0x0000000000000000000000000000000000000003"],
      }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, deps);

    const envelope = section<{
      points: Array<Record<string, unknown>>;
      routeChanges: unknown[];
      bestRouteThresholdBoundaryBracketed: boolean;
      bestRouteRecommendedMaximumTranche: Record<string, unknown> | null;
      envelopeMarginalCurve: Array<Record<string, unknown>>;
    }>(plan, "bestRouteEnvelope");
    const routeLocal = section<{ localQuoteClusters: unknown[] }>(plan, "routeLocalCurves");
    const plans = section<Record<string, unknown>>(plan, "plans");

    expect(envelope.points.map((point) => point.inputHuman)).toEqual(["10", "20", "30"]);
    expect(envelope.routeChanges).toHaveLength(2);
    expect(routeLocal.localQuoteClusters).toHaveLength(3);
    expect(envelope.bestRouteThresholdBoundaryBracketed).toBe(true);
    expect(envelope.bestRouteRecommendedMaximumTranche).toMatchObject({ inputHuman: "10" });
    expect(envelope.envelopeMarginalCurve[1]).toMatchObject({
      envelopeMarginalIsSequentialForecast: false,
      scope: "cross_route_envelope",
    });
    expect(plans.recommendationStatus).toBe("available");
    expect(plans.recommendationBasis).toBe("best_route_envelope");
  });

  it("allows route changes inside paired quotes and prioritizes paired recommendations", async () => {
    const deps = depsFor({
      "30000000": quote("30000000", "2500"),
      "5000000": [
        quote("5000000", "500", {
          protocols: ["PulseX"],
          pools: ["0x0000000000000000000000000000000000000001"],
        }),
        quote("5000000", "500", {
          protocols: ["PulseX"],
          pools: ["0x0000000000000000000000000000000000000001"],
        }),
        quote("5000000", "500", {
          protocols: ["PulseX"],
          pools: ["0x0000000000000000000000000000000000000001"],
        }),
        quote("5000000", "500", {
          protocols: ["PulseX"],
          pools: ["0x0000000000000000000000000000000000000001"],
        }),
      ],
      "10000000": [
        quote("10000000", "990", {
          protocols: ["NineMM"],
          pools: ["0x0000000000000000000000000000000000000002"],
        }),
        quote("10000000", "990", {
          protocols: ["NineMM"],
          pools: ["0x0000000000000000000000000000000000000002"],
        }),
      ],
      "20000000": [
        quote("20000000", "1700", {
          protocols: ["Phux"],
          pools: ["0x0000000000000000000000000000000000000003"],
        }),
        quote("20000000", "1700", {
          protocols: ["Phux"],
          pools: ["0x0000000000000000000000000000000000000003"],
        }),
      ],
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      pairedReferenceAmountHuman: "5",
      pairedCandidateSizesHuman: ["10", "20"],
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, deps);

    const paired = section<{ pairs: Array<Record<string, unknown>> }>(
      plan,
      "pairedReferenceAnalysis",
    );
    const plans = section<Record<string, unknown>>(plan, "plans");
    expect(paired.pairs).toHaveLength(2);
    expect(paired.pairs[0]).toMatchObject({
      routeChangedWithinPair: true,
      pairUsable: true,
    });
    expect(plans.recommendationStatus).toBe("available");
    expect(plans.recommendationBasis).toBe("paired_reference");
    expect(plans.recommendedMaximumTranche).toMatchObject({
      inputHuman: "10",
      pairedReferenceDeteriorationPercent: "1.01",
    });
  });

  it("uses local paired references so long-run drift does not drive deterioration", async () => {
    const deps = depsFor({
      "30000000": quote("30000000", "2500"),
      "5000000": [
        quote("5000000", "500"),
        quote("5000000", "500"),
        quote("5000000", "250"),
        quote("5000000", "250"),
      ],
      "10000000": [
        quote("10000000", "950"),
        quote("10000000", "950"),
      ],
      "20000000": [
        quote("20000000", "1000"),
        quote("20000000", "1000"),
      ],
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      pairedReferenceAmountHuman: "5",
      pairedCandidateSizesHuman: ["10", "20"],
      priceImpactThresholdsPercent: [10],
      focusedRefresh: false,
    }, deps);

    const paired = section<{ pairs: Array<Record<string, unknown>> }>(
      plan,
      "pairedReferenceAnalysis",
    );
    expect(paired.pairs[0]?.pairedReferenceDeteriorationPercent).toBe("5.26");
    expect(paired.pairs[1]?.referenceAveragePrice).toBe("0.02");
    expect(paired.pairs[1]?.pairedReferenceDeteriorationPercent).toBe("0");
  });

  it("invalidates only the pair whose reference quote fails", async () => {
    const failed: PiteasQuoteResult = {
      ok: false,
      source: "piteas",
      reason: "mock reference outage",
      advisory: true,
    };
    const deps = depsFor({
      "30000000": quote("30000000", "2500"),
      "5000000": [
        failed,
        quote("5000000", "500"),
        quote("5000000", "500"),
        quote("5000000", "500"),
      ],
      "10000000": [
        quote("10000000", "990"),
        quote("10000000", "990"),
      ],
      "20000000": [
        quote("20000000", "1700"),
        quote("20000000", "1700"),
      ],
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      pairedReferenceAmountHuman: "5",
      pairedCandidateSizesHuman: ["10", "20"],
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, deps);

    const paired = section<{
      pairs: Array<Record<string, unknown>>;
      partialFailures: unknown[];
    }>(plan, "pairedReferenceAnalysis");
    expect(paired.pairs[0]).toMatchObject({
      pairUsable: false,
      pairFailureReason: "reference_quote_failed",
    });
    expect(paired.pairs[1]).toMatchObject({ pairUsable: true });
    expect(paired.partialFailures).toHaveLength(1);
  });

  it("collects batch-sandwich reference before and after with usable candidate deterioration", async () => {
    const deps = depsFor({
      "30000000": quote("30000000", "2500"),
      "5000000": [
        quote("5000000", "500"),
        quote("5000000", "500"),
      ],
      "10000000": quote("10000000", "990"),
      "20000000": quote("20000000", "1700"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["10", "20"],
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, deps);

    const batch = section<{
      selectedReferenceAmountHuman: string;
      referenceBefore: Record<string, unknown>;
      referenceAfter: Record<string, unknown>;
      temporallyUsable: boolean;
      candidateResults: Array<Record<string, unknown>>;
    }>(plan, "batchConfirmation");
    const plans = section<Record<string, unknown>>(plan, "plans");
    expect(batch.selectedReferenceAmountHuman).toBe("5");
    expect(batch.referenceBefore.quoteReady).toBe(true);
    expect(batch.referenceAfter.quoteReady).toBe(true);
    expect(batch.temporallyUsable).toBe(true);
    expect(batch.candidateResults).toHaveLength(2);
    expect(batch.candidateResults[0]).toMatchObject({
      inputHuman: "10",
      batchReferenceDeteriorationPercent: "1.01",
      belowThreshold: true,
    });
    expect(batch.candidateResults[1]).toMatchObject({
      inputHuman: "20",
      belowThreshold: false,
    });
    expect(plans.recommendationStatus).toBe("available");
    expect(plans.recommendationBasis).toBe("batch_sandwich");
    expect(plans.recommendedMaximumTranche).toMatchObject({ inputHuman: "10" });
  });

  it("detects identical independent references with strong freshness metadata", async () => {
    const deps = depsFor({
      "30000000": quote("30000000", "2500"),
      "5000000": [
        quote("5000000", "500", {
          blockNumber: null,
          quoteTimestamp: null,
          quoteIdentifier: "before-id",
          responseFingerprint: "same-body",
        }),
        quote("5000000", "500", {
          blockNumber: null,
          quoteTimestamp: null,
          quoteIdentifier: "after-id",
          responseFingerprint: "same-body",
        }),
      ],
      "10000000": quote("10000000", "990"),
      "20000000": quote("20000000", "1700"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["10", "20"],
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, deps);

    const batch = section<Record<string, unknown>>(plan, "batchConfirmation");
    const plans = section<Record<string, unknown>>(plan, "plans");
    expect(batch.referenceEqualityDetected).toBe(true);
    expect(batch.quoteIdentifierBefore).toBe("before-id");
    expect(batch.quoteIdentifierAfter).toBe("after-id");
    expect(batch.freshnessConfidence).toBe("high");
    expect(batch.possibleCacheDetected).toBe(false);
    expect(batch.temporallyUsable).toBe(true);
    expect(plans.recommendationStatus).toBe("available");
  });

  it("treats identical references with no freshness metadata as possible cache", async () => {
    const deps = depsFor({
      "30000000": quote("30000000", "2500"),
      "5000000": [
        quote("5000000", "500", {
          blockNumber: null,
          quoteTimestamp: null,
          responseFingerprint: "same-body",
        }),
        quote("5000000", "500", {
          blockNumber: null,
          quoteTimestamp: null,
          responseFingerprint: "same-body",
        }),
      ],
      "10000000": quote("10000000", "990"),
      "20000000": quote("20000000", "1700"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["10", "20"],
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, deps);

    const batch = section<Record<string, unknown>>(plan, "batchConfirmation");
    expect(batch.referenceEqualityDetected).toBe(true);
    expect(batch.freshnessConfidence).toBe("low");
    expect(batch.possibleCacheDetected).toBe(true);
    expect(batch.failureReasons).toContain("low_confidence_reference_freshness");
    expect(batch.temporallyUsable).toBe(false);
  });

  it("withholds recommendations when possible-cache freshness is not permitted", async () => {
    const deps = depsFor({
      "30000000": quote("30000000", "2500"),
      "5000000": [
        quote("5000000", "500", {
          blockNumber: null,
          quoteTimestamp: null,
          responseFingerprint: "same-body",
        }),
        quote("5000000", "500", {
          blockNumber: null,
          quoteTimestamp: null,
          responseFingerprint: "same-body",
        }),
      ],
      "10000000": quote("10000000", "990"),
      "20000000": quote("20000000", "1700"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["10", "20"],
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, deps);

    const plans = section<Record<string, unknown>>(plan, "plans");
    const quality = section<{ warnings: string[] }>(plan, "dataQuality");
    expect(plans.recommendationBasis).not.toBe("batch_sandwich");
    expect(plans.recommendationStatus).not.toBe("available");
    expect(quality.warnings.some((warning) =>
      warning.includes("identical without independent freshness metadata"),
    )).toBe(true);
  });

  it("returns concurrency-aware batch timing estimates", async () => {
    const deps = clockedDepsFor({
      "50000000": quote("50000000", "4000"),
      "5000000": [
        quote("5000000", "500"),
        quote("5000000", "500"),
      ],
      "10000000": quote("10000000", "990"),
      "20000000": quote("20000000", "1850"),
      "30000000": quote("30000000", "2600"),
      "40000000": quote("40000000", "3300"),
    }, Date.parse("2026-08-02T00:00:00.000Z"), 1000);

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "50",
      quoteSizeLadderHuman: ["50"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["10", "20", "30", "40"],
      quoteConcurrency: 2,
      focusedRefresh: false,
    }, deps);

    const batch = section<Record<string, unknown>>(plan, "batchConfirmation");
    expect(batch.estimatedCriticalPathMs).toBe(6000);
    expect(batch.configuredMaximumBatchWindowMs).toBe(45000);
    expect(batch.timingMarginMs).toBe(39000);
    expect(batch.timingEstimateMethod).toBe(
      "referenceBeforeLatency + ceil(candidateCount / concurrency) * candidateMedianLatency + referenceAfterLatency",
    );
  });

  it("rounds a 116.666666 analytical amount down to 110 with a 10 eUSDC increment", async () => {
    const deps = depsFor({
      "125000000": quote("125000000", "11904.761904"),
      "5000000": [
        quote("5000000", "500"),
        quote("5000000", "500"),
      ],
      "110000000": quote("110000000", "10891.089108"),
      "116666666": quote("116666666", "11437.908431"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "125",
      quoteSizeLadderHuman: ["125"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["110", "116.666666", "125"],
      priceImpactThresholdsPercent: [3],
      trancheIncrementHuman: "10",
      operationalSafetyBufferPercent: 0,
      focusedRefresh: false,
    }, deps);

    const operational = section<Record<string, unknown>>(plan, "operationalTranchePlan");
    const plans = section<Record<string, unknown>>(plan, "plans");
    expect(operational.analyticalMaximumBelowThresholdHuman).toBe("116.666666");
    expect(operational.bufferedMaximumHuman).toBe("116.666666");
    expect(operational.operationalMaximumTrancheHuman).toBe("110");
    expect(plans.operationalMaximumTrancheHuman).toBe("110");
  });

  it("supports configurable 5 and 10 eUSDC operational increments", async () => {
    const build = (trancheIncrementHuman: string) =>
      buildPiteasAccumulationPlan(baseConfig, {
        eUsdcAddress: EUSDC,
        phiatAddress: PHIAT,
        totalBudgetHuman: "125",
        quoteSizeLadderHuman: ["125"],
        confirmationMode: "batch_sandwich",
        referenceAmountCandidatesHuman: ["5"],
        confirmationCandidateSizesHuman: ["110", "116.666666", "125"],
        priceImpactThresholdsPercent: [3],
        trancheIncrementHuman,
        operationalSafetyBufferPercent: 0,
        focusedRefresh: false,
      }, depsFor({
        "125000000": quote("125000000", "11904.761904"),
        "5000000": [
          quote("5000000", "500"),
          quote("5000000", "500"),
        ],
        "110000000": quote("110000000", "10891.089108"),
        "116666666": quote("116666666", "11437.908431"),
      }));

    const five = section<Record<string, unknown>>(
      await build("5"),
      "operationalTranchePlan",
    );
    const ten = section<Record<string, unknown>>(
      await build("10"),
      "operationalTranchePlan",
    );
    expect(five.operationalMaximumTrancheHuman).toBe("115");
    expect(ten.operationalMaximumTrancheHuman).toBe("110");
  });

  it("applies the operational safety buffer before tranche rounding", async () => {
    const deps = depsFor({
      "125000000": quote("125000000", "11904.761904"),
      "5000000": [
        quote("5000000", "500"),
        quote("5000000", "500"),
      ],
      "110000000": quote("110000000", "10891.089108"),
      "116666666": quote("116666666", "11348.249611"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "125",
      quoteSizeLadderHuman: ["125"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["110", "116.666666", "125"],
      priceImpactThresholdsPercent: [3],
      trancheIncrementHuman: "5",
      operationalSafetyBufferPercent: 0.5,
      focusedRefresh: false,
    }, deps);

    const operational = section<Record<string, unknown>>(plan, "operationalTranchePlan");
    const guardrails = section<Record<string, unknown>>(plan, "guardrails");
    expect(operational.analyticalMaximumBelowThresholdHuman).toBe("116.666666");
    expect(operational.bufferedMaximumHuman).toBe("110");
    expect(operational.operationalMaximumTrancheHuman).toBe("110");
    expect(operational.analyticalThresholdPercent).toBe("3");
    expect(operational.operationalThresholdPercent).toBe("2.5");
    expect(guardrails).toMatchObject({
      proposedTrancheHuman: "110",
      maximumAllowedDeteriorationPercent: "2.5",
      minimumOutputMustBePresent: true,
      requoteBeforeEveryExecution: true,
      reusableQuoteAllowed: false,
    });
  });

  it("rejects high reference drift and withholds batch recommendations", async () => {
    const deps = depsFor({
      "30000000": quote("30000000", "2500"),
      "5000000": [
        quote("5000000", "500"),
        quote("5000000", "400"),
      ],
      "10000000": quote("10000000", "990"),
      "20000000": quote("20000000", "1700"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["10", "20"],
      maximumReferenceDriftPercent: 0.5,
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, deps);

    const batch = section<Record<string, unknown>>(plan, "batchConfirmation");
    const plans = section<Record<string, unknown>>(plan, "plans");
    expect(batch.temporallyUsable).toBe(false);
    expect(batch.failureReasons).toContain("reference_drift_exceeded");
    expect(plans.recommendationBasis).not.toBe("batch_sandwich");
    expect(plans.recommendationStatus).not.toBe("available");
  });

  it("falls back from a failed 5 eUSDC reference to a valid 10 eUSDC reference", async () => {
    const deps = depsFor({
      "30000000": [
        quote("30000000", "2500"),
        quote("30000000", "2500"),
        quote("30000000", "2500"),
      ],
      "5000000": quoteFailure("mock tiny reference failure"),
      "10000000": [
        quote("10000000", "1000"),
        quote("10000000", "1000"),
      ],
      "20000000": [
        quote("20000000", "1700"),
        quote("20000000", "1700"),
      ],
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5", "10"],
      confirmationCandidateSizesHuman: ["20", "30"],
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, deps);

    const batch = section<{
      selectedReferenceAmountHuman: string;
      rejectedReferenceAmounts: Array<Record<string, unknown>>;
      temporallyUsable: boolean;
    }>(plan, "batchConfirmation");
    expect(batch.selectedReferenceAmountHuman).toBe("10");
    expect(batch.rejectedReferenceAmounts).toHaveLength(1);
    expect(batch.rejectedReferenceAmounts[0]).toMatchObject({
      referenceAmountHuman: "5",
    });
    expect(batch.temporallyUsable).toBe(true);
  });

  it("bounds batch candidate concurrency", async () => {
    const fixtures: Record<string, PiteasQuoteResult | PiteasQuoteResult[]> = {
      "50000000": quote("50000000", "4000"),
      "5000000": [
        quote("5000000", "500"),
        quote("5000000", "500"),
      ],
      "10000000": quote("10000000", "990"),
      "20000000": quote("20000000", "1850"),
      "30000000": quote("30000000", "2600"),
      "40000000": quote("40000000", "3300"),
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const deps: PiteasAccumulationPlanDeps = {
      getPiteasQuote: vi.fn(async (_cfg, req) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const fixture = fixtures[req.amount];
        const result = Array.isArray(fixture)
          ? (fixture.shift() ?? fixture.at(-1))
          : fixture;
        inFlight -= 1;
        return result ?? quoteFailure(`missing fixture for ${req.amount}`);
      }),
    };

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "50",
      quoteSizeLadderHuman: ["50"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["10", "20", "30", "40"],
      quoteConcurrency: 2,
      focusedRefresh: false,
    }, deps);

    const batch = section<Record<string, unknown>>(plan, "batchConfirmation");
    expect(batch.candidateConcurrency).toBe(2);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("retries discovery failures but not confirmation quotes and records reliability metrics", async () => {
    const deps = {
      ...depsFor({
        "30000000": [
          quoteFailure("request timed out"),
          quote("30000000", "2500"),
        ],
        "5000000": [
          quote("5000000", "500"),
          quote("5000000", "500"),
        ],
        "10000000": quote("10000000", "990"),
        "20000000": quoteFailure("HTTP 500 from Piteas", 500),
      }),
      sleep: vi.fn(async () => undefined),
    };

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["10", "20"],
      quoteConcurrency: 2,
      focusedRefresh: false,
    }, deps);

    const batch = section<{ candidateResults: Array<Record<string, Record<string, unknown>>> }>(
      plan,
      "batchConfirmation",
    );
    const failedCandidate = batch.candidateResults[1]!;
    const reliability = section<Record<string, unknown>>(plan, "piteasReliability");
    expect(reliability.retryCount).toBe(1);
    expect(reliability.timeoutCount).toBe(1);
    expect(reliability.http500Count).toBe(1);
    expect((failedCandidate.quote.attempts as unknown[])).toHaveLength(1);
    expect(failedCandidate.candidateFailureReason).toBe("HTTP 500 from Piteas");
  });

  it("allows missing block metadata and route changes inside batch candidate comparisons", async () => {
    const deps = depsFor({
      "30000000": quote("30000000", "2500", { blockNumber: null, quoteTimestamp: null }),
      "5000000": [
        quote("5000000", "500", {
          blockNumber: null,
          quoteTimestamp: null,
          protocols: ["PulseX"],
          pools: ["0x0000000000000000000000000000000000000001"],
        }),
        quote("5000000", "500", {
          blockNumber: null,
          quoteTimestamp: null,
          protocols: ["PulseX"],
          pools: ["0x0000000000000000000000000000000000000001"],
        }),
      ],
      "10000000": quote("10000000", "990", {
        blockNumber: null,
        quoteTimestamp: null,
        protocols: ["NineMM"],
        pools: ["0x0000000000000000000000000000000000000002"],
      }),
      "20000000": quote("20000000", "1700", {
        blockNumber: null,
        quoteTimestamp: null,
        protocols: ["Phux"],
        pools: ["0x0000000000000000000000000000000000000003"],
      }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["10", "20"],
      priceImpactThresholdsPercent: [5],
      focusedRefresh: false,
    }, deps);

    const batch = section<{
      temporallyUsable: boolean;
      candidateResults: Array<Record<string, unknown>>;
    }>(plan, "batchConfirmation");
    expect(batch.temporallyUsable).toBe(true);
    expect(batch.candidateResults[0]).toMatchObject({
      routeChangedFromReference: true,
    });
  });

  it("narrows an adaptive batch-sandwich bracket and prioritizes that recommendation", async () => {
    const deps = depsFor({
      "50000000": quote("50000000", "5000"),
      "150000000": quote("150000000", "14200"),
      "600000000": quote("600000000", "40000"),
      "5000000": [
        quote("5000000", "500"),
        quote("5000000", "500"),
      ],
      "75000000": quote("75000000", "7300"),
      "90000000": quote("90000000", "8500"),
      "105000000": quote("105000000", "9700"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "600",
      quoteSizeLadderHuman: ["50", "150", "600"],
      confirmationMode: "adaptive",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["75", "90", "105"],
      maximumBracketWidthHuman: "20",
      priceImpactThresholdsPercent: [3],
      focusedRefresh: false,
    }, deps);

    const adaptive = section<{
      terminationReason: string;
      thresholdBoundaryBracketed: boolean;
      recommendedMaximumTranche: Record<string, unknown> | null;
      rounds: Array<Record<string, unknown>>;
    }>(plan, "adaptiveThresholdSearch");
    const plans = section<Record<string, unknown>>(plan, "plans");
    expect(adaptive.rounds).toHaveLength(1);
    expect(adaptive.terminationReason).toBe("bracket_width_reached");
    expect(adaptive.thresholdBoundaryBracketed).toBe(true);
    expect(adaptive.recommendedMaximumTranche).toMatchObject({ inputHuman: "75" });
    expect(plans.recommendationStatus).toBe("available");
    expect(plans.recommendationBasis).toBe("adaptive_batch_sandwich");
  });

  it("warns when the configured timing window is impossible from observed latency", async () => {
    const deps = clockedDepsFor({
      "30000000": quote("30000000", "2500"),
      "5000000": [
        quote("5000000", "500"),
        quote("5000000", "500"),
      ],
      "10000000": quote("10000000", "990"),
      "20000000": quote("20000000", "1700"),
    }, Date.parse("2026-08-02T00:00:00.000Z"), 1000);

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      quoteSizeLadderHuman: ["30"],
      confirmationMode: "batch_sandwich",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["10", "20"],
      maximumBatchWindowMs: 1000,
      focusedRefresh: false,
    }, deps);

    const quality = section<{ warnings: string[] }>(plan, "dataQuality");
    expect(quality.warnings.some((warning) =>
      warning.includes("Configured batch-sandwich window may be impossible"),
    )).toBe(true);
  });

  it("does not inherit route-change stops at the first point in a new route-local cluster", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000", {
        protocols: ["PulseX"],
        pools: ["0x0000000000000000000000000000000000000001"],
      }),
      "20000000": quote("20000000", "1800", {
        protocols: ["NineMM"],
        pools: ["0x0000000000000000000000000000000000000002"],
      }),
      "30000000": quote("30000000", "2500", {
        protocols: ["NineMM"],
        pools: ["0x0000000000000000000000000000000000000002"],
      }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      priceImpactThresholdsPercent: [99],
      focusedRefresh: false,
    }, deps);

    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    const sequential = section<Record<string, unknown>>(plan, "conservativeSequentialEstimate");
    expect(points[1]).toMatchObject({
      routeChangedFromPreviousQuote: true,
      routeChangedFromPreviousInCluster: false,
    });
    expect(sequential.selectedBudgetHuman).not.toBe("0");
  });

  it("withholds recommendations for stitched long-duration envelopes", async () => {
    const deps = clockedDepsFor({
      "10000000": quote("10000000", "1000"),
      "20000000": quote("20000000", "1800"),
      "30000000": quote("30000000", "2500"),
    }, Date.parse("2026-08-02T00:00:00.000Z"), 20_000);

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "30",
      chunkSizeHuman: "10",
      priceImpactThresholdsPercent: [5],
      maxSnapshotCollectionDurationMs: 5_000,
      focusedRefresh: false,
    }, deps);

    const envelope = section<Record<string, unknown>>(plan, "bestRouteEnvelope");
    const plans = section<Record<string, unknown>>(plan, "plans");
    expect(envelope.envelopeCoherence).toBe("stitched_multi_state");
    expect(plans.recommendationStatus).toBe("requote_required");
    expect(plans.recommendationBasis).toBe("none");
  });

  it("registers through MCP as read-only and works with wallet mode disabled", async () => {
    const deps = depsFor({
      "10000000": quote("10000000", "1000"),
    });
    const handlers = new Map<
      string,
      (args?: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>
    >();
    const server = {
      registerTool: (name: string, _meta: unknown, cb: unknown) => {
        handlers.set(name, cb as (args?: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        }>);
      },
    };

    registerPiteasAccumulationPlanTool(server as never, {
      ...baseConfig,
      agentWalletEnabled: false,
    }, deps);

    const response = await handlers.get("piteas_accumulation_plan")!({
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "10",
      quoteSizeLadderHuman: ["10"],
    });
    const body = JSON.parse(response.content[0]!.text) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(response.isError).toBeFalsy();
    expect(body.ok).toBe(true);
    expect((body.data.executionSafety as Record<string, unknown>).transactionPrepared).toBe(false);
  });

  it("does not include prepare, wallet, or disk-write implementation paths", () => {
    const dir = join(process.cwd(), "src/tools/analytics/piteas-accumulation");
    const source = [
      readFileSync(join(process.cwd(), "src/tools/analytics/index.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/tools/analytics/piteasAccumulationPlan.ts"), "utf8"),
      ...readdirSync(dir)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => readFileSync(join(dir, name), "utf8")),
    ].join("\n");
    const piteasData = readFileSync(join(process.cwd(), "src/data/piteas.ts"), "utf8");
    expect(source).toMatch(/getPiteasQuote/);
    expect(piteasData).toMatch(/export async function getPiteasQuote/);
    expect(source).not.toMatch(/preparePiteas|piteas_prepare_swap/);
    expect(source).not.toMatch(/from\s+["'].*wallet|agent_wallet|propose_agent_tx|execute_agent_tx/);
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|mkdir|rm\(/);
  });

  it("keeps last usable adaptive recommendation when a later round is unusable", async () => {
    // Round 1 has full fixtures and brackets. Round 2 generated mid-bracket sizes are missing,
    // so the second adaptive batch is unusable. Recommendation must stay on round-1 bounds.
    const deps = depsFor({
      "50000000": quote("50000000", "5000"),
      "150000000": quote("150000000", "14200"),
      "600000000": quote("600000000", "40000"),
      "5000000": Array.from({ length: 20 }, () => quote("5000000", "500")),
      "75000000": quote("75000000", "7300"),
      "90000000": quote("90000000", "8500"),
      "105000000": quote("105000000", "9700"),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "600",
      quoteSizeLadderHuman: ["50", "150", "600"],
      confirmationMode: "adaptive",
      referenceAmountCandidatesHuman: ["5"],
      confirmationCandidateSizesHuman: ["75", "90", "105"],
      // No maximumBracketWidthHuman: adaptive continues past round 1 by default.
      maximumAdaptiveRounds: 2,
      priceImpactThresholdsPercent: [3],
      focusedRefresh: false,
    }, deps);

    const adaptive = section<{
      terminationReason: string;
      thresholdBoundaryBracketed: boolean;
      recommendedMaximumTranche: Record<string, unknown> | null;
      finalLargestBelowThreshold: Record<string, unknown> | null;
      rounds: Array<{
        round: number;
        batchConfirmation: { temporallyUsable: boolean };
      }>;
    }>(plan, "adaptiveThresholdSearch");
    const plans = section<Record<string, unknown>>(plan, "plans");

    expect(adaptive.rounds.length).toBeGreaterThanOrEqual(2);
    expect(adaptive.rounds[0]?.batchConfirmation.temporallyUsable).toBe(true);
    expect(adaptive.rounds.at(-1)?.batchConfirmation.temporallyUsable).toBe(false);
    expect(adaptive.terminationReason).toBe("batch_unusable");
    expect(adaptive.thresholdBoundaryBracketed).toBe(true);
    expect(adaptive.recommendedMaximumTranche).toMatchObject({ inputHuman: "75" });
    expect(adaptive.finalLargestBelowThreshold).toMatchObject({ inputHuman: "75" });
    expect(latestAdaptiveBatch(adaptive as never)?.temporallyUsable).toBe(true);
    expect(plans.recommendationStatus).toBe("available");
    expect(plans.recommendationBasis).toBe("adaptive_batch_sandwich");
  });

  it("nulls gas fields when includeGasEstimate is false", async () => {
    const deps = depsFor({
      "5000000": quote("5000000", "500", { gasUsd: 0.05, gasUse: 300000 }),
      "10000000": quote("10000000", "950", { gasUsd: 0.08, gasUse: 320000 }),
    });

    const plan = await buildPiteasAccumulationPlan(baseConfig, {
      eUsdcAddress: EUSDC,
      phiatAddress: PHIAT,
      totalBudgetHuman: "10",
      quoteSizeLadderHuman: ["5", "10"],
      includeGasEstimate: false,
      confirmationMode: "individual_pairs",
      focusedRefresh: false,
    }, deps);

    const request = section(plan, "request");
    const points = plan.executableQuoteDepth as Array<Record<string, unknown>>;
    expect(request.includeGasEstimate).toBe(false);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(point.gasUseEstimate).toBeNull();
      expect(point.gasUseEstimateUSD).toBeNull();
      expect(point.gasCostPercentOfChunk).toBeNull();
      expect(point.gasWarning).toBeNull();
    }
    const quality = section<{ warnings: string[] }>(plan, "dataQuality");
    expect(
      quality.warnings.some((warning) => warning.toLowerCase().includes("gas")),
    ).toBe(false);
  });

  it("latestAdaptiveBatch prefers the last temporally usable round", () => {
    const usable = { temporallyUsable: true, candidateResults: [] };
    const unusable = { temporallyUsable: false, candidateResults: [] };
    const adaptive = {
      rounds: [
        { round: 1, batchConfirmation: usable },
        { round: 2, batchConfirmation: unusable },
      ],
    };
    expect(latestAdaptiveBatch(adaptive as never)).toBe(usable);
  });

});
