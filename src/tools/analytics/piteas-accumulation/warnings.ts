import { SAME_STATE_WARNING } from "./constants.js";
import { isCoherent } from "./recommendationPrimitives.js";
import type {
  AdaptiveThresholdSearch,
  BatchConfirmation,
  BestRouteEnvelopeAnalysis,
  PairedReferenceAnalysis,
  PiteasReliability,
  QuoteCollection,
  RecommendationStatus,
  RouteChangeDetails,
  SnapshotMetadata,
} from "./types.js";

export function buildWarnings(input: {
  broad: QuoteCollection;
  broadSnapshot: SnapshotMetadata;
  broadMonotonicity: Record<string, unknown>;
  routeChanges: Array<Record<string, unknown>>;
  focusedRefresh: Record<string, unknown> | null;
  bestRouteEnvelope: BestRouteEnvelopeAnalysis;
  pairedReferenceAnalysis: PairedReferenceAnalysis;
  batchConfirmation: BatchConfirmation;
  adaptiveThresholdSearch: AdaptiveThresholdSearch;
  piteasReliability: PiteasReliability;
  expectedIndividualPairRequestCount: number;
  expectedBatchRequestCount: number;
  maximumPairWindowMs: number;
  maximumBatchWindowMs: number;
  recommendationStatus: RecommendationStatus;
  includeGasEstimate?: boolean;
}): string[] {
  const warnings = new Set<string>([SAME_STATE_WARNING]);
  const includeGasEstimate = input.includeGasEstimate !== false;
  if (input.broad.failures.length > 0) {
    warnings.add("One or more Piteas quote sizes failed; plan categories use partial results.");
  }
  if (
    input.routeChanges.some((change) => {
      const details = change.routeChangeDetails as RouteChangeDetails | undefined;
      return details?.structuralRouteChanged || details?.allocationChanged;
    })
  ) {
    warnings.add("Piteas route composition changes across the quote ladder.");
  }
  if (input.broadSnapshot.coherenceClass === "stitched_multi_state") {
    warnings.add("Broad discovery quotes are stitched across multiple states and are not one executable curve.");
  }
  if (input.bestRouteEnvelope.envelopeCoherence === "stitched_multi_state") {
    warnings.add("Best-route envelope is stitched across multiple states; withhold single-tranche recommendations until re-quoted.");
  }
  if (
    input.broadSnapshot.minimumBlock !== null &&
    input.broadSnapshot.maximumBlock !== null &&
    input.broadSnapshot.minimumBlock !== input.broadSnapshot.maximumBlock
  ) {
    warnings.add("Quote values span different reported blocks; compare points with caution.");
  }
  if (input.broadMonotonicity.averagePriceImprovedAtLargerSize === true) {
    warnings.add("A larger quote has a better average price; treat it as a route or snapshot discontinuity requiring a fresh local quote cluster.");
  }
  if (input.bestRouteEnvelope.routeChanges.length > 0) {
    warnings.add("Best-route envelope includes route changes; envelope comparisons remain single-tranche quote-size comparisons, not sequential forecasts.");
  }
  for (const warning of input.pairedReferenceAnalysis.warnings) warnings.add(warning);
  for (const warning of buildBatchWarnings(input.batchConfirmation)) warnings.add(warning);
  for (const warning of buildAdaptiveWarnings(input.adaptiveThresholdSearch)) {
    warnings.add(warning);
  }
  for (const warning of timingWindowWarnings({
    reliability: input.piteasReliability,
    expectedIndividualPairRequestCount: input.expectedIndividualPairRequestCount,
    expectedBatchRequestCount: input.expectedBatchRequestCount,
    batchConfirmation: input.batchConfirmation,
    maximumPairWindowMs: input.maximumPairWindowMs,
    maximumBatchWindowMs: input.maximumBatchWindowMs,
  })) {
    warnings.add(warning);
  }
  if (includeGasEstimate && input.broad.points.some((point) => point.gasWarning !== null)) {
    warnings.add("One or more small chunks have excessive gas estimate relative to chunk size.");
  }
  if (
    includeGasEstimate &&
    input.broad.points.some((point) => point.gasUseEstimateUSD === null && point.quoteReady)
  ) {
    warnings.add("Piteas gasUseEstimateUSD was unavailable for one or more quote points.");
  }
  if (
    input.focusedRefresh &&
    (input.focusedRefresh.complete !== true ||
      !isCoherent(
        ((input.focusedRefresh.snapshotMetadata as SnapshotMetadata | undefined)
          ?.coherenceClass ?? "insufficient_metadata"),
      ))
  ) {
    warnings.add("Focused refresh is incomplete or incoherent; do not base staged entries on it.");
  }
  if (input.recommendationStatus === "first_quote_only") {
    warnings.add("Recommendation is first_quote_only; one coherent quote is not enough for a staged plan.");
  }
  if (input.recommendationStatus === "partial_boundary") {
    warnings.add("Recommendation is partial_boundary; threshold or marginal evidence is incomplete.");
  }
  if (input.recommendationStatus === "requote_required") {
    warnings.add("recommendationStatus is requote_required because no sufficient coherent source is available.");
  }
  if (input.recommendationStatus === "unavailable") {
    warnings.add("recommendationStatus is unavailable because no successful Piteas quote is available.");
  }
  return [...warnings];
}

