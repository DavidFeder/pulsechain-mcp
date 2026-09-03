/**
 * PHIAT research dashboard.
 *
 * Read-only composition over existing public data helpers:
 * PulseX subgraph, DexScreener, BlockScout, and optional ERC-20 balance reads.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  fetchPairsForToken,
  fetchSwapsAdvanced,
  fetchToken,
  fetchTokenDayData,
  getAccountTxList,
  getContractCreation,
  getContractSourceCode,
  getDexScreenerTokenPairs,
  getTokenHolders,
  getTokenOverviewSoft,
  getPiteasQuote,
  explorerGet,
  batchErc20Balances,
} from "../../../data/index.js";
import type { AppConfig } from "../../../types.js";
import { ok } from "../../../utils/result.js";
import { assertAddress } from "../../../utils/safety.js";
import { registerTool } from "../../define.js";
import { pctChange, sumSanePairLiquidity } from "../helpers.js";
import {
  buildPiteasAccumulationPlan,
} from "../piteasAccumulationPlan.js";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("PHIAT token contract address. Identity is address-first; symbol is never used for resolution.");

const optionalAddressListSchema = z
  .array(addressSchema)
  .max(25)
  .optional()
  .describe("Optional user-supplied labels. Classification is not verified by the tool.");

const decimalStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .optional()
  .describe("Optional human-token whale threshold, e.g. \"1000000\". Scientific notation is not accepted.");

import {
  DAY_FETCH_LIMIT,
  DEFAULT_PITEAS_DEPTH_MODE,
  DEFAULT_PITEAS_DEPTH_TIMEOUT_MS,
  DEFAULT_SWAP_LIMIT,
  MAX_PAIR_RESULTS,
  MAX_PITEAS_DEPTH_TIMEOUT_MS,
  MAX_SWAP_LIMIT,
  PAIR_FETCH_LIMIT,
  PHIAT_VERSION,
  SOURCE_TIMEOUT_MS,
  TRANSFER_EVENT_TOPIC0,
} from "./constants.js";
import {
  clampInt,
  dedupeFailures,
  errorMessage,
  integerOrNull,
  numberOrNull,
  round,
  stringOrNull,
  withTimeout,
} from "./math.js";
import { buildBoundedPiteasDepth } from "./piteasDepthFast.js";
import {
  buildHolderMetrics,
  buildSupplyFields,
  estimateExcludedSupply,
  normalizeAddressList,
  readLabeledBalances,
  resolveContractSupply,
} from "./holders.js";
import {
  assessLiquidityReliability,
  buildMarketSection,
  buildPrimaryPair,
  choosePrimaryDexPair,
  computeMarketCap,
  mapDashboardPairs,
} from "./marketData.js";
import { unixSecondsToIso } from "./dates.js";
import {
  mapRecentSwaps,
  mapRecentTransfers,
  selectLargeSwaps,
  transferLogCoverage,
  TRANSFER_LOGS_NOT_FULL_HISTORY,
} from "./transfers.js";
import {
  buildAgeSemantics,
  buildDeployerReputation,
  buildSafetyOutput,
  buildSafetyWarnings,
} from "./safety.js";



export type PiteasDepthMode = "fast" | "adaptive";
export type RecommendationStatus = "available" | "requote_required" | "unavailable";
export type RecommendationBasis = "batch_sandwich" | "adaptive_batch_sandwich" | "partial_evidence" | "none";
export type FreshnessConfidence = "high" | "medium" | "low";
export type ThresholdRecommendationStatus =
  | "available"
  | "partial_boundary"
  | "requote_required"
  | "unavailable";

export interface PhiatDashboardInput {
  tokenAddress: string;
  treasuryAddresses?: string[];
  stakingAddresses?: string[];
  whaleThreshold?: string;
  recentSwapLimit?: number;
  includePiteasDepth?: boolean;
  piteasDepthMode?: PiteasDepthMode;
  piteasDepthTimeoutMs?: number;
}

export interface PartialFailure {
  source: string;
  error: string;
}

export type PhiatDashboard = Record<string, unknown> & {
  dataQuality: {
    sources: string[];
    fetchedAt: string;
    partialFailures: PartialFailure[];
    assumptions: string[];
  };
};

export interface LabeledBalance {
  address: string;
  label: "user_supplied_treasury" | "user_supplied_staking";
  balanceRaw: string | null;
  balanceFormatted: string | null;
  balanceOk: boolean;
  balanceUsd: number | null;
  note: string;
}

export interface CaptureResult<T> {
  data: T | null;
  ok: boolean;
}

export interface ContractSupplyFields {
  contractTotalSupplyRaw: string | null;
  contractTotalSupplyFormatted: string | null;
  contractTotalSupplySource: string | null;
  maximumSupply: null;
  circulatingSupplyEstimate: {
    raw: string;
    formatted: string | null;
  } | null;
  circulatingSupplyMethod: string | null;
  excludedSupplyEstimate: {
    raw: string;
    formatted: string | null;
    source: string;
    includedAddresses: string[];
  } | null;
}

export interface HolderMetrics {
  topHolderShare: number | null;
  top10HolderShare: number | null;
  holderMetricsValid: boolean;
  holderMetricErrors: string[];
  holderSource: string | null;
  holderSampleSize: number;
  denominatorSupply: {
    raw: string | null;
    formatted: string | null;
    decimals: number | null;
    source: string | null;
  };
  holders: Array<{
    address: string;
    balanceRaw: string;
    balanceFormatted: string | null;
    share: number | null;
  }>;
}

export interface MetricPoint {
  value: number | null;
  source: string;
  timestamp: string | null;
  note?: string;
}

export interface PhiatDashboardDeps {
  fetchToken: typeof fetchToken;
  fetchTokenDayData: typeof fetchTokenDayData;
  fetchPairsForToken: typeof fetchPairsForToken;
  fetchSwapsAdvanced: typeof fetchSwapsAdvanced;
  getDexScreenerTokenPairs: typeof getDexScreenerTokenPairs;
  getTokenOverviewSoft: typeof getTokenOverviewSoft;
  getContractSourceCode: typeof getContractSourceCode;
  getTokenHolders: typeof getTokenHolders;
  getContractCreation: typeof getContractCreation;
  getAccountTxList: typeof getAccountTxList;
  explorerGet: typeof explorerGet;
  batchErc20Balances: typeof batchErc20Balances;
  getPiteasQuote: typeof getPiteasQuote;
  buildPiteasAccumulationPlan: typeof buildPiteasAccumulationPlan;
  now?: () => Date;
}

const defaultDeps: PhiatDashboardDeps = {
  fetchToken,
  fetchTokenDayData,
  fetchPairsForToken,
  fetchSwapsAdvanced,
  getDexScreenerTokenPairs,
  getTokenOverviewSoft,
  getContractSourceCode,
  getTokenHolders,
  getContractCreation,
  getAccountTxList,
  explorerGet,
  batchErc20Balances,
  getPiteasQuote,
  buildPiteasAccumulationPlan,
};

/**
 * Register the consolidated PHIAT dashboard. This tool is intentionally not
 * marked `write`; wallet/signing paths remain untouched.
 */
