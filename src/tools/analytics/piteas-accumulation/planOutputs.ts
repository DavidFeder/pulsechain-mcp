import { SAME_STATE_WARNING } from "./constants.js";
import { latestAdaptiveBatch, rawFromPlan } from "./adaptiveSearch.js";
import { batchCandidatePlan, batchThresholdPlans } from "./batchSandwich.js";
import { formatBpsAsPercent, formatRawAmount, percentStringToBps } from "./decimalMath.js";
import { buildStopRules, stopReasonsForPoint } from "./operationalGuardrails.js";
import { bestPoint, firstTrancheObservation, planFromPoint } from "./recommendationPrimitives.js";
import type {
  AdaptiveThresholdSearch,
  BatchConfirmation,
  BestRouteEnvelopeAnalysis,
  ManualGuardrails,
  OperationalTranchePlan,
  PairedReferenceAnalysis,
  RecommendationState,
  SuccessfulPoint,
} from "./types.js";

export function buildPlanCategories(input: {
  successful: SuccessfulPoint[];
  sequential: Record<string, unknown>;
  totalBudgetRaw: bigint;
  eUsdcDecimals: number;
  primaryThresholdBps: bigint;
  maximumAveragePriceRaw: bigint | null;
  maximumAcceptableAveragePrice: string | null;
  maxGasCostPercentOfChunk: number;
  operationalPlan: OperationalTranchePlan;
  recommendationState: RecommendationState;
  bestRouteEnvelope: BestRouteEnvelopeAnalysis;
  pairedReferenceAnalysis: PairedReferenceAnalysis;
  batchConfirmation: BatchConfirmation;
  adaptiveThresholdSearch: AdaptiveThresholdSearch;
}): Record<string, unknown> {
  const largest = input.successful.at(-1) ?? null;
  const lowest = bestPoint(input.successful);
  const acceptable = input.successful.filter(
    (point) =>
      stopReasonsForPoint(
        point,
        input.primaryThresholdBps,
        input.maximumAveragePriceRaw,
      ).length === 0,
  );
  const balanced = acceptable.at(-1) ?? lowest;
  const initial = input.successful[0] ?? null;
  const reserveRaw = initial ? input.totalBudgetRaw - BigInt(initial.inputRaw) : input.totalBudgetRaw;
  const selectedThreshold = selectedThresholdPlans(input);
  const batchThreshold = batchThresholdPlans(input.batchConfirmation);
  return {
    recommendationStatus: input.recommendationState.status,
    recommendationSource: input.recommendationState.source?.source ?? null,
    recommendationSourceId: input.recommendationState.source?.sourceId ?? null,
    recommendationBasis: input.recommendationState.basis,
    recommendationEvidence: input.recommendationState.evidence,
    maximumTokensNow:
      input.recommendationState.status === "available" && largest
        ? planFromPoint(largest)
        : null,
    lowestAveragePrice:
      input.recommendationState.evidence.hasAveragePriceTrend && lowest
        ? planFromPoint(lowest)
        : null,
    balancedPriceImpactAndGas:
      input.recommendationState.evidence.hasMarginalCurve && balanced
        ? planFromPoint(balanced)
        : null,
    conservativeLimitPlan: input.sequential,
    bestRouteLargestObservedBelowThreshold:
      input.bestRouteEnvelope.bestRouteLargestObservedBelowThreshold,
    bestRouteFirstObservedAboveThreshold:
      input.bestRouteEnvelope.bestRouteFirstObservedAboveThreshold,
    bestRouteThresholdBoundaryBracketed:
      input.bestRouteEnvelope.bestRouteThresholdBoundaryBracketed,
    bestRouteRecommendedMaximumTranche:
      input.bestRouteEnvelope.bestRouteRecommendedMaximumTranche,
    pairedLargestObservedBelowThreshold:
      input.pairedReferenceAnalysis.pairedLargestObservedBelowThreshold,
    pairedFirstObservedAboveThreshold:
      input.pairedReferenceAnalysis.pairedFirstObservedAboveThreshold,
    pairedThresholdBoundaryBracketed:
      input.pairedReferenceAnalysis.pairedThresholdBoundaryBracketed,
    pairedRecommendedMaximumTranche:
      input.pairedReferenceAnalysis.pairedRecommendedMaximumTranche,
    batchLargestObservedBelowThreshold:
      batchThreshold.largestObservedBelowThreshold,
    batchFirstObservedAboveThreshold:
      batchThreshold.firstObservedAboveThreshold,
    batchThresholdBoundaryBracketed:
      batchThreshold.thresholdBoundaryBracketed,
    batchRecommendedMaximumTranche:
      batchThreshold.recommendedMaximumTranche,
    adaptiveLargestObservedBelowThreshold:
      input.adaptiveThresholdSearch.finalLargestBelowThreshold,
    adaptiveFirstObservedAboveThreshold:
      input.adaptiveThresholdSearch.finalFirstAboveThreshold,
    adaptiveThresholdBoundaryBracketed:
      input.adaptiveThresholdSearch.thresholdBoundaryBracketed,
    adaptiveRecommendedMaximumTranche:
      input.adaptiveThresholdSearch.recommendedMaximumTranche,
    largestObservedBelowThreshold: selectedThreshold.largestObservedBelowThreshold,
    firstObservedAboveThreshold: selectedThreshold.firstObservedAboveThreshold,
    thresholdBoundaryBracketed:
      selectedThreshold.thresholdBoundaryBracketed,
    recommendedMaximumTranche: selectedThreshold.recommendedMaximumTranche,
    analyticalMaximumBelowThresholdHuman:
      input.operationalPlan.analyticalMaximumBelowThresholdHuman,
    bufferedMaximumHuman: input.operationalPlan.bufferedMaximumHuman,
    operationalMaximumTrancheHuman:
      input.operationalPlan.operationalMaximumTrancheHuman,
    trancheIncrementHuman: input.operationalPlan.trancheIncrementHuman,
    roundingPolicy: input.operationalPlan.roundingPolicy,
    analyticalThresholdPercent: input.operationalPlan.analyticalThresholdPercent,
    operationalThresholdPercent: input.operationalPlan.operationalThresholdPercent,
    operationalSafetyBufferPercent:
      input.operationalPlan.operationalSafetyBufferPercent,
    firstTrancheObservation:
      input.recommendationState.status === "first_quote_only" && initial
        ? firstTrancheObservation(initial)
        : null,
    stagedEntryPlan: {
      initialTrancheHuman: initial?.inputHuman ?? null,
      recommendedMaximumTranche: selectedThreshold.recommendedMaximumTranche,
      operationalMaximumTrancheHuman:
        input.operationalPlan.operationalMaximumTrancheHuman,
      reserveBudgetHuman: formatRawAmount(reserveRaw >= 0n ? reserveRaw : 0n, input.eUsdcDecimals),
      minimumAcceptableOutputHuman: initial?.minimumOutputHuman ?? null,
      maximumAcceptableAveragePrice: input.maximumAcceptableAveragePrice,
      requoteBeforeEveryExecution: true,
      stopConditions: buildStopRules(
        Number(input.primaryThresholdBps) / 100,
        input.maximumAcceptableAveragePrice,
        input.maxGasCostPercentOfChunk,
      ),
      rationale: [
        "Recommendation status follows adaptive batch-sandwich, batch-sandwich, paired-reference, best-route envelope, partial evidence, first-quote, then requote precedence.",
        "A recommended maximum tranche is returned only when the selected evidence source brackets the threshold inside its temporal limits.",
        "For first_quote_only, the first quote is an observation only and no future tranche size is recommended.",
        SAME_STATE_WARNING,
      ],
    },
  };
}