function buildBatchWarnings(batch: BatchConfirmation): string[] {
  const warnings = new Set<string>();
  if (batch.failureReasons.includes("not_run")) return [];
  if (batch.failureReasons.length > 0) {
    warnings.add(
      `Batch-sandwich confirmation is not fully usable: ${batch.failureReasons.join(", ")}.`,
    );
  }
  if (batch.candidateResults.some((candidate) => candidate.routeChangedFromReference)) {
    warnings.add(
      "A batch-sandwich candidate changed route versus the reference quote; this is surfaced for review and does not automatically invalidate the comparison.",
    );
  }
  if (batch.failureReasons.includes("low_confidence_reference_freshness")) {
    warnings.add(
      "Batch-sandwich references were identical without independent freshness metadata; recommendation is withheld unless low-confidence freshness is explicitly allowed.",
    );
  }
  if (!batch.temporallyUsable && batch.candidateResults.length > 0) {
    warnings.add(
      "Batch-sandwich confirmation is withheld from recommendations unless references, drift, duration, and candidate validity all pass.",
    );
  }
  return [...warnings];
}

function buildAdaptiveWarnings(adaptive: AdaptiveThresholdSearch): string[] {
  if (adaptive.terminationReason === "not_run") return [];
  const warnings = new Set<string>();
  if (adaptive.terminationReason === "no_initial_bracket") {
    warnings.add(
      "Adaptive batch-sandwich confirmation did not run because broad discovery did not find a below/above threshold bracket.",
    );
  }
  if (adaptive.terminationReason === "batch_unusable") {
    warnings.add(
      "Adaptive batch-sandwich confirmation stopped because the latest batch was unusable.",
    );
  }
  if (
    adaptive.thresholdBoundaryBracketed &&
    adaptive.recommendedMaximumTranche === null
  ) {
    warnings.add(
      "Adaptive batch-sandwich found partial threshold evidence, but no recommended maximum tranche was issued.",
    );
  }
  return [...warnings];
}

function timingWindowWarnings(input: {
  reliability: PiteasReliability;
  expectedIndividualPairRequestCount: number;
  expectedBatchRequestCount: number;
  batchConfirmation: BatchConfirmation;
  maximumPairWindowMs: number;
  maximumBatchWindowMs: number;
}): string[] {
  const medianLatencyMs = input.reliability.medianLatencyMs;
  if (medianLatencyMs === null) return [];
  const warnings: string[] = [];
  if (
    input.expectedIndividualPairRequestCount > 0 &&
    medianLatencyMs * input.expectedIndividualPairRequestCount >
      input.maximumPairWindowMs
  ) {
    warnings.push(
      `Configured individual paired-reference window may be impossible: expected request count ${input.expectedIndividualPairRequestCount} * observed median latency ${medianLatencyMs}ms exceeds ${input.maximumPairWindowMs}ms.`,
    );
  }
  if (
    input.expectedBatchRequestCount > 0 &&
    input.batchConfirmation.estimatedCriticalPathMs !== null &&
    input.batchConfirmation.estimatedCriticalPathMs > input.maximumBatchWindowMs
  ) {
    warnings.push(
      `Configured batch-sandwich window may be impossible: concurrency-aware critical path estimate ${input.batchConfirmation.estimatedCriticalPathMs}ms exceeds ${input.maximumBatchWindowMs}ms.`,
    );
  }
  return warnings;
}