export function registerPhiatDashboardTool(
  server: McpServer,
  config: AppConfig,
  deps: PhiatDashboardDeps = defaultDeps,
): void {
  registerTool(server, config, {
    name: "phiat_dashboard",
    description:
      "Read-only PHIAT token research dashboard by contract address. Combines PulseX subgraph, " +
      "DexScreener, BlockScout, and optional user-labeled treasury/staking balance reads. " +
      "Never resolves PHIAT by symbol, never writes to disk, and never prepares/signs/executes transactions. " +
      "Treasury/staking classifications are caller-supplied labels, not verified facts.",
    category: "analytics",
    inputSchema: {
      tokenAddress: addressSchema,
      treasuryAddresses: optionalAddressListSchema,
      stakingAddresses: optionalAddressListSchema,
      whaleThreshold: decimalStringSchema,
      recentSwapLimit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SWAP_LIMIT)
        .default(DEFAULT_SWAP_LIMIT)
        .describe("Recent swap/transfer sample size. Capped at 50."),
      includePiteasDepth: z
        .boolean()
        .default(false)
        .describe("When true, include a bounded read-only Piteas depth summary. False makes zero Piteas calls."),
      piteasDepthMode: z
        .enum(["fast", "adaptive"])
        .default(DEFAULT_PITEAS_DEPTH_MODE)
        .describe("Piteas depth mode. fast uses a four-call dashboard quote sandwich; adaptive uses the standalone planner summary."),
      piteasDepthTimeoutMs: z
        .number()
        .int()
        .min(1)
        .max(MAX_PITEAS_DEPTH_TIMEOUT_MS)
        .default(DEFAULT_PITEAS_DEPTH_TIMEOUT_MS)
        .describe("Absolute Piteas depth deadline in milliseconds. Capped at 120000."),
    },
    handler: async (args, cfg) => {
      const data = await buildPhiatDashboard(
        cfg,
        {
          tokenAddress: args.tokenAddress as string,
          treasuryAddresses: args.treasuryAddresses as string[] | undefined,
          stakingAddresses: args.stakingAddresses as string[] | undefined,
          whaleThreshold: args.whaleThreshold as string | undefined,
          recentSwapLimit: args.recentSwapLimit as number | undefined,
          includePiteasDepth: args.includePiteasDepth as boolean | undefined,
          piteasDepthMode: args.piteasDepthMode as PiteasDepthMode | undefined,
          piteasDepthTimeoutMs: args.piteasDepthTimeoutMs as number | undefined,
        },
        deps,
      );
      return ok(
        data,
        data.dataQuality.partialFailures.map(
          (failure) => `${failure.source}: ${failure.error}`,
        ),
      );
    },
  });
}