function selectedThresholdPlans(input: {
  recommendationState: RecommendationState;
  bestRouteEnvelope: BestRouteEnvelopeAnalysis;
  pairedReferenceAnalysis: PairedReferenceAnalysis;
  batchConfirmation: BatchConfirmation;
  adaptiveThresholdSearch: AdaptiveThresholdSearch;
}): {
  largestObservedBelowThreshold: Record<string, unknown> | null;
  firstObservedAboveThreshold: Record<string, unknown> | null;
  thresholdBoundaryBracketed: boolean;
  recommendedMaximumTranche: Record<string, unknown> | null;
} {
  if (input.recommendationState.basis === "adaptive_batch_sandwich") {
    return {
      largestObservedBelowThreshold:
        input.adaptiveThresholdSearch.finalLargestBelowThreshold,
      firstObservedAboveThreshold:
        input.adaptiveThresholdSearch.finalFirstAboveThreshold,
      thresholdBoundaryBracketed:
        input.adaptiveThresholdSearch.thresholdBoundaryBracketed,
      recommendedMaximumTranche:
        input.recommendationState.status === "available"
          ? input.adaptiveThresholdSearch.recommendedMaximumTranche
          : null,
    };
  }
  if (input.recommendationState.basis === "batch_sandwich") {
    const threshold = batchThresholdPlans(input.batchConfirmation);
    return {
      largestObservedBelowThreshold: threshold.largestObservedBelowThreshold,
      firstObservedAboveThreshold: threshold.firstObservedAboveThreshold,
      thresholdBoundaryBracketed: threshold.thresholdBoundaryBracketed,
      recommendedMaximumTranche:
        input.recommendationState.status === "available"
          ? threshold.recommendedMaximumTranche
          : null,
    };
  }
  if (input.recommendationState.basis === "paired_reference") {
    return {
      largestObservedBelowThreshold:
        input.pairedReferenceAnalysis.pairedLargestObservedBelowThreshold,
      firstObservedAboveThreshold:
        input.pairedReferenceAnalysis.pairedFirstObservedAboveThreshold,
      thresholdBoundaryBracketed:
        input.pairedReferenceAnalysis.pairedThresholdBoundaryBracketed,
      recommendedMaximumTranche:
        input.recommendationState.status === "available"
          ? input.pairedReferenceAnalysis.pairedRecommendedMaximumTranche
          : null,
    };
  }
  if (input.recommendationState.basis === "best_route_envelope") {
    return {
      largestObservedBelowThreshold:
        input.bestRouteEnvelope.bestRouteLargestObservedBelowThreshold,
      firstObservedAboveThreshold:
        input.bestRouteEnvelope.bestRouteFirstObservedAboveThreshold,
      thresholdBoundaryBracketed:
        input.bestRouteEnvelope.bestRouteThresholdBoundaryBracketed,
      recommendedMaximumTranche:
        input.recommendationState.status === "available"
          ? input.bestRouteEnvelope.bestRouteRecommendedMaximumTranche
          : null,
    };
  }
  return {
    largestObservedBelowThreshold:
      input.recommendationState.thresholdSemantics.largestObservedBelowThreshold
        ? planFromPoint(input.recommendationState.thresholdSemantics.largestObservedBelowThreshold)
        : null,
    firstObservedAboveThreshold:
      input.recommendationState.thresholdSemantics.firstObservedAboveThreshold
        ? planFromPoint(input.recommendationState.thresholdSemantics.firstObservedAboveThreshold)
        : null,
    thresholdBoundaryBracketed:
      input.recommendationState.thresholdSemantics.thresholdBoundaryBracketed,
    recommendedMaximumTranche:
      input.recommendationState.status === "available" &&
      input.recommendationState.thresholdSemantics.largestObservedBelowThreshold
        ? planFromPoint(input.recommendationState.thresholdSemantics.largestObservedBelowThreshold)
        : null,
  };
}

