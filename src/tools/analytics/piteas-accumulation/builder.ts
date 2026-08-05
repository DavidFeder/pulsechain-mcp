/**
 * Research-only Piteas accumulation planner.
 *
 * Builds address-first eUSDC -> PHIAT quote research using Piteas quotes only.
 * It does not prepare transactions, sign, submit, broadcast, write files, or
 * call account-control paths.
 */

import {
  getPiteasQuote,
} from "../../../data/piteas.js";
import type { AppConfig } from "../../../types.js";
import { assertAddress } from "../../../utils/safety.js";

import {
  SAME_STATE_WARNING,
  DEFAULT_EUSDC_DECIMALS,
  DEFAULT_PHIAT_DECIMALS,
  PRICE_SCALE_DECIMALS,
  DEFAULT_MAX_BLOCK_SPREAD,
  DEFAULT_MAX_COLLECTION_DURATION_MS,
  DEFAULT_MAX_QUOTE_AGE_SPREAD_MS,
  DEFAULT_MAX_PAIR_WINDOW_MS,
  DEFAULT_MAX_BATCH_WINDOW_MS,
  DEFAULT_MAX_REFERENCE_DRIFT_PERCENT,
  DEFAULT_MAX_ADAPTIVE_ROUNDS,
  DEFAULT_TRANCHE_INCREMENT_HUMAN,
  DEFAULT_OPERATIONAL_SAFETY_BUFFER_PERCENT,
} from "./constants.js";
import type {
  PiteasAccumulationPlanDeps,
  PiteasAccumulationPlanInput,
} from "./types.js";
import {
  assertDecimals,
  formatBpsAsPercent,
  formatRawAmount,
  isSuccessfulPoint,
  nowIso,
  parseHumanAmount,
  percentToBps,
} from "./decimalMath.js";
import { createQuoteScheduler } from "./quoteScheduler.js";
import { collectQuoteSet } from "./quoteNormalization.js";
import {
  buildLocalQuoteClusters,
  buildSnapshotMetadata,
  decorateCurve,
  validateMonotonicity,
} from "./coherence.js";
import {
  buildQuoteLadder,
  normalizeCandidateChunkCounts,
  normalizeConfirmationCandidateSizes,
  normalizeQuoteConcurrency,
  normalizeReferenceAmountCandidates,
  normalizeSnapshotLimits,
  normalizeThresholds,
} from "./inputNormalization.js";
import { buildPairedReferenceAnalysis } from "./pairedReference.js";
import {
  buildBatchConfirmation,
  emptyBatchConfirmation,
} from "./batchSandwich.js";
import {
  adaptivePartialFailures,
  adaptiveThresholdSearchNotRun,
  batchPartialFailures,
  buildAdaptiveThresholdSearch,
  latestAdaptiveBatch,
} from "./adaptiveSearch.js";
import {
  buildConservativeSequentialEstimate,
  buildIndependentQuoteComparison,
} from "./sequentialAnalysis.js";
import { buildStopRules } from "./operationalGuardrails.js";
import {
  bestPoint,
  buildRouteChanges,
  buildThresholdCrossings,
  worstPoint,
} from "./recommendationPrimitives.js";
import { buildBestRouteEnvelope } from "./bestRouteEnvelope.js";
import {
  buildManualGuardrails,
  buildNoRecommendationPlans,
  buildOperationalTranchePlan,
  buildPlanCategories,
} from "./planOutputs.js";
import {
  buildRecommendationState,
  selectRouteLocalSource,
} from "./recommendations.js";
import { buildWarnings } from "./warnings.js";
import { buildFocusedRefresh, focusedRefreshStatusFromPayload } from "./focusedRefresh.js";

















export const defaultDeps: PiteasAccumulationPlanDeps = {
  getPiteasQuote,
};