export async function buildPhiatDashboard(
  config: AppConfig,
  input: PhiatDashboardInput,
  deps: PhiatDashboardDeps = defaultDeps,
): Promise<PhiatDashboard> {
  const tokenAddress = assertAddress(input.tokenAddress).toLowerCase();
  const treasuryAddresses = normalizeAddressList(input.treasuryAddresses);
  const stakingAddresses = normalizeAddressList(input.stakingAddresses);
  const recentSwapLimit = clampInt(
    input.recentSwapLimit ?? DEFAULT_SWAP_LIMIT,
    1,
    MAX_SWAP_LIMIT,
  );
  const requestedWhaleThreshold = input.whaleThreshold ?? null;
  const timeoutMs = Math.min(config.httpTimeoutMs || SOURCE_TIMEOUT_MS, SOURCE_TIMEOUT_MS);
  const piteasDepthMode = input.piteasDepthMode ?? DEFAULT_PITEAS_DEPTH_MODE;
  const piteasDepthTimeoutMs = clampInt(
    input.piteasDepthTimeoutMs ?? DEFAULT_PITEAS_DEPTH_TIMEOUT_MS,
    1,
    MAX_PITEAS_DEPTH_TIMEOUT_MS,
  );

  const partialFailures: PartialFailure[] = [];
  const sources = new Set<string>();

  const capture = async <T>(
    source: string,
    task: () => Promise<T>,
  ): Promise<CaptureResult<T>> => {
    try {
      const data = await withTimeout(task(), timeoutMs, source);
      sources.add(source);
      return { ok: true, data };
    } catch (err) {
      partialFailures.push({
        source,
        error: errorMessage(err),
      });
      return { ok: false, data: null };
    }
  };
  const piteasDepthPromise = input.includePiteasDepth
    ? buildBoundedPiteasDepth(config, deps, tokenAddress, {
        mode: piteasDepthMode,
        timeoutMs: piteasDepthTimeoutMs,
      })
    : Promise.resolve(null);

  const [
    tokenRes,
    dayRes,
    pairsRes,
    dexRes,
    overviewRes,
    swapsRes,
    transfersRes,
    sourceRes,
    holdersRes,
    creationRes,
    piteasDepth,
  ] = await Promise.all([
    capture("pulsex_subgraph.token.v2", () =>
      deps.fetchToken(config, tokenAddress, PHIAT_VERSION),
    ),
    capture("pulsex_subgraph.tokenDayData.v2", () =>
      deps.fetchTokenDayData(config, tokenAddress, DAY_FETCH_LIMIT, PHIAT_VERSION),
    ),
    capture("pulsex_subgraph.pairsForToken.v2", () =>
      deps.fetchPairsForToken(config, tokenAddress, PAIR_FETCH_LIMIT, PHIAT_VERSION),
    ),
    capture("dexscreener.tokenPairs", () =>
      deps.getDexScreenerTokenPairs(config, tokenAddress, {
        chainId: "pulsechain",
      }),
    ),
    capture("blockscout.tokenOverview", () =>
      deps.getTokenOverviewSoft(config, tokenAddress, { holderLimit: 10 }),
    ),
    capture("pulsex_subgraph.recentSwaps.v2", () =>
      deps.fetchSwapsAdvanced(config, {
        token: tokenAddress,
        first: recentSwapLimit,
        version: PHIAT_VERSION,
      }),
    ),
    capture("blockscout.tokenTransfers", () =>
      deps.explorerGet(config, {
        module: "logs",
        action: "getLogs",
        address: tokenAddress,
        fromBlock: 0,
        toBlock: "latest",
        topic0: TRANSFER_EVENT_TOPIC0,
        page: 1,
        offset: recentSwapLimit,
      }),
    ),
    capture("blockscout.contractSource", () =>
      deps.getContractSourceCode(config, tokenAddress),
    ),
    capture("blockscout.topHolders", () =>
      deps.getTokenHolders(config, tokenAddress, { limit: 10 }),
    ),
    capture("blockscout.contractCreation", () =>
      deps.getContractCreation(config, tokenAddress),
    ),
    piteasDepthPromise,
  ]);
  if (piteasDepth !== null) {
    sources.add("piteas.quote");
    const depthFailures = piteasDepth.partialFailures as PartialFailure[] | undefined;
    if (depthFailures?.length) partialFailures.push(...depthFailures);
  }

  const fetchedAt = new Date().toISOString();
  const tokenEntity = tokenRes.data?.token ?? null;
  const overview =
    overviewRes.data?.ok === true ? overviewRes.data.data : null;
  if (overviewRes.data?.ok === false) {
    partialFailures.push({
      source: "blockscout.tokenOverview",
      error: overviewRes.data.reason,
    });
  }
  if (overview?.sourcesUsed) {
    for (const source of overview.sourcesUsed) sources.add(`blockscout.${source}`);
  }

  const dexPairs =
    dexRes.data?.ok === true ? dexRes.data.data.pairs : [];
  if (dexRes.data?.ok === false) {
    partialFailures.push({
      source: "dexscreener.tokenPairs",
      error: dexRes.data.reason,
    });
  }

  const pairs = pairsRes.data ?? [];
  const mappedPairs = mapDashboardPairs(pairs, tokenAddress);
  const liquiditySummary = pairsRes.ok
    ? sumSanePairLiquidity(pairs)
    : null;
  const totalLiquidityUsd = liquiditySummary?.totalUsd ?? null;
  const largestPair = mappedPairs.find((p) => p.liquidityUsd > 0) ?? mappedPairs[0] ?? null;
  const primaryDexPair = choosePrimaryDexPair(dexPairs, tokenAddress);
  const primaryPair = buildPrimaryPair(primaryDexPair, largestPair);

  const dayData = dayRes.data?.tokenDayDatas ?? [];
  const today = dayData[0];
  const yesterday = dayData[1];
  const subgraphPriceUsd = numberOrNull(tokenEntity?.derivedUSD);
  const subgraphPricePls = numberOrNull(tokenEntity?.derivedPLS);
  const primaryPairPriceUsd = numberOrNull(primaryDexPair?.priceUsd);
  const primaryPairPriceNative = numberOrNull(primaryDexPair?.priceNative);
  const tokenAggregateVolume24hUsd = numberOrNull(today?.dailyVolumeUSD);
  const primaryPairVolume24hUsd = numberOrNull(primaryDexPair?.volume?.h24);
  const tokenAggregatePriceChange24h =
    today && yesterday
      ? pctChange(
          numberOrNull(today.priceUSD) ?? Number.NaN,
          numberOrNull(yesterday.priceUSD) ?? Number.NaN,
        )
      : null;
  const primaryPairPriceChange24h = numberOrNull(primaryDexPair?.priceChange?.h24);
  const decimals = integerOrNull(tokenEntity?.decimals ?? overview?.decimals);
  const contractSupplyBase = resolveContractSupply(tokenEntity, overview, decimals);
  const subgraphMarketCap = computeMarketCap(
    contractSupplyBase.contractTotalSupplyRaw,
    decimals,
    subgraphPriceUsd,
  );

  const [knownTreasuryBalances, knownStakingBalances] = await Promise.all([
    readLabeledBalances(
      config,
      deps,
      capture,
      tokenAddress,
      treasuryAddresses,
      "user_supplied_treasury",
      decimals,
      subgraphPriceUsd ?? primaryPairPriceUsd,
    ),
    readLabeledBalances(
      config,
      deps,
      capture,
      tokenAddress,
      stakingAddresses,
      "user_supplied_staking",
      decimals,
      subgraphPriceUsd ?? primaryPairPriceUsd,
    ),
  ]);
  const estimatedExcludedSupply = estimateExcludedSupply(
    [...knownTreasuryBalances, ...knownStakingBalances],
    decimals,
  );
  const supplyFields = buildSupplyFields(
    contractSupplyBase,
    estimatedExcludedSupply,
    decimals,
  );

  const holderMetrics = buildHolderMetrics({
    holders: holdersRes.ok ? holdersRes.data?.items ?? [] : [],
    contractTotalSupplyRaw: supplyFields.contractTotalSupplyRaw,
    decimals,
    denominatorSource: supplyFields.contractTotalSupplySource,
    holderSource: holdersRes.ok ? "blockscout.topHolders" : null,
    sourceAvailable: holdersRes.ok,
  });

  const liquidityReliability = assessLiquidityReliability(totalLiquidityUsd);
  const primaryPairConcentrationPercent =
    totalLiquidityUsd !== null && totalLiquidityUsd > 0 && largestPair
      ? round((largestPair.liquidityUsd / totalLiquidityUsd) * 100, 4)
      : null;

  const ageSemantics = buildAgeSemantics({
    creationRaw: creationRes.data,
    creationAvailable: creationRes.ok,
    primaryDexPair,
    dayData,
  });

  const market = buildMarketSection({
    fetchedAt,
    tokenDayTimestamp: today ? unixSecondsToIso(today.date) : null,
    subgraphPriceUsd,
    subgraphPricePls,
    primaryPairPriceUsd,
    primaryPairPriceNative,
    totalLiquidityUsd,
    primaryPairLiquidityUsd: numberOrNull(primaryDexPair?.liquidity?.usd),
    tokenAggregateVolume24hUsd,
    primaryPairVolume24hUsd,
    tokenAggregatePriceChange24h,
    primaryPairPriceChange24h,
    subgraphMarketCap,
    dexScreenerMarketCap: numberOrNull(primaryDexPair?.marketCap),
    dexScreenerFdv: numberOrNull(primaryDexPair?.fdv),
    primaryPair,
    dex: primaryDexPair?.dexId ?? (largestPair ? "pulsex_v2" : null),
  });

  const recentSwaps = mapRecentSwaps(swapsRes.data?.swaps ?? []);
  const largeRecentSwaps = selectLargeSwaps(
    recentSwaps,
    tokenAddress,
    requestedWhaleThreshold,
  );
  const transferFromBlock = 0;
  const transferToBlock = "latest";
  const transferPage = 1;
  const recentTransfers = mapRecentTransfers(transfersRes.data, recentSwapLimit);
  const transferCoverage = transferLogCoverage(transfersRes.data, {
    fromBlock: transferFromBlock,
    toBlock: transferToBlock,
    offset: recentSwapLimit,
    page: transferPage,
  });
  if (swapsRes.data?.filterError) {
    partialFailures.push({
      source: "pulsex_subgraph.recentSwaps.v2",
      error: swapsRes.data.filterError,
    });
  }

  const safety = buildSafetyOutput({
    tokenAddress,
    tokenEntity,
    sourceRows: sourceRes.data ?? null,
    holderMetrics,
    totalLiquidityUsd,
    liquidityReliability,
    ageSemantics,
    sourceAvailable: sourceRes.ok,
  });

  const deployerReputation = await buildDeployerReputation({
    config,
    deps,
    capture,
    tokenAddress,
    creationRaw: creationRes.data,
  });

  const safetyWarnings = buildSafetyWarnings(
    tokenEntity,
    safety,
    partialFailures,
    liquidityReliability,
    market.warnings,
  );

  return {
    token: {
      address: tokenAddress,
      name: stringOrNull(tokenEntity?.name ?? overview?.name),
      symbol: stringOrNull(tokenEntity?.symbol ?? overview?.symbol),
      decimals,
      ...supplyFields,
    },
    market,
    liquidity: {
      pairs: mappedPairs.slice(0, MAX_PAIR_RESULTS),
      totalLiquidityUsd,
      largestPair,
      concentrationPercent: primaryPairConcentrationPercent,
      primaryPairConcentrationPercent,
      liquidityRiskLevel: liquidityReliability.liquidityRiskLevel,
      liquidityReliabilityWarning:
        liquidityReliability.liquidityReliabilityWarning,
      liquidityReliabilityThresholds: liquidityReliability.thresholds,
    },
    piteasDepth,
    holderAnalysis: {
      requestedWhaleThreshold,
      knownTreasuryBalances,
      knownStakingBalances,
      excludedSupplyEstimate: estimatedExcludedSupply,
      topHolderShare: holderMetrics.topHolderShare,
      top10HolderShare: holderMetrics.top10HolderShare,
      holderMetricsValid: holderMetrics.holderMetricsValid,
      holderMetricErrors: holderMetrics.holderMetricErrors,
      holderSource: holderMetrics.holderSource,
      holderSampleSize: holderMetrics.holderSampleSize,
      denominatorSupply: holderMetrics.denominatorSupply,
      sampledHolders: holderMetrics.holders,
      notes: [
        "Treasury and staking classifications are caller-supplied labels and are not independently verified.",
        "requestedWhaleThreshold is interpreted as human token units for recent-swap filtering; it is not a verified holder classification.",
        "excludedSupplyEstimate only sums successful reads for the user-supplied treasury/staking addresses.",
        "Holder concentration is used for safety only when the dedicated holder endpoint succeeds and all share checks pass.",
      ],
    },
    activity: {
      recentSwaps,
      largeRecentSwaps,
      recentTransfers,
      recentTransfersMethod:
        "BlockScout logs/getLogs for ERC-20 Transfer(address,address,uint256) events by token contract address.",
      truncated: transferCoverage.truncated,
      window: transferCoverage.window,
      note: TRANSFER_LOGS_NOT_FULL_HISTORY,
    },
    safety: {
      ...safety,
      deployerReputation,
      warnings: safetyWarnings,
    },
    age: ageSemantics,
    dataQuality: {
      sources: [...sources].sort(),
      fetchedAt,
      partialFailures: dedupeFailures(partialFailures),
      assumptions: [
        "Dashboard treats the supplied contract address as PHIAT; it never resolves by symbol or ticker.",
        "Null means unavailable or not reported by upstream; numeric 0 means an upstream source reported zero after parsing.",
        "PulseX V2 is used for subgraph market/liquidity/activity samples.",
        `Recent activity is capped at ${recentSwapLimit} rows; liquidity pairs are capped at ${MAX_PAIR_RESULTS} display rows.`,
        "DexScreener and subgraph USD fields are advisory market data, not oracle-grade settlement prices.",
        "Liquidity reliability thresholds: critical below $10,000, high below $50,000, medium below $250,000, low at or above $250,000.",
        "verifiedContractAgeDays is populated only from a successful contract-creation record with a timestamp; indexed activity and pair age are reported separately.",
        "maximumSupply is never inferred from current totalSupply; it remains null unless independently documented by an upstream source.",
        "No transaction signing, transaction preparation, broadcasting, wallet mutation, or disk writes are performed.",
        "Piteas depth is omitted unless includePiteasDepth is true; when included it is a bounded summary and does not expose the full quote ladder.",
      ],
    },
  };
}