export function buildOperationalTranchePlan(input: {
  recommendationState: RecommendationState;
  adaptiveThresholdSearch: AdaptiveThresholdSearch;
  batchConfirmation: BatchConfirmation;
  bestRouteEnvelope: BestRouteEnvelopeAnalysis;
  pairedReferenceAnalysis: PairedReferenceAnalysis;
  eUsdcDecimals: number;
  trancheIncrementRaw: bigint;
  primaryThresholdBps: bigint;
  operationalThresholdBps: bigint;
  operationalSafetyBufferPercent: number;
}): OperationalTranchePlan {
  const selected = selectedThresholdPlans({
    recommendationState: input.recommendationState,
    bestRouteEnvelope: input.bestRouteEnvelope,
    pairedReferenceAnalysis: input.pairedReferenceAnalysis,
    batchConfirmation: input.batchConfirmation,
    adaptiveThresholdSearch: input.adaptiveThresholdSearch,
  });
  const analyticalRaw = rawFromPlan(selected.largestObservedBelowThreshold);
  const candidates = operationalCandidatePlans(input);
  const belowOperational = candidates
    .filter((candidate) => {
      const raw = rawFromPlan(candidate);
      const deterioration = deteriorationBpsFromPlan(candidate);
      return (
        raw !== null &&
        deterioration !== null &&
        raw > 0n &&
        (analyticalRaw === null || raw <= analyticalRaw) &&
        deterioration <= input.operationalThresholdBps
      );
    })
    .sort((a, b) => {
      const ar = rawFromPlan(a) ?? 0n;
      const br = rawFromPlan(b) ?? 0n;
      return ar < br ? -1 : ar > br ? 1 : 0;
    });
  const bufferedRaw = rawFromPlan(belowOperational.at(-1) ?? null);
  const operationalRaw =
    bufferedRaw !== null
      ? (bufferedRaw / input.trancheIncrementRaw) * input.trancheIncrementRaw
      : null;
  const trancheIncrementHuman = formatRawAmount(
    input.trancheIncrementRaw,
    input.eUsdcDecimals,
  );
  return {
    analyticalMaximumBelowThresholdHuman:
      analyticalRaw !== null ? formatRawAmount(analyticalRaw, input.eUsdcDecimals) : null,
    bufferedMaximumHuman:
      bufferedRaw !== null ? formatRawAmount(bufferedRaw, input.eUsdcDecimals) : null,
    operationalMaximumTrancheHuman:
      operationalRaw !== null
        ? formatRawAmount(operationalRaw, input.eUsdcDecimals)
        : null,
    trancheIncrementHuman,
    roundingPolicy:
      `round_down_to_${trancheIncrementHuman}_input_token_increment_after_operational_safety_buffer`,
    analyticalThresholdPercent: formatBpsAsPercent(input.primaryThresholdBps),
    operationalThresholdPercent: formatBpsAsPercent(input.operationalThresholdBps),
    operationalSafetyBufferPercent: input.operationalSafetyBufferPercent,
    analyticalThresholdPercentRaw: input.primaryThresholdBps.toString(),
    operationalThresholdPercentRaw: input.operationalThresholdBps.toString(),
  };
}

