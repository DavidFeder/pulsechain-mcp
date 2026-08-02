import { latestAdaptiveBatch, successfulBatchCandidatePoints } from "./adaptiveSearch.js";
import { batchThresholdPlans } from "./batchSandwich.js";
import { isSuccessfulPoint } from "./decimalMath.js";
import {
  buildThresholdSemantics,
  countValidMarginalIntervals,
  isCoherent,
  isEnvelopeCoherent,
} from "./recommendationPrimitives.js";
import { lowestRouteMetadataCompleteness, weakestRouteConfidence } from "./routeSignatures.js";
import type {
  AdaptiveThresholdSearch,
  BatchConfirmation,
  BestRouteEnvelopeAnalysis,
  FocusedRefreshStatus,
  LocalQuoteCluster,
  PairedReferenceAnalysis,
  PairedReferencePair,
  QuotePoint,
  RecommendationBasis,
  RecommendationEvidence,
  RecommendationSource,
  RecommendationState,
  RecommendationStatus,
  SnapshotMetadata,
  SuccessfulPoint,
  ThresholdSemantics,
} from "./types.js";

export function buildRecommendationState(input: {
  focusedRefresh: Record<string, unknown> | null;
  focusedRefreshStatus: FocusedRefreshStatus;
  broadBestRouteEnvelope: BestRouteEnvelopeAnalysis;
  pairedReferenceAnalysis: PairedReferenceAnalysis;
  batchConfirmation: BatchConfirmation;
  adaptiveThresholdSearch: AdaptiveThresholdSearch;
  broadClusters: LocalQuoteCluster[];
  broadPoints: QuotePoint[];
  primaryThresholdBps: bigint;
}): RecommendationState {
  const routeLocalSource = selectRouteLocalSource(input);
  const source = selectPrimaryRecommendationSource({
    ...input,
    routeLocalSource,
  });
  const thresholdSemantics = source
    ? buildThresholdSemantics(source.points, input.primaryThresholdBps)
    : {
        largestObservedBelowThreshold: null,
        firstObservedAboveThreshold: null,
        thresholdBoundaryBracketed: false,
      };
  const status = determineRecommendationStatus({
    source,
    broadPoints: input.broadPoints,
    broadBestRouteEnvelope: input.broadBestRouteEnvelope,
    pairedReferenceAnalysis: input.pairedReferenceAnalysis,
    batchConfirmation: input.batchConfirmation,
    adaptiveThresholdSearch: input.adaptiveThresholdSearch,
    primaryThresholdBps: input.primaryThresholdBps,
  });
  const basis = recommendationBasisForSource(source, status);
  const evidence = buildRecommendationEvidence({
    source,
    status,
    basis,
    thresholdSemantics,
    focusedRefreshStatus: input.focusedRefreshStatus,
    broadPoints: input.broadPoints,
    broadBestRouteEnvelope: input.broadBestRouteEnvelope,
    pairedReferenceAnalysis: input.pairedReferenceAnalysis,
    batchConfirmation: input.batchConfirmation,
    adaptiveThresholdSearch: input.adaptiveThresholdSearch,
  });
  return {
    status,
    basis,
    source,
    evidence,
    thresholdSemantics,
  };
}