export interface PiteasDepthOptions {
  mode: PiteasDepthMode;
  timeoutMs: number;
}

export interface FastQuoteSummary {
  inputHuman: string;
  inputRaw: string;
  outputRaw: string | null;
  outputHuman: string | null;
  minimumOutputRaw: string | null;
  minimumOutputHuman: string | null;
  averagePrice: number | null;
  quoteIdentifier: string | null;
  quoteTimestamp: string | null;
  expiresAt: string | null;
  blockNumber: string | null;
  responseFingerprint: string | null;
  cacheHeaders: Record<string, string> | null;
  endpoint: string | null;
  routeSignature: string | null;
  validationErrors: string[];
}

export interface FastQuoteAttempt {
  label: "reference_before" | "lower_candidate" | "upper_candidate" | "reference_after" | "optional_midpoint";
  inputHuman: string;
  inputRaw: string;
  requestStartedAt: string | null;
  responseReceivedAt: string | null;
  elapsedMs: number | null;
  timeoutMs: number;
  ok: boolean;
  rawQuoteSucceeded: boolean;
  timedOut: boolean;
  error: string | null;
  quote: FastQuoteSummary | null;
}

export interface FastFreshnessAnalysis {
  referenceEqualityDetected: boolean;
  possibleCacheDetected: boolean;
  freshnessConfidence: FreshnessConfidence;
  freshnessAcceptable: boolean;
  classification: "unchanged_market" | "possible_cache" | "unknown" | "freshened";
  warnings: string[];
}

export interface FastPiteasEvaluation {
  recommendationStatus: RecommendationStatus;
  recommendationBasis: RecommendationBasis;
  analyticalRecommendationStatus: ThresholdRecommendationStatus;
  operationalRecommendationStatus: ThresholdRecommendationStatus;
  analyticalMaximumBelowThresholdHuman: string | null;
  analyticalLargestConfirmedBelowThresholdHuman: string | null;
  analyticalFirstConfirmedAboveThresholdHuman: string | null;
  analyticalThresholdBoundaryBracketed: boolean;
  operationalMaximumTrancheHuman: string | null;
  operationalLargestConfirmedBelowThresholdHuman: string | null;
  operationalFirstConfirmedAboveThresholdHuman: string | null;
  operationalRecommendedMaximumTrancheHuman: string | null;
  operationalThresholdBoundaryBracketed: boolean;
  firstConfirmedAboveThresholdHuman: string | null;
  thresholdBoundaryBracketed: boolean;
  lowerDeteriorationPercent: number | null;
  upperDeteriorationPercent: number | null;
  referenceDriftPercent: number | null;
  freshness: FastFreshnessAnalysis;
  warnings: string[];
}