function operationalCandidatePlans(input: {
  recommendationState: RecommendationState;
  adaptiveThresholdSearch: AdaptiveThresholdSearch;
  batchConfirmation: BatchConfirmation;
  bestRouteEnvelope: BestRouteEnvelopeAnalysis;
  pairedReferenceAnalysis: PairedReferenceAnalysis;
}): Array<Record<string, unknown>> {
  if (input.recommendationState.basis === "adaptive_batch_sandwich") {
    return latestAdaptiveBatch(input.adaptiveThresholdSearch)?.candidateResults
      .filter((candidate) => candidate.candidateFailureReason === null)
      .map(batchCandidatePlan) ?? [];
  }
  if (input.recommendationState.basis === "batch_sandwich") {
    return input.batchConfirmation.candidateResults
      .filter((candidate) => candidate.candidateFailureReason === null)
      .map(batchCandidatePlan);
  }
  if (input.recommendationState.basis === "paired_reference") {
    return input.pairedReferenceAnalysis.pairs
      .filter((pair) => pair.pairUsable)
      .map((pair) => ({
        inputHuman: pair.candidateInputHuman,
        inputRaw: pair.candidateInputRaw,
        pairedReferenceDeteriorationPercent:
          pair.pairedReferenceDeteriorationPercent,
      }));
  }
  if (
    input.recommendationState.basis === "best_route_envelope" ||
    input.recommendationState.basis === "partial_evidence" ||
    input.recommendationState.basis === "first_quote"
  ) {
    return input.bestRouteEnvelope.points.map(planFromPoint);
  }
  return input.recommendationState.source?.points.map(planFromPoint) ?? [];
}

function deteriorationBpsFromPlan(plan: Record<string, unknown>): bigint | null {
  const text =
    typeof plan.batchReferenceDeteriorationPercent === "string"
      ? plan.batchReferenceDeteriorationPercent
      : typeof plan.pairedReferenceDeteriorationPercent === "string"
        ? plan.pairedReferenceDeteriorationPercent
        : typeof plan.averageSizePremiumPercent === "string"
          ? plan.averageSizePremiumPercent
          : typeof plan.priceDeteriorationPercent === "string"
            ? plan.priceDeteriorationPercent
            : null;
  return text !== null ? percentStringToBps(text) : null;
}