function selectPrimaryRecommendationSource(input: {
  focusedRefresh: Record<string, unknown> | null;
  focusedRefreshStatus: FocusedRefreshStatus;
  broadBestRouteEnvelope: BestRouteEnvelopeAnalysis;
  pairedReferenceAnalysis: PairedReferenceAnalysis;
  batchConfirmation: BatchConfirmation;
  adaptiveThresholdSearch: AdaptiveThresholdSearch;
  broadClusters: LocalQuoteCluster[];
  broadPoints: QuotePoint[];
  routeLocalSource: RecommendationSource | null;
}): RecommendationSource | null {
  if (
    lowConfidenceReferenceFreshnessBlocked(input.batchConfirmation) ||
    lowConfidenceReferenceFreshnessBlocked(latestAdaptiveBatch(input.adaptiveThresholdSearch))
  ) {
    return null;
  }
  if (
    input.adaptiveThresholdSearch.thresholdBoundaryBracketed &&
    input.adaptiveThresholdSearch.recommendedMaximumTranche !== null
  ) {
    const batch = latestAdaptiveBatch(input.adaptiveThresholdSearch);
    return {
      source: "adaptive_batch_sandwich",
      sourceId: `adaptive-batch-sandwich-round-${input.adaptiveThresholdSearch.rounds.at(-1)?.round ?? 0}`,
      points: successfulBatchCandidatePoints(batch),
      batch: batch ?? undefined,
      adaptiveSearch: input.adaptiveThresholdSearch,
    };
  }

  const batchThreshold = batchThresholdPlans(input.batchConfirmation);
  if (
    input.batchConfirmation.temporallyUsable &&
    batchThreshold.thresholdBoundaryBracketed &&
    batchThreshold.recommendedMaximumTranche !== null
  ) {
    return {
      source: "batch_sandwich",
      sourceId: "batch-sandwich",
      points: successfulBatchCandidatePoints(input.batchConfirmation),
      batch: input.batchConfirmation,
    };
  }

  if (input.pairedReferenceAnalysis.pairedThresholdBoundaryBracketed) {
    return {
      source: "paired_reference",
      sourceId: "paired-reference",
      points: successfulCandidatePointsFromPairs(input.pairedReferenceAnalysis.pairs),
      pair: firstRecommendedPair(input.pairedReferenceAnalysis),
    };
  }

  const focusedEnvelope = focusedBestRouteEnvelope(input.focusedRefresh);
  const coherentFocusedEnvelope =
    input.focusedRefreshStatus === "complete_coherent" &&
    focusedEnvelope &&
    isEnvelopeCoherent(focusedEnvelope.envelopeCoherence)
      ? focusedEnvelope
      : null;
  const coherentBroadEnvelope = isEnvelopeCoherent(
    input.broadBestRouteEnvelope.envelopeCoherence,
  )
    ? input.broadBestRouteEnvelope
    : null;
  const availableEnvelope = [coherentFocusedEnvelope, coherentBroadEnvelope]
    .filter((envelope): envelope is BestRouteEnvelopeAnalysis => envelope !== null)
    .find(
      (envelope) =>
        envelope.successfulQuoteCount >= 3 &&
        envelope.bestRouteThresholdBoundaryBracketed,
    );
  if (availableEnvelope) {
    return {
      source:
        availableEnvelope.source === "focused_refresh"
          ? "focused_refresh"
          : "best_route_envelope",
      sourceId:
        availableEnvelope.source === "focused_refresh"
          ? "focused-refresh-envelope"
          : "broad-best-route-envelope",
      points: availableEnvelope.points,
      envelope: availableEnvelope,
    };
  }

  const partialEnvelope = coherentFocusedEnvelope ?? coherentBroadEnvelope;
  if (partialEnvelope && partialEnvelope.points.length > 0) {
    return {
      source:
        partialEnvelope.source === "focused_refresh"
          ? "focused_refresh"
          : "best_route_envelope",
      sourceId:
        partialEnvelope.source === "focused_refresh"
          ? "focused-refresh-envelope"
          : "broad-best-route-envelope",
      points: partialEnvelope.points,
      envelope: partialEnvelope,
    };
  }

  return null;
}

function lowConfidenceReferenceFreshnessBlocked(
  batch: BatchConfirmation | null | undefined,
): boolean {
  return batch?.failureReasons.includes("low_confidence_reference_freshness") ?? false;
}

export function selectRouteLocalSource(input: {
  focusedRefresh: Record<string, unknown> | null;
  focusedRefreshStatus: FocusedRefreshStatus;
  broadClusters: LocalQuoteCluster[];
  broadPoints: QuotePoint[];
}): RecommendationSource | null {
  if (input.focusedRefresh) {
    const snapshot = input.focusedRefresh.snapshotMetadata as SnapshotMetadata | undefined;
    const focusedPoints = (input.focusedRefresh.executableQuoteDepth as QuotePoint[] | undefined)
      ?.filter(isSuccessfulPoint) ?? [];
    if (
      input.focusedRefreshStatus === "complete_coherent" &&
      snapshot &&
      isCoherent(snapshot.coherenceClass) &&
      focusedPoints.length > 0
    ) {
      return {
        source: "focused_refresh",
        sourceId: "focused-refresh",
        points: focusedPoints,
        snapshotMetadata: snapshot,
      };
    }
  }

  const candidate = input.broadClusters
    .filter((cluster) => isCoherent(cluster.coherenceClass) && cluster.quoteSizesHuman.length > 0)
    .sort((a, b) => b.quoteSizesHuman.length - a.quoteSizesHuman.length)[0];
  if (!candidate) return null;
  return {
    source: "local_cluster",
    sourceId: candidate.clusterId,
    points: input.broadPoints
      .filter(isSuccessfulPoint)
      .filter((point) => point.clusterId === candidate.clusterId),
    cluster: candidate,
  };
}