export async function buildPiteasAccumulationPlan(
  config: AppConfig,
  input: PiteasAccumulationPlanInput,
  deps: PiteasAccumulationPlanDeps = defaultDeps,
): Promise<Record<string, unknown>> {
  const tokenInAddress = input.eUsdcAddress ?? input.tokenIn;
  const tokenOutAddress = input.phiatAddress ?? input.tokenOut;
  if (!tokenInAddress) {
    throw new Error("tokenIn/eUsdcAddress is required");
  }
  if (!tokenOutAddress) {
    throw new Error("tokenOut/phiatAddress is required");
  }
  const eUsdcAddress = assertAddress(tokenInAddress).toLowerCase();
  const phiatAddress = assertAddress(tokenOutAddress).toLowerCase();
  if (eUsdcAddress === phiatAddress) {
    throw new Error("eUsdcAddress and phiatAddress must differ");
  }
  const account = input.account ? assertAddress(input.account).toLowerCase() : undefined;
  const eUsdcDecimals = input.eUsdcDecimals ?? DEFAULT_EUSDC_DECIMALS;
  const phiatDecimals = input.phiatDecimals ?? DEFAULT_PHIAT_DECIMALS;
  assertDecimals(eUsdcDecimals, "eUsdcDecimals");
  assertDecimals(phiatDecimals, "phiatDecimals");

  const totalBudgetRaw = parseHumanAmount(
    input.totalBudgetHuman,
    eUsdcDecimals,
    "totalBudgetHuman",
  );
  if (totalBudgetRaw <= 0n) {
    throw new Error("totalBudgetHuman must be positive");
  }
  const allowedSlippagePercent = input.allowedSlippagePercent ?? 0.5;
  const thresholds = normalizeThresholds(
    input.priceImpactThresholdsPercent ??
      (input.maxPriceImpactPercent !== undefined
        ? [input.maxPriceImpactPercent]
        : undefined),
  );
  const primaryThresholdBps = percentToBps(thresholds[0] ?? 2);
  const maxGasCostBps = percentToBps(input.maxGasCostPercentOfChunk ?? 1);
  const includeGasEstimate = input.includeGasEstimate ?? true;
  const maximumAveragePriceRaw = input.maximumAcceptableAveragePrice
    ? parseHumanAmount(
        input.maximumAcceptableAveragePrice,
        PRICE_SCALE_DECIMALS,
        "maximumAcceptableAveragePrice",
      )
    : null;
  const snapshotLimits = normalizeSnapshotLimits(input);
  const candidateChunkCounts = normalizeCandidateChunkCounts(input.candidateChunkCounts);
  const confirmationMode = input.confirmationMode ?? "adaptive";
  const quoteConcurrency = normalizeQuoteConcurrency(input.quoteConcurrency);
  const referenceAmountsRaw = normalizeReferenceAmountCandidates(
    input.referenceAmountCandidatesHuman,
    eUsdcDecimals,
    totalBudgetRaw,
  );
  const confirmationCandidateSizesRaw = normalizeConfirmationCandidateSizes(
    input.confirmationCandidateSizesHuman,
    input.pairedCandidateSizesHuman,
    eUsdcDecimals,
    totalBudgetRaw,
  );
  const maximumReferenceDriftBps = percentToBps(
    input.maximumReferenceDriftPercent ?? DEFAULT_MAX_REFERENCE_DRIFT_PERCENT,
  );
  const maximumAdaptiveRounds =
    input.maximumAdaptiveRounds ?? DEFAULT_MAX_ADAPTIVE_ROUNDS;
  const maximumBracketWidthRaw = input.maximumBracketWidthHuman
    ? parseHumanAmount(
        input.maximumBracketWidthHuman,
        eUsdcDecimals,
        "maximumBracketWidthHuman",
      )
    : null;
  if (maximumBracketWidthRaw !== null && maximumBracketWidthRaw <= 0n) {
    throw new Error("maximumBracketWidthHuman must be positive");
  }
  const trancheIncrementRaw = parseHumanAmount(
    input.trancheIncrementHuman ?? DEFAULT_TRANCHE_INCREMENT_HUMAN,
    eUsdcDecimals,
    "trancheIncrementHuman",
  );
  if (trancheIncrementRaw <= 0n) {
    throw new Error("trancheIncrementHuman must be positive");
  }
  const operationalSafetyBufferPercent =
    input.operationalSafetyBufferPercent ??
    DEFAULT_OPERATIONAL_SAFETY_BUFFER_PERCENT;
  const operationalSafetyBufferBps = percentToBps(operationalSafetyBufferPercent);
  const operationalThresholdBps =
    primaryThresholdBps > operationalSafetyBufferBps
      ? primaryThresholdBps - operationalSafetyBufferBps
      : 0n;
  const allowLowConfidenceFreshness =
    input.allowLowConfidenceFreshness === true;
  const scheduler = createQuoteScheduler({
    config,
    deps,
    selectedConcurrency: quoteConcurrency,
  });
  const quoteSizeLadderHuman =
    input.quoteSizeLadderHuman ?? input.quoteSizesHuman;

  const ladder = buildQuoteLadder({
    explicitLadderHuman: quoteSizeLadderHuman,
    chunkSizeHuman: input.chunkSizeHuman,
    generatedSteps: input.generatedLadderSteps,
    totalBudgetRaw,
    decimals: eUsdcDecimals,
  });

  const broad = await collectQuoteSet({
    config,
    deps,
    scheduler,
    purpose: "broad_discovery",
    sizesRaw: ladder.sizesRaw,
    eUsdcAddress,
    phiatAddress,
    account,
    allowedSlippagePercent,
    eUsdcDecimals,
    phiatDecimals,
    thresholds,
    maxGasCostBps,
    includeGasEstimate,
    allowRetries: true,
  });
  decorateCurve(broad.points, {
    eUsdcDecimals,
    phiatDecimals,
    thresholds,
  });

  const broadSnapshot = buildSnapshotMetadata(broad, snapshotLimits);
  const broadMonotonicity = validateMonotonicity(
    broad.points,
    broadSnapshot,
    snapshotLimits,
    eUsdcDecimals,
    phiatDecimals,
  );
  const broadClusters = buildLocalQuoteClusters({
    points: broad.points,
    purpose: "broad_discovery",
    limits: snapshotLimits,
    thresholds,
    eUsdcDecimals,
    phiatDecimals,
    clusterPrefix: "broad",
  });
  const broadBestRouteEnvelope = buildBestRouteEnvelope({
    collection: broad,
    source: "broad_discovery",
    limits: snapshotLimits,
    thresholds,
    primaryThresholdBps,
    eUsdcDecimals,
    phiatDecimals,
  });

  const focusedRefresh =
    input.focusedRefresh === false
      ? null
      : await buildFocusedRefresh({
          config,
          deps,
          input,
          scheduler,
          eUsdcAddress,
          phiatAddress,
          account,
          totalBudgetRaw,
          allowedSlippagePercent,
          eUsdcDecimals,
          phiatDecimals,
          thresholds,
          maxGasCostBps,
          snapshotLimits,
          broadPoints: broad.points,
          includeGasEstimate,
        });
  const focusedRefreshStatus = focusedRefreshStatusFromPayload(focusedRefresh);

  const pairedReferenceAnalysis = await buildPairedReferenceAnalysis({
    config,
    deps,
    scheduler,
    request: input,
    eUsdcAddress,
    phiatAddress,
    account,
    totalBudgetRaw,
    allowedSlippagePercent,
    eUsdcDecimals,
    phiatDecimals,
    thresholds,
    maxGasCostBps,
    snapshotLimits,
    primaryThresholdBps,
          includeGasEstimate,
        });
  const directBatchCandidateSizesRaw =
    confirmationCandidateSizesRaw.length > 0
      ? confirmationCandidateSizesRaw
      : ladder.sizesRaw;
  const adaptiveThresholdSearch =
    confirmationMode === "adaptive"
      ? await buildAdaptiveThresholdSearch({
          config,
          deps,
          scheduler,
          eUsdcAddress,
          phiatAddress,
          account,
          allowedSlippagePercent,
          eUsdcDecimals,
          phiatDecimals,
          thresholds,
          maxGasCostBps,
          primaryThresholdBps,
          referenceAmountsRaw,
          initialCandidateSizesRaw: confirmationCandidateSizesRaw,
          discoveryEnvelope: broadBestRouteEnvelope,
          maximumBatchWindowMs: snapshotLimits.maximumBatchWindowMs,
          maximumReferenceDriftBps,
          quoteConcurrency,
          maximumAdaptiveRounds,
          maximumBracketWidthRaw,
          allowLowConfidenceFreshness,
          totalBudgetRaw,
          includeGasEstimate,
        })
      : adaptiveThresholdSearchNotRun();
  const batchConfirmation =
    confirmationMode === "batch_sandwich"
      ? await buildBatchConfirmation({
          config,
          deps,
          scheduler,
          eUsdcAddress,
          phiatAddress,
          account,
          allowedSlippagePercent,
          eUsdcDecimals,
          phiatDecimals,
          thresholds,
          maxGasCostBps,
          primaryThresholdBps,
          referenceAmountsRaw,
          candidateSizesRaw: directBatchCandidateSizesRaw,
          maximumBatchWindowMs: snapshotLimits.maximumBatchWindowMs,
          maximumReferenceDriftBps,
          quoteConcurrency,
          allowLowConfidenceFreshness,
          includeGasEstimate,
        })
      : latestAdaptiveBatch(adaptiveThresholdSearch) ??
        emptyBatchConfirmation({
          quoteConcurrency,
          rejectedReferenceAmounts: [],
          reason: "not_run",
        });
  const piteasReliability = scheduler.metrics();

  const recommendationState = buildRecommendationState({
    focusedRefresh,
    focusedRefreshStatus,
    broadBestRouteEnvelope,
    pairedReferenceAnalysis,
    batchConfirmation,
    adaptiveThresholdSearch,
    broadClusters,
    broadPoints: broad.points,
    primaryThresholdBps,
  });
  const recommendation = recommendationState.source;
  const routeLocalSource = selectRouteLocalSource({
    focusedRefresh,
    focusedRefreshStatus,
    broadClusters,
    broadPoints: broad.points,
  });
  const recommendationPoints =
    recommendation !== null ? recommendation.points : [];
  const operationalPlan = buildOperationalTranchePlan({
    recommendationState,
    adaptiveThresholdSearch,
    batchConfirmation,
    bestRouteEnvelope: recommendationState.source?.envelope ?? broadBestRouteEnvelope,
    pairedReferenceAnalysis,
    eUsdcDecimals,
    trancheIncrementRaw,
    primaryThresholdBps,
    operationalThresholdBps,
    operationalSafetyBufferPercent,
  });
  const guardrails = buildManualGuardrails({
    selectedBatch: latestAdaptiveBatch(adaptiveThresholdSearch) ?? batchConfirmation,
    operationalPlan,
    maximumReferenceDriftPercent:
      input.maximumReferenceDriftPercent ?? DEFAULT_MAX_REFERENCE_DRIFT_PERCENT,
    maximumBatchWindowMs: snapshotLimits.maximumBatchWindowMs,
  });
  const sequentialSourcePoints =
    routeLocalSource?.points.length
      ? routeLocalSource.points
      : recommendationPoints.length > 0
        ? recommendationPoints
        : broad.points.filter(isSuccessfulPoint);
  const independentQuoteComparison = buildIndependentQuoteComparison(
    sequentialSourcePoints,
    totalBudgetRaw,
    eUsdcDecimals,
    phiatDecimals,
  );
  const conservativeSequentialEstimate = buildConservativeSequentialEstimate(
    sequentialSourcePoints,
    totalBudgetRaw,
    eUsdcDecimals,
    phiatDecimals,
    primaryThresholdBps,
    maximumAveragePriceRaw,
  );
  const plans =
    recommendation !== null
      ? buildPlanCategories({
          successful: recommendation.points,
          sequential: conservativeSequentialEstimate,
          totalBudgetRaw,
          eUsdcDecimals,
          primaryThresholdBps,
          maximumAveragePriceRaw,
          maximumAcceptableAveragePrice: input.maximumAcceptableAveragePrice ?? null,
          maxGasCostPercentOfChunk: input.maxGasCostPercentOfChunk ?? 1,
          operationalPlan,
          recommendationState,
          bestRouteEnvelope: recommendationState.source?.envelope ?? broadBestRouteEnvelope,
          pairedReferenceAnalysis,
          batchConfirmation,
          adaptiveThresholdSearch,
        })
      : buildNoRecommendationPlans(recommendationState, operationalPlan);

  const routeChanges = buildRouteChanges(broad.points.filter(isSuccessfulPoint));
  const warnings = buildWarnings({
    broad,
    broadSnapshot,
    broadMonotonicity,
    routeChanges,
    focusedRefresh,
    bestRouteEnvelope: broadBestRouteEnvelope,
    pairedReferenceAnalysis,
    batchConfirmation,
    adaptiveThresholdSearch,
    piteasReliability,
    expectedIndividualPairRequestCount:
      pairedReferenceAnalysis.candidateSizesHuman.length > 0
        ? pairedReferenceAnalysis.candidateSizesHuman.length * 4
        : 0,
    expectedBatchRequestCount:
      confirmationMode === "individual_pairs"
        ? 0
        : 2 + directBatchCandidateSizesRaw.length,
    maximumPairWindowMs: snapshotLimits.maximumPairWindowMs,
    maximumBatchWindowMs: snapshotLimits.maximumBatchWindowMs,
    recommendationStatus: recommendationState.status,
          includeGasEstimate,
        });

  return {
    request: {
      tokenIn: eUsdcAddress,
      tokenOut: phiatAddress,
      eUsdcAddress,
      phiatAddress,
      totalBudgetRaw: totalBudgetRaw.toString(),
      totalBudgetHuman: formatRawAmount(totalBudgetRaw, eUsdcDecimals),
      eUsdcDecimals,
      phiatDecimals,
      quoteSizeLadderHuman: ladder.sizesRaw.map((size) =>
        formatRawAmount(size, eUsdcDecimals),
      ),
      quoteSizesHuman: ladder.sizesRaw.map((size) =>
        formatRawAmount(size, eUsdcDecimals),
      ),
      ladderSource: ladder.source,
      candidateChunkCounts,
      confirmationMode,
      allowLowConfidenceFreshness,
      referenceAmountCandidatesHuman: referenceAmountsRaw.map((amount) =>
        formatRawAmount(amount, eUsdcDecimals),
      ),
      confirmationCandidateSizesHuman: directBatchCandidateSizesRaw.map((amount) =>
        formatRawAmount(amount, eUsdcDecimals),
      ),
      allowedSlippagePercent,
      maxPriceImpactPercent: input.maxPriceImpactPercent ?? null,
      priceImpactThresholdsPercent: thresholds,
      includeGasEstimate: input.includeGasEstimate ?? true,
      maximumAcceptableAveragePrice: input.maximumAcceptableAveragePrice ?? null,
      snapshotLimits: {
        maxSnapshotBlockSpread: input.maxSnapshotBlockSpread ?? DEFAULT_MAX_BLOCK_SPREAD,
        maxSnapshotCollectionDurationMs:
          input.maxSnapshotCollectionDurationMs ?? DEFAULT_MAX_COLLECTION_DURATION_MS,
        maxQuoteAgeSpreadMs:
          input.maxQuoteAgeSpreadMs ?? DEFAULT_MAX_QUOTE_AGE_SPREAD_MS,
        maximumPairWindowMs: input.maximumPairWindowMs ?? DEFAULT_MAX_PAIR_WINDOW_MS,
        maximumBatchWindowMs:
          input.maximumBatchWindowMs ?? DEFAULT_MAX_BATCH_WINDOW_MS,
        maximumReferenceDriftPercent:
          input.maximumReferenceDriftPercent ??
          DEFAULT_MAX_REFERENCE_DRIFT_PERCENT,
        quoteConcurrency,
        maximumAdaptiveRounds,
        maximumBracketWidthHuman: input.maximumBracketWidthHuman ?? null,
        trancheIncrementHuman: formatRawAmount(trancheIncrementRaw, eUsdcDecimals),
        operationalSafetyBufferPercent,
        operationalThresholdPercent: formatBpsAsPercent(operationalThresholdBps),
      },
      focusedRefresh: input.focusedRefresh !== false,
      focusedRefreshStatus,
      pairedReferenceAmountHuman: input.pairedReferenceAmountHuman ?? null,
      pairedCandidateSizesHuman: input.pairedCandidateSizesHuman ?? null,
      maximumPairWindowMs: input.maximumPairWindowMs ?? DEFAULT_MAX_PAIR_WINDOW_MS,
      account: account ?? null,
    },
    quoteSnapshot: broadSnapshot,
    coherence: {
      classification: broadSnapshot.coherenceClass,
      atomicSnapshot: broadSnapshot.atomicSnapshot,
      doNotPresentAsOneExecutableCurve:
        broadSnapshot.coherenceClass === "stitched_multi_state",
      recommendationStatus: recommendationState.status,
      recommendationSource: recommendation?.source ?? null,
      recommendationSourceId: recommendation?.sourceId ?? null,
      recommendationBasis: recommendationState.basis,
      recommendationEvidence: recommendationState.evidence,
    },
    focusedRefreshStatus,
    monotonicityChecks: broadMonotonicity,
    executableQuoteDepth: broad.points,
    executableQuoteDepthSummary: {
      description:
        broadSnapshot.coherenceClass === "stitched_multi_state"
          ? "Broad discovery quotes are retained as research points only; this stitched ladder is not one executable curve."
          : "Executable read-only Piteas quotes for exact input sizes; this is quoted depth, not literal total liquidity.",
    },
    bestRouteEnvelope: broadBestRouteEnvelope,
    routeLocalCurves: {
      description:
        "Structurally compatible route-local quote curves. These are used for local marginal and allocation analysis, not required for best-route single-tranche comparisons.",
      localQuoteClusters: broadClusters,
      routeLocalRecommendationSource: routeLocalSource
        ? {
            source: routeLocalSource.source,
            sourceId: routeLocalSource.sourceId,
            quoteSizesHuman: routeLocalSource.points.map((point) => point.inputHuman),
          }
        : null,
    },
    sequentialExecutionAnalysis: {
      description:
        "Sequential execution analysis is separate from the best-route envelope and never assumes splitting improves output.",
      independentQuoteComparison,
      conservativeSequentialEstimate,
      warning: SAME_STATE_WARNING,
    },
    pairedReferenceAnalysis,
    batchConfirmation,
    adaptiveThresholdSearch,
    piteasReliability,
    quotedMarketDepth: {
      description:
        "Piteas quote depth across requested buy sizes. Marginal prices are calculated only inside compatible local clusters; cross-state comparisons are labeled non-executable.",
      largestSuccessfulInputHuman: broad.points.filter(isSuccessfulPoint).at(-1)?.inputHuman ?? null,
      largestSuccessfulOutputHuman: broad.points.filter(isSuccessfulPoint).at(-1)?.outputHuman ?? null,
      bestAveragePrice: bestPoint(broad.points.filter(isSuccessfulPoint))?.averagePrice ?? null,
      worstAveragePrice: worstPoint(broad.points.filter(isSuccessfulPoint))?.averagePrice ?? null,
      routeChanges,
      thresholdCrossings: buildThresholdCrossings(
        broad.points.filter(isSuccessfulPoint),
        thresholds,
      ),
      localQuoteClusters: broadClusters,
    },
    buySideDepthEstimate: {
      description:
        "Buy-side depth estimate inferred from read-only Piteas quotes; not a claim about total liquidity.",
      successfulQuoteCount: broad.points.filter(isSuccessfulPoint).length,
      failedQuoteCount: broad.failures.length,
      maxQuotedBudgetHuman: broad.points.filter(isSuccessfulPoint).at(-1)?.inputHuman ?? null,
      maxQuotedTokensHuman: broad.points.filter(isSuccessfulPoint).at(-1)?.outputHuman ?? null,
      coherentExecutableCurveAvailable:
        recommendationState.status === "available",
      recommendationBasis: recommendationState.basis,
      piteasReliability,
      warning: SAME_STATE_WARNING,
    },
    focusedRefresh,
    independentQuoteComparison,
    conservativeSequentialEstimate,
    plans,
    operationalTranchePlan: operationalPlan,
    guardrails,
    stopRules: buildStopRules(
      thresholds[0] ?? 2,
      input.maximumAcceptableAveragePrice ?? null,
      input.maxGasCostPercentOfChunk ?? 1,
    ),
    executionSafety: {
      researchOnly: true,
      readOnlyQuoteHelperCalled: "getPiteasQuote",
      forbiddenActionsCalled: false,
      transactionPrepared: false,
      transactionSigned: false,
      transactionSubmitted: false,
      transactionBroadcast: false,
      diskWrites: false,
      methodParametersOmitted: true,
    },
    dataQuality: {
      sources: ["piteas.quote"],
      fetchedAt: nowIso(deps),
      partialFailures: [
        ...broad.failures,
        ...pairedReferenceAnalysis.partialFailures,
        ...batchPartialFailures(batchConfirmation),
        ...adaptivePartialFailures(adaptiveThresholdSearch),
      ],
      warnings,
      assumptions: [
        SAME_STATE_WARNING,
        "independentQuoteComparison repeats same-state quote economics for comparison only.",
        "bestRouteEnvelope compares the best Piteas quote returned for each current single-tranche size; route changes are allowed and surfaced.",
        "Envelope marginal prices are cross-size comparisons and are not sequential execution forecasts.",
        "Paired reference mode brackets thresholds against nearby reference quotes to reduce long-run drift; a route change inside a pair is not itself a failure.",
        "Batch-sandwich mode compares candidate quotes against reference quotes collected before and after the batch; route changes are surfaced as warnings, not automatic invalidations.",
        "Adaptive confirmation uses fresh batch-sandwich rounds and does not insert failed confirmation retries into an existing batch.",
        "conservativeSequentialEstimate uses incrementalOutput(k) = Q(k * chunkSize) - Q((k - 1) * chunkSize) from the cumulative quote curve.",
        "conservativeSequentialEstimate uses incrementalOutput(k) = Q(k * chunkSize) - Q((k - 1) * chunkSize) from one cumulative quote curve.",
        "Cumulative sequential deltas telescope to Q(totalBudget) only when all deltas are from the same cumulative curve.",
        "Quote curve is reported as executableQuoteDepth, quotedMarketDepth, and buySideDepthEstimate; it is not described as literal total liquidity.",
        "eUSDC is treated as the input budget unit, not as an external USD oracle.",
        "Null means unavailable from Piteas or not computable from returned quote data.",
        "Route signatures use canonical protocol, pool, token-path, router, and allocation fields when Piteas provides them; path/swap counts are only a fallback structure.",
        "Operational tranche sizing rounds down in input-token units using trancheIncrementHuman after applying operationalSafetyBufferPercent to the analytical threshold.",
      ],
    },
  };
}
