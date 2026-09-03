import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PITEAS_ROUTER,
  type PiteasQuoteResult,
} from "../src/data/index.js";
import type { AppConfig } from "../src/types.js";
import {
  buildPhiatDashboard,
  registerPhiatDashboardTool,
  type PhiatDashboardDeps,
} from "../src/tools/analytics/phiatDashboard.js";
import {
  buildThresholdEvidence,
  hasFreshnessMetadata,
} from "../src/tools/analytics/phiat-dashboard/piteasDepthEvaluation.js";

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

const TOKEN = "0x1111111111111111111111111111111111111111";
const PAIR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WPLS = "0xa1077a294dde1b09bb078844df40758a5d0f9a27";
const TREASURY = "0x2222222222222222222222222222222222222222";
const STAKING = "0x3333333333333333333333333333333333333333";
const DEPLOYER = "0x4444444444444444444444444444444444444444";
const OTHER_HOLDER = "0x5555555555555555555555555555555555555555";
const EUSDC = "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07";
const CALLDATA = "0x8218b58f" + "00".repeat(96);
const TRANSFER_EVENT_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOTAL_SUPPLY_RAW = "1000000000000000000000000";

function rawHuman(value: string, decimals = 18): string {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`).toString();
}

function topicAddress(address: string): string {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function steppedClock(
  startMs = Date.parse("2026-08-02T00:00:00.000Z"),
  stepMs = 3000,
): () => Date {
  let tick = 0;
  return () => new Date(startMs + tick++ * stepMs);
}

function piteasQuote(
  amountIn: string,
  outputHuman: string,
  opts: {
    minOutHuman?: string;
    quoteIdentifier?: string | null;
    quoteTimestamp?: string | null;
    expiresAt?: string | null;
    blockNumber?: string | null;
    responseFingerprint?: string | null;
    cacheHeaders?: Record<string, string> | null;
  } = {},
): PiteasQuoteResult {
  return {
    ok: true,
    source: "piteas",
    advisory: true,
    data: {
      srcToken: { address: EUSDC, symbol: "eUSDC", decimals: 6, chainId: 369 },
      destToken: { address: TOKEN, symbol: "PHIAT", decimals: 18, chainId: 369 },
      amountIn,
      amountOut: rawHuman(outputHuman),
      amountOutMin: rawHuman(opts.minOutHuman ?? outputHuman),
      valueWei: "0",
      valuePls: "0",
      gasUseEstimate: 250000,
      gasUseEstimateUSD: 0.02,
      priceImpactPercent: null,
      blockNumber: opts.blockNumber === undefined ? "123" : opts.blockNumber,
      quoteTimestamp:
        opts.quoteTimestamp === undefined
          ? "2026-08-02T00:00:00.000Z"
          : opts.quoteTimestamp,
      quoteIdentifier: opts.quoteIdentifier ?? null,
      expiresAt: opts.expiresAt ?? null,
      responseFingerprint: opts.responseFingerprint ?? null,
      cacheHeaders: opts.cacheHeaders ?? null,
      endpoint: "https://sdk.piteas.io/quote",
      retryCount: 0,
      methodParameters: { calldata: CALLDATA, value: "0x0" },
      router: PITEAS_ROUTER,
      route: {
        pathCount: 1,
        swapCount: 1,
        protocols: ["PulseX"],
        pools: ["0x0000000000000000000000000000000000000001"],
        tokenPath: [EUSDC, TOKEN],
        router: PITEAS_ROUTER,
        allocations: [],
        signature: "pulsex:pool-1:eusdc-phiat",
        note: "mock route summary",
      },
      tokenInParam: EUSDC,
      tokenOutParam: TOKEN,
      allowedSlippage: 0.5,
      chainId: 369,
      quoteReady: true,
      note: "mock quote",
      decodeNote: "mock decode note",
    },
  };
}

function piteasFailure(reason: string): PiteasQuoteResult {
  return {
    ok: false,
    source: "piteas",
    reason,
    advisory: true,
  };
}

function mockedDeps(overrides: Partial<PhiatDashboardDeps> = {}): PhiatDashboardDeps {
  let piteasSequence = 0;
  const deps: PhiatDashboardDeps = {
    fetchToken: vi.fn(async () => ({
      token: {
        id: TOKEN,
        symbol: "PHIAT",
        name: "PHIAT",
        decimals: "18",
        totalSupply: TOTAL_SUPPLY_RAW,
        tradeVolume: "0",
        tradeVolumeUSD: "100000",
        untrackedVolumeUSD: "0",
        totalTransactions: "100",
        totalLiquidity: "100000",
        derivedPLS: "2",
        derivedUSD: "0.01",
      },
    })),
    fetchTokenDayData: vi.fn(async () => ({
      tokenDayDatas: [
        {
          id: "day-1",
          date: 1_700_000_000,
          priceUSD: "0.01",
          totalLiquidityToken: "100000",
          totalLiquidityUSD: "300000",
          totalLiquidityPLS: "500000",
          dailyVolumeToken: "1000",
          dailyVolumePLS: "2000",
          dailyVolumeUSD: "12",
          dailyTxns: "5",
        },
        {
          id: "day-2",
          date: 1_699_913_600,
          priceUSD: "0.008",
          totalLiquidityToken: "100000",
          totalLiquidityUSD: "290000",
          totalLiquidityPLS: "450000",
          dailyVolumeToken: "900",
          dailyVolumePLS: "1800",
          dailyVolumeUSD: "9",
          dailyTxns: "4",
        },
      ],
    })),
    fetchPairsForToken: vi.fn(async () => [
      {
        id: PAIR,
        token0: {
          id: TOKEN,
          symbol: "PHIAT",
          name: "PHIAT",
          decimals: "18",
          derivedUSD: "0.01",
        },
        token1: {
          id: WPLS,
          symbol: "WPLS",
          name: "Wrapped PLS",
          decimals: "18",
          derivedUSD: "0.005",
        },
        reserve0: "15000000",
        reserve1: "30000000",
        reserveUSD: "300000",
        reservePLS: "200000",
        volumeUSD: "25000",
        totalTransactions: "77",
        token0Price: "2",
        token1Price: "0.5",
      },
    ]),
    fetchSwapsAdvanced: vi.fn(async () => ({
      swaps: [
        {
          id: "swap-1",
          timestamp: "1700000100",
          sender: "0x6666666666666666666666666666666666666666",
          to: "0x7777777777777777777777777777777777777777",
          amount0In: "2000",
          amount1In: "0",
          amount0Out: "0",
          amount1Out: "4000",
          amountUSD: "20000",
          pair: {
            id: PAIR,
            token0: { id: TOKEN, symbol: "PHIAT" },
            token1: { id: WPLS, symbol: "WPLS" },
          },
          transaction: { id: "0x" + "ab".repeat(32) },
        },
      ],
      filter: { token: TOKEN },
      incomplete: false,
      coverage: { skip: 0, first: 20, deep: false, pairCapHit: false },
    })),
    getDexScreenerTokenPairs: vi.fn(async () => ({
      ok: true,
      source: "dexscreener",
      chainId: "pulsechain",
      data: {
        tokenAddress: TOKEN,
        pairs: [
          {
            chainId: "pulsechain",
            dexId: "pulsex",
            url: "https://dexscreener.com/pulsechain/" + PAIR,
            pairAddress: PAIR,
            baseToken: { address: TOKEN, name: "PHIAT", symbol: "PHIAT" },
            quoteToken: { address: WPLS, name: "Wrapped PLS", symbol: "WPLS" },
            priceNative: "2",
            priceUsd: "0.01",
            volume: { h24: 12 },
            priceChange: { h24: 25 },
            liquidity: { usd: 300000, base: 15000000, quote: 30000000 },
            fdv: 10000,
            marketCap: 10000,
            pairCreatedAt: 1_690_000_000_000,
          },
        ],
      },
      pairCount: 1,
    })),
    getTokenOverviewSoft: vi.fn(async () => ({
      ok: true,
      source: "blockscout",
      data: {
        contractAddress: TOKEN,
        name: "PHIAT",
        symbol: "PHIAT",
        decimals: "18",
        totalSupply: TOTAL_SUPPLY_RAW,
        holdersCount: "10",
        type: "ERC-20",
        exchangeRate: null,
        circulatingMarketCap: null,
        topHolders: [{ address: TREASURY, value: "1000000000000000000000" }],
        sourcesUsed: ["explorer_v2_tokens", "explorer_v2_holders"],
        note: "mocked",
      },
    })),
    getContractSourceCode: vi.fn(async () => [
      {
        SourceCode: "contract PHIAT { function setTax(uint256 v) external {} }",
        ABI: '[{"name":"setTax","type":"function"}]',
        ContractName: "PHIAT",
      },
    ]),
    getTokenHolders: vi.fn(async () => ({
      items: [
        {
          address: { hash: TREASURY },
          value: "1000000000000000000000",
          token: { total_supply: TOTAL_SUPPLY_RAW },
        },
        {
          address: { hash: OTHER_HOLDER },
          value: "500000000000000000000",
          token: { total_supply: TOTAL_SUPPLY_RAW },
        },
      ],
    })),
    getContractCreation: vi.fn(async () => [
      {
        contractAddress: TOKEN,
        contractCreator: DEPLOYER,
        txHash: "0x" + "cd".repeat(32),
        timeStamp: "1680000000",
      },
    ]),
    getAccountTxList: vi.fn(async () => [
      {
        hash: "0x" + "ef".repeat(32),
        from: "0x8888888888888888888888888888888888888888",
        to: DEPLOYER,
        value: "1000000000000000000",
        timeStamp: "1690000000",
        isError: "0",
      },
    ]),
    explorerGet: vi.fn(async () => ({
      status: "1",
      message: "OK",
      result: [
        {
          transactionHash: "0x" + "12".repeat(32),
          blockNumber: "123",
          timeStamp: "1700000200",
          address: TOKEN,
          topics: [TRANSFER_EVENT_TOPIC0, topicAddress(TREASURY), topicAddress(STAKING)],
          data: "0x0de0b6b3a7640000",
        },
      ],
    })),
    batchErc20Balances: vi.fn(async (_cfg, owner) => [
      {
        token: TOKEN,
        owner: owner as `0x${string}`,
        balanceRaw:
          owner.toLowerCase() === TREASURY
            ? "1000000000000000000000"
            : "2000000000000000000000",
        decimals: 18,
        symbol: "PHIAT",
        name: "PHIAT",
        balanceFormatted: owner.toLowerCase() === TREASURY ? "1000" : "2000",
        balanceOk: true,
      },
    ]),
    getPiteasQuote: vi.fn(async (_cfg, req) => {
      piteasSequence += 1;
      const freshness = {
        quoteIdentifier: `quote-${piteasSequence}`,
        quoteTimestamp: `2026-08-02T00:00:0${piteasSequence}.000Z`,
        responseFingerprint: `fingerprint-${piteasSequence}`,
      };
      if (req.amount === "5000000") {
        return piteasQuote(req.amount, "1000", freshness);
      }
      if (req.amount === "100000000") {
        return piteasQuote(req.amount, "19607.8431372549", freshness);
      }
      if (req.amount === "125000000") {
        return piteasQuote(req.amount, "24038.4615384615", freshness);
      }
      if (req.amount === "112500000") {
        return piteasQuote(req.amount, "21887.1595330739", freshness);
      }
      return piteasFailure(`missing Piteas fixture for ${req.amount}`);
    }),
    buildPiteasAccumulationPlan: vi.fn(async () => ({
      plans: {
        recommendationStatus: "available",
        recommendationBasis: "adaptive_batch_sandwich",
        analyticalMaximumBelowThresholdHuman: "115",
        operationalMaximumTrancheHuman: "110",
        firstObservedAboveThreshold: { inputHuman: "125" },
        thresholdBoundaryBracketed: true,
      },
      coherence: {
        recommendationEvidence: {
          routeConfidence: "high",
          routeMetadataCompletenessPercent: 100,
        },
      },
      batchConfirmation: {
        selectedReferenceAmountHuman: "5",
        referenceDriftPercent: "0.1",
        freshnessConfidence: "high",
        possibleCacheDetected: false,
        batchDurationMs: 3000,
      },
      adaptiveThresholdSearch: {
        finalFirstAboveThreshold: { inputHuman: "125" },
        finalBracketWidthHuman: "10",
        thresholdBoundaryBracketed: true,
      },
      operationalTranchePlan: {
        analyticalMaximumBelowThresholdHuman: "115",
        operationalMaximumTrancheHuman: "110",
      },
      piteasReliability: {
        requestsAttempted: 5,
        requestsSucceeded: 5,
        requestsFailed: 0,
      },
      guardrails: {
        referenceAmountHuman: "5",
        proposedTrancheHuman: "110",
        requoteBeforeEveryExecution: true,
      },
      dataQuality: {
        partialFailures: [],
        warnings: ["mock warning"],
      },
    })),
  };
  return { ...deps, ...overrides };
}

function section<T extends Record<string, unknown>>(
  dashboard: Record<string, unknown>,
  key: string,
): T {
  return dashboard[key] as T;
}

describe("phiat_dashboard", () => {
  it("builds a consolidated read-only dashboard from mocked upstream data", async () => {
    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN.toUpperCase().replace("0X", "0x"),
      treasuryAddresses: [TREASURY],
      stakingAddresses: [STAKING],
      whaleThreshold: "1000",
      recentSwapLimit: 5,
    }, mockedDeps());

    const token = section(dashboard, "token");
    const market = section(dashboard, "market");
    const liquidity = section(dashboard, "liquidity");
    const holderAnalysis = section(dashboard, "holderAnalysis");
    const activity = section(dashboard, "activity");
    const safety = section(dashboard, "safety");
    const age = section(dashboard, "age");

    expect(token.address).toBe(TOKEN);
    expect(token.symbol).toBe("PHIAT");
    expect(token.contractTotalSupplyRaw).toBe(TOTAL_SUPPLY_RAW);
    expect(token.contractTotalSupplyFormatted).toBe("1000000");
    expect(token.maximumSupply).toBeNull();
    expect((market.priceUsd as Record<string, Record<string, unknown>>).aggregate.value).toBe(0.01);
    expect((market.volume24hUsd as Record<string, Record<string, unknown>>).primaryPair.value).toBe(12);
    expect((market.marketCap as Record<string, Record<string, unknown>>).computedFromContractSupplyAndAggregatePrice.value).toBe(10000);
    expect((market.fdv as Record<string, Record<string, unknown>>).primaryPairDexScreener.value).toBe(10000);
    expect(market.primaryPair).toBeTruthy();
    expect((liquidity.pairs as unknown[])).toHaveLength(1);
    expect(liquidity.primaryPairConcentrationPercent).toBe(100);
    expect(liquidity.liquidityRiskLevel).toBe("low");

    const treasury = holderAnalysis.knownTreasuryBalances as Array<Record<string, unknown>>;
    const staking = holderAnalysis.knownStakingBalances as Array<Record<string, unknown>>;
    expect(treasury[0]?.balanceRaw).toBe("1000000000000000000000");
    expect(staking[0]?.balanceFormatted).toBe("2000");
    expect((holderAnalysis.excludedSupplyEstimate as Record<string, unknown>).raw).toBe(
      "3000000000000000000000",
    );
    expect(holderAnalysis.holderMetricsValid).toBe(true);
    expect(holderAnalysis.topHolderShare).toBe(0.001);
    expect(holderAnalysis.top10HolderShare).toBe(0.0015);

    expect((activity.recentSwaps as unknown[])).toHaveLength(1);
    expect((activity.largeRecentSwaps as unknown[])).toHaveLength(1);
    expect((activity.recentTransfers as Array<Record<string, unknown>>)[0]?.method).toBe(
      "erc20_transfer_log",
    );
    expect(activity.truncated).toBe(false);
    expect(activity.window).toEqual({
      fromBlock: 0,
      toBlock: "latest",
      offset: 5,
      page: 1,
    });
    expect(String(activity.note)).toMatch(/not full/i);
    expect((safety.rawHeuristics as Record<string, unknown>).suspiciousPatterns).toContain(
      "mutable_tax",
    );
    expect(safety.safetyGrade).toBeTypeOf("string");
    expect(age.verifiedContractCreationTimestamp).toBe("2023-03-28T10:40:00.000Z");
    expect(dashboard.dataQuality.partialFailures).toEqual([]);
  });

  it("makes zero Piteas calls when includePiteasDepth is false", async () => {
    const deps = mockedDeps();
    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      includePiteasDepth: false,
    }, deps);

    expect(deps.buildPiteasAccumulationPlan).not.toHaveBeenCalled();
    expect(deps.getPiteasQuote).not.toHaveBeenCalled();
    expect(dashboard.piteasDepth).toBeNull();
  });

  it("fast mode makes exactly four required quote calls and omits detailed ladders", async () => {
    const deps = mockedDeps({ now: steppedClock() });
    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      includePiteasDepth: true,
      piteasDepthMode: "fast",
      piteasDepthTimeoutMs: 40000,
    }, deps);

    const depth = section<Record<string, unknown>>(dashboard, "piteasDepth");
    expect(deps.buildPiteasAccumulationPlan).not.toHaveBeenCalled();
    expect(deps.getPiteasQuote).toHaveBeenCalledTimes(4);
    expect(deps.getPiteasQuote).toHaveBeenCalledWith(baseConfig, expect.objectContaining({
      tokenIn: EUSDC,
      tokenOut: TOKEN,
      amount: "5000000",
    }), expect.any(Object));
    expect(depth).toMatchObject({
      mode: "fast",
      recommendationStatus: "available",
      recommendationBasis: "batch_sandwich",
      selectedReferenceAmountHuman: "5",
      lowerCandidateHuman: "100",
      upperCandidateHuman: "125",
      analyticalMaximumBelowThresholdHuman: "100",
      operationalMaximumTrancheHuman: "100",
      firstConfirmedAboveThresholdHuman: "125",
      thresholdBoundaryBracketed: true,
      freshnessConfidence: "high",
      possibleCacheDetected: false,
      configuredTimeoutMs: 40000,
    });
    expect(depth.lowerDeteriorationPercent).toBeCloseTo(2, 3);
    expect(depth.upperDeteriorationPercent).toBeCloseTo(4, 3);
    expect((depth.piteasReliability as Record<string, unknown>).requestsAttempted).toBe(4);
    expect((depth.warnings as string[])).toContain(
      "Optional midpoint refinement skipped because insufficient deadline remained after the required quote sandwich.",
    );
    expect(depth).not.toHaveProperty("bestRouteEnvelope");
    expect(depth).not.toHaveProperty("executableQuoteDepth");
    expect(depth).not.toHaveProperty("routeLocalCurves");
    expect(depth).not.toHaveProperty("independentQuoteComparison");
    expect(depth).not.toHaveProperty("sequentialExecutionAnalysis");
  });

  it("runs lower and upper fast candidates concurrently", async () => {
    let activeCandidates = 0;
    let maxActiveCandidates = 0;
    const deps = mockedDeps({
      getPiteasQuote: vi.fn(async (_cfg, req) => {
        if (req.amount === "100000000" || req.amount === "125000000") {
          activeCandidates += 1;
          maxActiveCandidates = Math.max(maxActiveCandidates, activeCandidates);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeCandidates -= 1;
          return piteasQuote(req.amount, "25000", {
            quoteIdentifier: `candidate-${req.amount}`,
            quoteTimestamp: "2026-08-02T00:00:02.000Z",
            responseFingerprint: `candidate-${req.amount}`,
          });
        }
        return piteasQuote(req.amount, "1000", {
          quoteIdentifier: `reference-${req.amount}-${Date.now()}`,
          quoteTimestamp: "2026-08-02T00:00:01.000Z",
          responseFingerprint: `reference-${Date.now()}`,
        });
      }),
    });

    await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      includePiteasDepth: true,
      piteasDepthMode: "fast",
    }, deps);

    expect(maxActiveCandidates).toBe(2);
  });

  it("reserves reference-after time and returns requote_required with partial diagnostics", async () => {
    const deps = mockedDeps({ now: steppedClock(undefined, 1000) });
    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      includePiteasDepth: true,
      piteasDepthMode: "fast",
      piteasDepthTimeoutMs: 25000,
    }, deps);

    const depth = section<Record<string, unknown>>(dashboard, "piteasDepth");
    const reliability = depth.piteasReliability as Record<string, unknown>;
    expect(deps.getPiteasQuote).toHaveBeenCalledTimes(1);
    expect(depth.recommendationStatus).toBe("requote_required");
    expect(depth.recommendationBasis).toBe("partial_evidence");
    expect(reliability.requestsAttempted).toBe(1);
    expect(reliability.requestsSucceeded).toBe(1);
    expect(reliability.referenceBefore).toMatchObject({
      ok: true,
      inputHuman: "5",
      outputHuman: "1000",
    });
    expect(depth.partialFailures).toContainEqual({
      source: "piteas.depth.fast.candidates",
      error: "Insufficient deadline remaining to start candidate quotes while reserving reference-after time.",
    });
  });

  it("returns unavailable when no useful Piteas quote data is obtained", async () => {
    const deps = mockedDeps({
      getPiteasQuote: vi.fn(async () => piteasFailure("Piteas down")),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      includePiteasDepth: true,
      piteasDepthMode: "fast",
    }, deps);

    const depth = section<Record<string, unknown>>(dashboard, "piteasDepth");
    const reliability = depth.piteasReliability as Record<string, unknown>;
    expect(depth.recommendationStatus).toBe("unavailable");
    expect(reliability.requestsSucceeded).toBe(0);
    expect(depth.partialFailures).toContainEqual({
      source: "piteas.depth.fast.reference_before",
      error: "Piteas down",
    });
  });

  it("uses the operational safety buffer instead of the analytical edge", async () => {
    const deps = mockedDeps();
    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      includePiteasDepth: true,
      piteasDepthMode: "fast",
      piteasDepthTimeoutMs: 75000,
    }, deps);

    const depth = section<Record<string, unknown>>(dashboard, "piteasDepth");
    expect(deps.getPiteasQuote).toHaveBeenCalledTimes(5);
    expect(depth.recommendationStatus).toBe("available");
    expect(depth.analyticalMaximumBelowThresholdHuman).toBe("112.5");
    expect(depth.operationalMaximumTrancheHuman).toBe("100");
    expect(depth.firstConfirmedAboveThresholdHuman).toBe("125");
  });

  it("separates analytical partial boundary from available operational bracket", async () => {
    let referenceCount = 0;
    const deps = mockedDeps({
      now: steppedClock(),
      getPiteasQuote: vi.fn(async (_cfg, req) => {
        if (req.amount === "5000000") {
          referenceCount += 1;
          return piteasQuote(req.amount, "500", {
            quoteIdentifier: `reference-${referenceCount}`,
            quoteTimestamp: `2026-08-02T00:00:0${referenceCount}.000Z`,
            responseFingerprint: `reference-${referenceCount}`,
          });
        }
        if (req.amount === "100000000") {
          return piteasQuote(req.amount, "9763.183727350207846030", {
            quoteIdentifier: "lower",
            quoteTimestamp: "2026-08-02T00:00:02.000Z",
            responseFingerprint: "lower",
          });
        }
        if (req.amount === "125000000") {
          return piteasQuote(req.amount, "12136.730306404962902889", {
            quoteIdentifier: "upper",
            quoteTimestamp: "2026-08-02T00:00:02.000Z",
            responseFingerprint: "upper",
          });
        }
        return piteasFailure(`unexpected amount ${req.amount}`);
      }),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      includePiteasDepth: true,
      piteasDepthMode: "fast",
      piteasDepthTimeoutMs: 40000,
    }, deps);

    const depth = section<Record<string, unknown>>(dashboard, "piteasDepth");
    expect(deps.getPiteasQuote).toHaveBeenCalledTimes(4);
    expect(depth.lowerDeteriorationPercent).toBeCloseTo(2.425605, 6);
    expect(depth.upperDeteriorationPercent).toBeCloseTo(2.993143, 6);

    expect(depth.recommendationStatus).toBe("requote_required");
    expect(depth.analyticalRecommendationStatus).toBe("partial_boundary");
    expect(depth.analyticalThresholdBoundaryBracketed).toBe(false);
    expect(depth.analyticalLargestConfirmedBelowThresholdHuman).toBe("125");
    expect(depth.analyticalFirstConfirmedAboveThresholdHuman).toBeNull();

    expect(depth.operationalRecommendationStatus).toBe("available");
    expect(depth.operationalThresholdBoundaryBracketed).toBe(true);
    expect(depth.operationalLargestConfirmedBelowThresholdHuman).toBe("100");
    expect(depth.operationalFirstConfirmedAboveThresholdHuman).toBe("125");
    expect(depth.operationalRecommendedMaximumTrancheHuman).toBe("100");
    expect(depth.operationalMaximumTrancheHuman).toBe("100");
  });

  it("withholds fast recommendations for identical references without freshness metadata", async () => {
    const deps = mockedDeps({
      now: steppedClock(),
      getPiteasQuote: vi.fn(async (_cfg, req) => {
        if (req.amount === "5000000") {
          return piteasQuote(req.amount, "1000", {
            quoteIdentifier: null,
            quoteTimestamp: null,
            expiresAt: null,
            blockNumber: null,
            responseFingerprint: "same-reference",
          });
        }
        if (req.amount === "100000000") {
          return piteasQuote(req.amount, "19607.8431372549", {
            responseFingerprint: `candidate-${req.amount}`,
          });
        }
        return piteasQuote(req.amount, "24038.4615384615", {
          responseFingerprint: `candidate-${req.amount}`,
        });
      }),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      includePiteasDepth: true,
      piteasDepthMode: "fast",
      piteasDepthTimeoutMs: 40000,
    }, deps);

    const depth = section<Record<string, unknown>>(dashboard, "piteasDepth");
    const reliability = depth.piteasReliability as Record<string, unknown>;
    expect(depth.recommendationStatus).toBe("requote_required");
    expect(depth.possibleCacheDetected).toBe(true);
    expect(depth.freshnessConfidence).toBe("low");
    expect(reliability.referenceEqualityDetected).toBe(true);
    expect(depth.warnings as string[]).toContain(
      "Reference freshness was insufficient for an available dashboard Piteas recommendation.",
    );
  });

  it("keeps adaptive dashboard depth available separately without exposing ladders", async () => {
    const deps = mockedDeps();
    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      includePiteasDepth: true,
      piteasDepthMode: "adaptive",
      piteasDepthTimeoutMs: 90000,
    }, deps);

    const depth = section<Record<string, unknown>>(dashboard, "piteasDepth");
    expect(deps.buildPiteasAccumulationPlan).toHaveBeenCalledWith(
      baseConfig,
      expect.objectContaining({
        eUsdcAddress: EUSDC,
        phiatAddress: TOKEN,
        confirmationMode: "adaptive",
        maximumAdaptiveRounds: 2,
      }),
    );
    expect(deps.getPiteasQuote).not.toHaveBeenCalled();
    expect(depth).toMatchObject({
      mode: "adaptive",
      recommendationStatus: "available",
      recommendationBasis: "adaptive_batch_sandwich",
      selectedReferenceAmountHuman: "5",
      analyticalMaximumBelowThresholdHuman: "115",
      operationalMaximumTrancheHuman: "110",
      firstConfirmedAboveThresholdHuman: "125",
      thresholdBoundaryBracketed: true,
      freshnessConfidence: "high",
      possibleCacheDetected: false,
      batchDurationMs: 3000,
      configuredTimeoutMs: 90000,
    });
    expect(depth).not.toHaveProperty("bestRouteEnvelope");
    expect(depth).not.toHaveProperty("executableQuoteDepth");
    expect(depth).not.toHaveProperty("routeLocalCurves");
  });

  it("preserves the dashboard when bounded Piteas depth fails", async () => {
    const deps = mockedDeps({
      getPiteasQuote: vi.fn(async () => {
        throw new Error("piteas unavailable");
      }),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      includePiteasDepth: true,
    }, deps);

    expect(dashboard.token).toBeTruthy();
    const depth = section<Record<string, unknown>>(dashboard, "piteasDepth");
    expect(depth.recommendationStatus).toBe("unavailable");
    expect(depth.partialFailures).toEqual([
      { source: "piteas.depth.fast", error: "piteas unavailable" },
    ]);
    expect(dashboard.dataQuality.partialFailures).toContainEqual({
      source: "piteas.depth.fast",
      error: "piteas unavailable",
    });
  });

  it("deduplicates holder addresses case-insensitively before concentration math", async () => {
    const deps = mockedDeps({
      getTokenHolders: vi.fn(async () => ({
        items: [
          {
            address: { hash: TREASURY.toUpperCase().replace("0X", "0x") },
            value: "1000000000000000000000",
            token: { total_supply: TOTAL_SUPPLY_RAW },
          },
          {
            address: { hash: TREASURY },
            value: "1000000000000000000000",
            token: { total_supply: TOTAL_SUPPLY_RAW },
          },
          {
            address: { hash: OTHER_HOLDER },
            value: "500000000000000000000",
            token: { total_supply: TOTAL_SUPPLY_RAW },
          },
        ],
      })),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, { tokenAddress: TOKEN }, deps);
    const holders = section(dashboard, "holderAnalysis");

    expect(holders.holderSampleSize).toBe(2);
    expect(holders.top10HolderShare).toBe(0.0015);
    expect(holders.holderMetricsValid).toBe(true);
    expect(holders.holderMetricErrors).toContain(
      `duplicate_holder_address_deduped:${TREASURY}`,
    );
  });

  it("nulls concentration metrics when cumulative holder share exceeds 100 percent", async () => {
    const deps = mockedDeps({
      getTokenHolders: vi.fn(async () => ({
        items: [
          {
            address: { hash: TREASURY },
            value: "900000000000000000000000",
            token: { total_supply: TOTAL_SUPPLY_RAW },
          },
          {
            address: { hash: OTHER_HOLDER },
            value: "200000000000000000000000",
            token: { total_supply: TOTAL_SUPPLY_RAW },
          },
        ],
      })),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, { tokenAddress: TOKEN }, deps);
    const holders = section(dashboard, "holderAnalysis");
    const safety = section(dashboard, "safety");

    expect(holders.topHolderShare).toBeNull();
    expect(holders.top10HolderShare).toBeNull();
    expect(holders.holderMetricsValid).toBe(false);
    expect(holders.holderMetricErrors).toContain("holder_cumulative_share_out_of_range");
    expect(safety.safetyGrade).toBeNull();
    expect(safety.unavailableInputs).toContain("valid_holder_metrics");
  });

  it("invalidates holder metrics when holder supply units disagree with contract supply", async () => {
    const deps = mockedDeps({
      getTokenHolders: vi.fn(async () => ({
        items: [
          {
            address: { hash: TREASURY },
            value: "1000",
            token: { total_supply: "1000000" },
          },
        ],
      })),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, { tokenAddress: TOKEN }, deps);
    const holders = section(dashboard, "holderAnalysis");

    expect(holders.holderMetricsValid).toBe(false);
    expect(holders.topHolderShare).toBeNull();
    expect((holders.holderMetricErrors as string[]).some((error) =>
      error.startsWith("holder_token_total_supply_mismatch:"),
    )).toBe(true);
  });

  it("withholds safety grade when the holder endpoint fails", async () => {
    const deps = mockedDeps({
      getTokenHolders: vi.fn(async () => {
        throw new Error("holders unavailable");
      }),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, { tokenAddress: TOKEN }, deps);
    const holders = section(dashboard, "holderAnalysis");
    const safety = section(dashboard, "safety");
    const failures = dashboard.dataQuality.partialFailures;

    expect(holders.holderMetricsValid).toBe(false);
    expect(holders.top10HolderShare).toBeNull();
    expect(safety.safetyGrade).toBeNull();
    expect(safety.unavailableInputs).toContain("valid_holder_metrics");
    expect(failures.some((failure) => failure.source === "blockscout.topHolders")).toBe(true);
  });

  it("keeps conflicting market sources separate and emits discrepancy warnings", async () => {
    const deps = mockedDeps({
      getDexScreenerTokenPairs: vi.fn(async () => ({
        ok: true,
        source: "dexscreener",
        chainId: "pulsechain",
        data: {
          tokenAddress: TOKEN,
          pairs: [
            {
              chainId: "pulsechain",
              dexId: "pulsex",
              url: "https://dexscreener.com/pulsechain/" + PAIR,
              pairAddress: PAIR,
              baseToken: { address: TOKEN, name: "PHIAT", symbol: "PHIAT" },
              quoteToken: { address: WPLS, name: "Wrapped PLS", symbol: "WPLS" },
              priceNative: "4",
              priceUsd: "0.02",
              volume: { h24: 1200 },
              priceChange: { h24: -10 },
              liquidity: { usd: 10000, base: 50000, quote: 100000 },
              fdv: 20000,
              marketCap: 20000,
            },
          ],
        },
      })),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, { tokenAddress: TOKEN }, deps);
    const market = section(dashboard, "market");
    const warnings = market.warnings as string[];

    expect((market.priceUsd as Record<string, Record<string, unknown>>).aggregate.value).toBe(0.01);
    expect((market.priceUsd as Record<string, Record<string, unknown>>).primaryPair.value).toBe(0.02);
    expect(warnings.some((warning) => warning.includes("priceUsd differs"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("volume24hUsd differs"))).toBe(true);
  });

  it("separates missing contract creation from pair age and indexed activity", async () => {
    const deps = mockedDeps({
      getContractCreation: vi.fn(async () => []),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, { tokenAddress: TOKEN }, deps);
    const age = section(dashboard, "age");
    const safety = section(dashboard, "safety");

    expect(age.verifiedContractCreationTimestamp).toBeNull();
    expect(age.verifiedContractAgeDays).toBeNull();
    expect(age.primaryPairCreatedAt).toBe("2023-07-22T04:26:40.000Z");
    expect(age.firstIndexedActivityTimestamp).toBe("2023-11-13T22:13:20.000Z");
    expect(safety.unavailableInputs).toContain("verified_contract_age");
  });

  it("requests token-wide transfer logs with the token contract address parameter", async () => {
    const deps = mockedDeps();
    await buildPhiatDashboard(baseConfig, { tokenAddress: TOKEN, recentSwapLimit: 20 }, deps);

    expect(deps.explorerGet).toHaveBeenCalledWith(baseConfig, {
      module: "logs",
      action: "getLogs",
      address: TOKEN,
      fromBlock: 0,
      toBlock: "latest",
      topic0: TRANSFER_EVENT_TOPIC0,
      page: 1,
      offset: 20,
    });
  });

  it("marks PHIAT transfer activity truncated when getLogs rows hit the cap", async () => {
    const transferRow = {
      transactionHash: "0x" + "12".repeat(32),
      blockNumber: "123",
      timeStamp: "1700000200",
      address: TOKEN,
      topics: [TRANSFER_EVENT_TOPIC0, topicAddress(TREASURY), topicAddress(STAKING)],
      data: "0x0de0b6b3a7640000",
    };
    const deps = mockedDeps({
      explorerGet: vi.fn(async () => ({
        status: "1",
        message: "OK",
        result: [transferRow, { ...transferRow, blockNumber: "124" }],
      })),
    });

    const dashboard = await buildPhiatDashboard(
      baseConfig,
      { tokenAddress: TOKEN, recentSwapLimit: 2 },
      deps,
    );
    const activity = section(dashboard, "activity");
    expect((activity.recentTransfers as unknown[]).length).toBe(2);
    expect(activity.truncated).toBe(true);
    expect(activity.window).toEqual({
      fromBlock: 0,
      toBlock: "latest",
      offset: 2,
      page: 1,
    });
    expect(String(activity.note)).toMatch(/not full/i);
  });

  it("marks market data as critically unreliable below ten thousand dollars of liquidity", async () => {
    const deps = mockedDeps({
      fetchPairsForToken: vi.fn(async () => [
        {
          id: PAIR,
          token0: { id: TOKEN, symbol: "PHIAT" },
          token1: { id: WPLS, symbol: "WPLS" },
          reserve0: "50000",
          reserve1: "100000",
          reserveUSD: "9999",
          volumeUSD: "25000",
          totalTransactions: "77",
          token0Price: "2",
          token1Price: "0.5",
        },
      ]),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, { tokenAddress: TOKEN }, deps);
    const liquidity = section(dashboard, "liquidity");
    const safety = section(dashboard, "safety");

    expect(liquidity.liquidityRiskLevel).toBe("critical");
    expect(liquidity.liquidityReliabilityWarning).toContain("Critical reliability");
    expect(safety.safetyGrade).toBeNull();
    expect(safety.unavailableInputs).toContain("reliable_market_liquidity");
  });

  it("preserves null versus zero semantics for market fields", async () => {
    const deps = mockedDeps({
      fetchTokenDayData: vi.fn(async () => ({
        tokenDayDatas: [
          {
            id: "day-1",
            date: 1_700_000_000,
            priceUSD: "0.01",
            totalLiquidityToken: "100000",
            totalLiquidityUSD: "300000",
            dailyVolumeToken: "0",
            dailyVolumePLS: "0",
            dailyVolumeUSD: "0",
            dailyTxns: "0",
          },
        ],
      })),
      getDexScreenerTokenPairs: vi.fn(async () => ({
        ok: true,
        source: "dexscreener",
        chainId: "pulsechain",
        data: {
          tokenAddress: TOKEN,
          pairs: [
            {
              chainId: "pulsechain",
              dexId: "pulsex",
              url: "https://dexscreener.com/pulsechain/" + PAIR,
              pairAddress: PAIR,
              baseToken: { address: TOKEN, name: "PHIAT", symbol: "PHIAT" },
              quoteToken: { address: WPLS, name: "Wrapped PLS", symbol: "WPLS" },
              priceUsd: "0.01",
              liquidity: { usd: 300000 },
              volume: { h24: 0 },
              priceChange: null,
            },
          ],
        },
      })),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, { tokenAddress: TOKEN }, deps);
    const market = section(dashboard, "market");

    expect((market.volume24hUsd as Record<string, Record<string, unknown>>).aggregate.value).toBe(0);
    expect((market.volume24hUsd as Record<string, Record<string, unknown>>).primaryPair.value).toBe(0);
    expect((market.priceChange24h as Record<string, Record<string, unknown>>).aggregate.value).toBeNull();
    expect((market.priceChange24h as Record<string, Record<string, unknown>>).primaryPair.value).toBeNull();
  });

  it("does not format malformed raw supply as zero", async () => {
    const deps = mockedDeps({
      fetchToken: vi.fn(async () => ({
        token: {
          id: TOKEN,
          symbol: "PHIAT",
          name: "PHIAT",
          decimals: "18",
          totalSupply: "not-a-number",
          tradeVolume: "0",
          tradeVolumeUSD: "100000",
          untrackedVolumeUSD: "0",
          totalTransactions: "100",
          totalLiquidity: "100000",
          derivedPLS: "2",
          derivedUSD: "0.01",
        },
      })),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, { tokenAddress: TOKEN }, deps);
    const token = section<Record<string, unknown>>(dashboard, "token");
    const market = section<Record<string, unknown>>(dashboard, "market");
    const holderAnalysis = section<Record<string, unknown>>(dashboard, "holderAnalysis");
    const denominator = holderAnalysis.denominatorSupply as Record<string, unknown>;

    expect(token.contractTotalSupplyRaw).toBe("not-a-number");
    expect(token.contractTotalSupplyFormatted).toBeNull();
    expect((market.marketCap as Record<string, Record<string, unknown>>).computedFromContractSupplyAndAggregatePrice.value).toBeNull();
    expect(holderAnalysis.holderMetricsValid).toBe(false);
    expect(denominator.formatted).toBeNull();
  });

  it("returns partial dashboard data when upstream sources fail", async () => {
    const deps = mockedDeps({
      fetchToken: vi.fn(async () => {
        throw new Error("subgraph down");
      }),
      fetchTokenDayData: vi.fn(async () => {
        throw new Error("day data down");
      }),
      getContractSourceCode: vi.fn(async () => {
        throw new Error("source unavailable");
      }),
      getDexScreenerTokenPairs: vi.fn(async () => ({
        ok: true,
        source: "dexscreener",
        chainId: "pulsechain",
        data: {
          tokenAddress: TOKEN,
          pairs: [
            {
              chainId: "pulsechain",
              dexId: "pulsex",
              url: "https://dexscreener.com/pulsechain/" + PAIR,
              pairAddress: PAIR,
              baseToken: { address: TOKEN, name: "PHIAT", symbol: "PHIAT" },
              quoteToken: { address: WPLS, name: "Wrapped PLS", symbol: "WPLS" },
              priceUsd: "0.02",
              liquidity: { usd: 20000 },
            },
          ],
        },
      })),
    });

    const dashboard = await buildPhiatDashboard(baseConfig, {
      tokenAddress: TOKEN,
      recentSwapLimit: 2,
    }, deps);

    const token = section(dashboard, "token");
    const market = section(dashboard, "market");
    const quality = dashboard.dataQuality;
    const safety = section(dashboard, "safety");

    expect(token.address).toBe(TOKEN);
    expect((market.priceUsd as Record<string, Record<string, unknown>>).primaryPair.value).toBe(0.02);
    expect((market.volume24hUsd as Record<string, Record<string, unknown>>).aggregate.value).toBeNull();
    expect(safety.safetyGrade).toBeNull();
    expect(quality.partialFailures.some((f) => f.source === "pulsex_subgraph.token.v2")).toBe(true);
    expect(quality.partialFailures.some((f) => f.source === "blockscout.contractSource")).toBe(true);
  });

  it("rejects invalid token addresses before any upstream call", async () => {
    const deps = mockedDeps();
    await expect(
      buildPhiatDashboard(baseConfig, { tokenAddress: "PHIAT" }, deps),
    ).rejects.toThrow(/invalid address/i);
    expect(deps.fetchToken).not.toHaveBeenCalled();
  });

  it("registers and executes through the MCP ToolResult wrapper with wallets disabled", async () => {
    const handlers = new Map<
      string,
      (args?: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>
    >();
    const metas = new Map<string, { inputSchema?: { shape?: Record<string, unknown> } }>();
    const server = {
      registerTool: (name: string, meta: unknown, cb: unknown) => {
        metas.set(name, meta as { inputSchema?: { shape?: Record<string, unknown> } });
        handlers.set(name, cb as (args?: Record<string, unknown>) => Promise<{
          content: Array<{ type: string; text: string }>;
          isError?: boolean;
        }>);
      },
    };

    registerPhiatDashboardTool(server as never, {
      ...baseConfig,
      agentWalletEnabled: false,
    }, mockedDeps());

    const handler = handlers.get("phiat_dashboard");
    expect(handler).toBeTypeOf("function");
    expect(metas.get("phiat_dashboard")?.inputSchema?.shape).toHaveProperty("piteasDepthMode");
    expect(metas.get("phiat_dashboard")?.inputSchema?.shape).toHaveProperty("piteasDepthTimeoutMs");
    const response = await handler!({
      tokenAddress: TOKEN,
      recentSwapLimit: 1,
    });
    const body = JSON.parse(response.content[0]!.text) as {
      ok: boolean;
      data?: Record<string, unknown>;
    };
    expect(response.isError).toBeFalsy();
    expect(body.ok).toBe(true);
    expect(body.data?.token).toBeTruthy();
    const activity = body.data?.activity as Record<string, unknown> | undefined;
    expect(activity?.truncated).toBe(true);
    expect(activity?.window).toEqual({
      fromBlock: 0,
      toBlock: "latest",
      offset: 1,
      page: 1,
    });
  });

  it("does not include prepare, wallet, transaction, or disk-write dashboard paths", () => {
    const dir = join(process.cwd(), "src/tools/analytics/phiat-dashboard");
    const source = [
      readFileSync(join(process.cwd(), "src/tools/analytics/index.ts"), "utf8"),
      readFileSync(join(process.cwd(), "src/tools/analytics/phiatDashboard.ts"), "utf8"),
      ...readdirSync(dir)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => readFileSync(join(dir, name), "utf8")),
    ].join("\n");
    const piteasData = readFileSync(join(process.cwd(), "src/data/piteas.ts"), "utf8");
    expect(source).toMatch(/getPiteasQuote/);
    expect(piteasData).toMatch(/export async function getPiteasQuote/);
    expect(source).not.toMatch(/preparePiteas|piteas_prepare_swap/);
    expect(source).not.toMatch(/from\s+["'].*wallet|agent_wallet|propose_agent_tx|execute_agent_tx/);
    expect(source).not.toMatch(/sign[A-Za-z0-9_]*\(|submit[A-Za-z0-9_]*\(|broadcast[A-Za-z0-9_]*\(|execute[A-Za-z0-9_]*Tx\(/);
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|mkdir|rm\(/);
  });
});

describe("phiat dashboard threshold and freshness helpers", () => {
  it("treats deterioration exactly at the threshold as above (planner-aligned)", () => {
    const attempt = (inputHuman: string) =>
      ({
        inputHuman,
        ok: true,
        purpose: "candidate_lower",
        amount: inputHuman,
        requestStartedAt: "2026-08-02T00:00:00.000Z",
        responseReceivedAt: "2026-08-02T00:00:00.100Z",
        quote: null,
        failureReason: null,
      }) as never;

    const evidence = buildThresholdEvidence({
      candidateEvaluations: [
        { attempt: attempt("100"), deteriorationPercent: 2.9 },
        { attempt: attempt("125"), deteriorationPercent: 3.0 },
        { attempt: attempt("150"), deteriorationPercent: 4.0 },
      ],
      thresholdPercent: 3,
      batchUsable: true,
      usefulQuoteCount: 3,
    });

    expect(evidence.largestConfirmedBelowThresholdHuman).toBe("100");
    expect(evidence.firstConfirmedAboveThresholdHuman).toBe("125");
    expect(evidence.thresholdBoundaryBracketed).toBe(true);
    expect(evidence.recommendationStatus).toBe("available");
  });

  it("does not treat a constant quote endpoint as freshness metadata", () => {
    expect(
      hasFreshnessMetadata({
        endpoint: "https://sdk.piteas.io/quote",
        quoteIdentifier: null,
        quoteTimestamp: null,
        expiresAt: null,
        blockNumber: null,
      } as never),
    ).toBe(false);
    expect(
      hasFreshnessMetadata({
        endpoint: "https://sdk.piteas.io/quote",
        quoteIdentifier: "q-1",
        quoteTimestamp: null,
        expiresAt: null,
        blockNumber: null,
      } as never),
    ).toBe(true);
  });
});