function focusedBestRouteEnvelope(
  focusedRefresh: Record<string, unknown> | null,
): BestRouteEnvelopeAnalysis | null {
  return (
    (focusedRefresh?.bestRouteEnvelope as BestRouteEnvelopeAnalysis | undefined) ??
    null
  );
}

function successfulCandidatePointsFromPairs(pairs: PairedReferencePair[]): SuccessfulPoint[] {
  return pairs
    .filter((pair) => pair.pairUsable)
    .map((pair) => pair.candidateQuotes.find(isSuccessfulPoint))
    .filter((point): point is SuccessfulPoint => point !== undefined)
    .sort((a, b) => {
      const ar = BigInt(a.inputRaw);
      const br = BigInt(b.inputRaw);
      return ar < br ? -1 : ar > br ? 1 : 0;
    });
}

function firstRecommendedPair(
  analysis: PairedReferenceAnalysis,
): PairedReferencePair | undefined {
  const target = analysis.pairedRecommendedMaximumTranche as
    | Record<string, unknown>
    | null;
  if (!target) return undefined;
  return analysis.pairs.find(
    (pair) => pair.candidateInputHuman === target.inputHuman && pair.pairUsable,
  );
}

function recommendationBasisForSource(
  source: RecommendationSource | null,
  status: RecommendationStatus,
): RecommendationBasis {
  if (!source) return status === "unavailable" ? "none" : "none";
  if (source.source === "adaptive_batch_sandwich") return "adaptive_batch_sandwich";
  if (source.source === "batch_sandwich") return "batch_sandwich";
  if (source.source === "paired_reference") return "paired_reference";
  if (source.source === "best_route_envelope" || source.source === "focused_refresh") {
    if (status === "first_quote_only") return "first_quote";
    return status === "partial_boundary" ? "partial_evidence" : "best_route_envelope";
  }
  if (status === "first_quote_only") return "first_quote";
  return "route_local";
}