export function buildManualGuardrails(input: {
  selectedBatch: BatchConfirmation;
  operationalPlan: OperationalTranchePlan;
  maximumReferenceDriftPercent: number;
  maximumBatchWindowMs: number;
}): ManualGuardrails {
  return {
    referenceAmountHuman:
      input.selectedBatch.selectedReferenceAmountHuman ??
      input.selectedBatch.referenceAmountHuman,
    proposedTrancheHuman: input.operationalPlan.operationalMaximumTrancheHuman,
    maximumAllowedDeteriorationPercent:
      input.operationalPlan.operationalThresholdPercent,
    maximumReferenceDriftPercent: input.maximumReferenceDriftPercent,
    minimumOutputMustBePresent: true,
    maximumBatchAgeMs: input.maximumBatchWindowMs,
    requoteBeforeEveryExecution: true,
    reusableQuoteAllowed: false,
    stopConditions: [
      "Stop if a fresh Piteas quote is unavailable or lacks minimumOutputHuman.",
      `Stop if batch reference drift exceeds ${input.maximumReferenceDriftPercent}%.`,
      `Stop if candidate deterioration exceeds ${input.operationalPlan.operationalThresholdPercent}%.`,
      "Stop if reference freshness confidence is low or possibleCacheDetected is true without an operator override.",
      "Stop if the confirmation batch exceeds maximumBatchAgeMs.",
      SAME_STATE_WARNING,
    ],
  };
}

export function buildNoRecommendationPlans(
  input: RecommendationState,
  operationalPlan: OperationalTranchePlan,
): Record<string, unknown> {
  return {
    recommendationStatus: input.status,
    recommendationSource: null,
    recommendationSourceId: null,
    recommendationBasis: input.basis,
    recommendationEvidence: input.evidence,
    maximumTokensNow: null,
    lowestAveragePrice: null,
    balancedPriceImpactAndGas: null,
    conservativeLimitPlan: null,
    bestRouteLargestObservedBelowThreshold: null,
    bestRouteFirstObservedAboveThreshold: null,
    bestRouteThresholdBoundaryBracketed: false,
    bestRouteRecommendedMaximumTranche: null,
    pairedLargestObservedBelowThreshold: null,
    pairedFirstObservedAboveThreshold: null,
    pairedThresholdBoundaryBracketed: false,
    pairedRecommendedMaximumTranche: null,
    batchLargestObservedBelowThreshold: null,
    batchFirstObservedAboveThreshold: null,
    batchThresholdBoundaryBracketed: false,
    batchRecommendedMaximumTranche: null,
    adaptiveLargestObservedBelowThreshold: null,
    adaptiveFirstObservedAboveThreshold: null,
    adaptiveThresholdBoundaryBracketed: false,
    adaptiveRecommendedMaximumTranche: null,
    largestObservedBelowThreshold: null,
    firstObservedAboveThreshold: null,
    thresholdBoundaryBracketed: false,
    recommendedMaximumTranche: null,
    analyticalMaximumBelowThresholdHuman:
      operationalPlan.analyticalMaximumBelowThresholdHuman,
    bufferedMaximumHuman: operationalPlan.bufferedMaximumHuman,
    operationalMaximumTrancheHuman: operationalPlan.operationalMaximumTrancheHuman,
    trancheIncrementHuman: operationalPlan.trancheIncrementHuman,
    roundingPolicy: operationalPlan.roundingPolicy,
    analyticalThresholdPercent: operationalPlan.analyticalThresholdPercent,
    operationalThresholdPercent: operationalPlan.operationalThresholdPercent,
    operationalSafetyBufferPercent: operationalPlan.operationalSafetyBufferPercent,
    firstTrancheObservation: null,
    stagedEntryPlan: {
      initialTrancheHuman: null,
      recommendedMaximumTranche: null,
      operationalMaximumTrancheHuman: operationalPlan.operationalMaximumTrancheHuman,
      reserveBudgetHuman: null,
      minimumAcceptableOutputHuman: null,
      maximumAcceptableAveragePrice: null,
      requoteBeforeEveryExecution: true,
      stopConditions: [
        "Collect a fresh focused quote ladder inside the configured coherence window.",
        SAME_STATE_WARNING,
      ],
      rationale:
        "No coherent paired-reference boundary or best-route envelope is available.",
    },
  };
}