function buildRecommendationEvidence(input: {
  source: RecommendationSource | null;
  status: RecommendationStatus;
  basis: RecommendationBasis;
  thresholdSemantics: ThresholdSemantics;
  focusedRefreshStatus: FocusedRefreshStatus;
  broadPoints: QuotePoint[];
  broadBestRouteEnvelope: BestRouteEnvelopeAnalysis;
  pairedReferenceAnalysis: PairedReferenceAnalysis;
  batchConfirmation: BatchConfirmation;
  adaptiveThresholdSearch: AdaptiveThresholdSearch;
}): RecommendationEvidence {
  const points = input.source?.points ?? [];
  const successfulFallbackCount = input.broadPoints.filter(isSuccessfulPoint).length;
  const distinctInputs = new Set(points.map((point) => point.inputRaw));
  const validMarginalIntervalCount = countValidMarginalIntervals(points);
  const routeConfidence = points.length > 0 ? weakestRouteConfidence(points) : null;
  const limitations: string[] = [];
  if (!input.source) {
    limitations.push(
      successfulFallbackCount > 0
        ? "No coherent paired reference or best-route envelope source is available; collect a fresh quote set."
        : "No successful Piteas quote is available.",
    );
  }
  if (points.length === 1) {
    limitations.push("Only one coherent quote is available; this is a first-tranche observation only.");
  }
  if (input.basis !== "paired_reference" && points.length > 0 && points.length < 3) {
    limitations.push("At least 3 coherent ordered quotes are required for an average-price trend.");
  }
  if (input.basis !== "paired_reference" && points.length > 0 && validMarginalIntervalCount < 2) {
    limitations.push("At least 3 compatible quotes and 2 valid intervals are required for route-local marginal analysis.");
  }
  if (
    input.basis === "adaptive_batch_sandwich" &&
    !input.adaptiveThresholdSearch.thresholdBoundaryBracketed
  ) {
    limitations.push("Adaptive batch-sandwich confirmation requires a usable final batch with one below-threshold candidate and a larger above-threshold candidate.");
  } else if (
    input.basis === "batch_sandwich" &&
    !batchThresholdPlans(input.batchConfirmation).thresholdBoundaryBracketed
  ) {
    limitations.push("Batch-sandwich confirmation requires one below-threshold candidate and a larger above-threshold candidate in the same usable batch.");
  } else if (
    input.basis === "paired_reference" &&
    !input.pairedReferenceAnalysis.pairedThresholdBoundaryBracketed
  ) {
    limitations.push("Paired reference mode requires one usable below-threshold pair and a larger usable above-threshold pair.");
  } else if (
    input.basis === "best_route_envelope" &&
    !input.broadBestRouteEnvelope.bestRouteThresholdBoundaryBracketed &&
    input.source?.envelope?.bestRouteThresholdBoundaryBracketed !== true
  ) {
    limitations.push("Best-route envelope has no bracketed below/above threshold boundary.");
  } else if (points.length > 0 && !input.thresholdSemantics.thresholdBoundaryBracketed) {
    limitations.push(
      input.thresholdSemantics.firstObservedAboveThreshold
        ? "No lower below-threshold quote brackets the first above-threshold quote."
        : "No above-threshold quote was observed; largest below-threshold amount is not a proven boundary.",
    );
  }
  if (routeConfidence === "low") {
    limitations.push("Route signature confidence is low; fallback route metadata is not sufficient for a full recommendation.");
  }
  if (
    input.focusedRefreshStatus !== "not_run" &&
    input.focusedRefreshStatus !== "complete_coherent" &&
    input.source?.source === "focused_refresh"
  ) {
    limitations.push(`Focused refresh status is ${input.focusedRefreshStatus}; incomplete or incoherent focused data is not used for final recommendations.`);
  }
  const hasThresholdBracket =
    input.basis === "adaptive_batch_sandwich"
      ? input.adaptiveThresholdSearch.thresholdBoundaryBracketed
      : input.basis === "batch_sandwich"
        ? batchThresholdPlans(input.batchConfirmation).thresholdBoundaryBracketed
        : input.basis === "paired_reference"
      ? input.pairedReferenceAnalysis.pairedThresholdBoundaryBracketed
      : input.basis === "best_route_envelope"
        ? input.source?.envelope?.bestRouteThresholdBoundaryBracketed ?? false
        : input.thresholdSemantics.thresholdBoundaryBracketed;
  return {
    source: input.source?.source ?? null,
    recommendationBasis: input.basis,
    successfulQuoteCount: points.length,
    distinctInputCount: distinctInputs.size,
    minimumInputHuman: points[0]?.inputHuman ?? null,
    maximumInputHuman: points.at(-1)?.inputHuman ?? null,
    hasAveragePriceTrend:
      input.basis === "adaptive_batch_sandwich"
        ? successfulBatchCandidatePoints(latestAdaptiveBatch(input.adaptiveThresholdSearch)).length >= 3
        : input.basis === "batch_sandwich"
          ? successfulBatchCandidatePoints(input.batchConfirmation).length >= 3
          : input.basis === "paired_reference"
        ? input.pairedReferenceAnalysis.usablePairCount >= 2
        : points.length >= 3,
    hasMarginalCurve:
      input.basis === "adaptive_batch_sandwich" || input.basis === "batch_sandwich"
        ? false
        : input.basis === "paired_reference"
        ? false
        : points.length >= 3 && validMarginalIntervalCount >= 2,
    validMarginalIntervalCount,
    hasThresholdBracket,
    thresholdLowerBoundHuman:
      input.basis === "adaptive_batch_sandwich"
        ? ((input.adaptiveThresholdSearch.finalLargestBelowThreshold
            ?.inputHuman as string | undefined) ?? null)
        : input.basis === "batch_sandwich"
          ? ((batchThresholdPlans(input.batchConfirmation).largestObservedBelowThreshold
              ?.inputHuman as string | undefined) ?? null)
          : input.basis === "paired_reference"
        ? ((input.pairedReferenceAnalysis.pairedLargestObservedBelowThreshold
            ?.inputHuman as string | undefined) ?? null)
        : input.basis === "best_route_envelope"
          ? ((input.source?.envelope?.bestRouteLargestObservedBelowThreshold
              ?.inputHuman as string | undefined) ?? null)
          : input.thresholdSemantics.largestObservedBelowThreshold?.inputHuman ?? null,
    thresholdUpperBoundHuman:
      input.basis === "adaptive_batch_sandwich"
        ? ((input.adaptiveThresholdSearch.finalFirstAboveThreshold
            ?.inputHuman as string | undefined) ?? null)
        : input.basis === "batch_sandwich"
          ? ((batchThresholdPlans(input.batchConfirmation).firstObservedAboveThreshold
              ?.inputHuman as string | undefined) ?? null)
          : input.basis === "paired_reference"
        ? ((input.pairedReferenceAnalysis.pairedFirstObservedAboveThreshold
            ?.inputHuman as string | undefined) ?? null)
        : input.basis === "best_route_envelope"
          ? ((input.source?.envelope?.bestRouteFirstObservedAboveThreshold
              ?.inputHuman as string | undefined) ?? null)
          : input.thresholdSemantics.firstObservedAboveThreshold?.inputHuman ?? null,
    focusedRefreshComplete: input.focusedRefreshStatus === "complete_coherent",
    focusedRefreshStatus: input.focusedRefreshStatus,
    routeConfidence,
    routeMetadataCompletenessPercent:
      points.length > 0 ? lowestRouteMetadataCompleteness(points) : null,
    limitations,
  };
}

function determineRecommendationStatus(input: {
  source: RecommendationSource | null;
  broadPoints: QuotePoint[];
  broadBestRouteEnvelope: BestRouteEnvelopeAnalysis;
  pairedReferenceAnalysis: PairedReferenceAnalysis;
  batchConfirmation: BatchConfirmation;
  adaptiveThresholdSearch: AdaptiveThresholdSearch;
  primaryThresholdBps: bigint;
}): RecommendationStatus {
  if (!input.source) {
    return input.broadPoints.some(isSuccessfulPoint) ? "requote_required" : "unavailable";
  }
  if (input.source.source === "adaptive_batch_sandwich") {
    return input.adaptiveThresholdSearch.thresholdBoundaryBracketed &&
      input.adaptiveThresholdSearch.recommendedMaximumTranche !== null
      ? "available"
      : "partial_boundary";
  }
  if (input.source.source === "batch_sandwich") {
    const threshold = batchThresholdPlans(input.batchConfirmation);
    return input.batchConfirmation.temporallyUsable &&
      threshold.thresholdBoundaryBracketed &&
      threshold.recommendedMaximumTranche !== null
      ? "available"
      : "partial_boundary";
  }
  if (input.source.source === "paired_reference") {
    return input.pairedReferenceAnalysis.pairedThresholdBoundaryBracketed
      ? "available"
      : "partial_boundary";
  }
  if (input.source.source === "best_route_envelope" || input.source.source === "focused_refresh") {
    const envelope = input.source.envelope ?? input.broadBestRouteEnvelope;
    if (!isEnvelopeCoherent(envelope.envelopeCoherence)) return "requote_required";
    if (envelope.points.length === 0) return "unavailable";
    if (envelope.points.length === 1) return "first_quote_only";
    if (
      envelope.points.length >= 3 &&
      envelope.bestRouteThresholdBoundaryBracketed
    ) {
      return "available";
    }
    return "partial_boundary";
  }
  const points = input.source.points;
  if (points.length === 0) return "unavailable";
  if (points.length === 1) return "first_quote_only";
  const thresholdSemantics = buildThresholdSemantics(
    points,
    input.primaryThresholdBps,
  );
  if (
    points.length < 3 ||
    countValidMarginalIntervals(points) < 2 ||
    !thresholdSemantics.thresholdBoundaryBracketed ||
    weakestRouteConfidence(points) === "low"
  ) {
    return "partial_boundary";
  }
  return "available";
}
