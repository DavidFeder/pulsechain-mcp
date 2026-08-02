import type { getPiteasQuote, PiteasQuoteResult } from "../../../data/piteas.js";

export type CoherenceClass =
  | "coherent_same_block"
  | "coherent_narrow_window"
  | "stitched_multi_state"
  | "insufficient_metadata";

export type EnvelopeCoherenceClass =
  | "coherent_same_block"
  | "coherent_tight_window"
  | "usable_paired_quotes"
  | "stitched_multi_state"
  | "insufficient_metadata";

export type QuotePurpose =
  | "broad_discovery"
  | "focused_refresh"
  | "paired_reference"
  | "paired_candidate"
  | "batch_reference_before"
  | "batch_reference_after"
  | "batch_candidate";

export type ConfirmationMode = "individual_pairs" | "batch_sandwich" | "adaptive";

export type RecommendationStatus =
  | "available"
  | "first_quote_only"
  | "partial_boundary"
  | "requote_required"
  | "unavailable";

export type FocusedRefreshStatus =
  | "complete_coherent"
  | "complete_incoherent"
  | "incomplete"
  | "failed"
  | "not_run";

export type RouteSignatureConfidence = "high" | "medium" | "low";

export type FreshnessConfidence = "high" | "medium" | "low";

export type RecommendationBasis =
  | "adaptive_batch_sandwich"
  | "batch_sandwich"
  | "paired_reference"
  | "best_route_envelope"
  | "partial_evidence"
  | "route_local"
  | "first_quote"
  | "none";

export interface PiteasAccumulationPlanInput {
  eUsdcAddress: string;
  phiatAddress: string;
  totalBudgetHuman: string;
  quoteSizeLadderHuman?: string[];
  chunkSizeHuman?: string;
  generatedLadderSteps?: number;
  candidateChunkCounts?: number[];
  eUsdcDecimals?: number;
  phiatDecimals?: number;
  allowedSlippagePercent?: number;
  priceImpactThresholdsPercent?: number[];
  maximumAcceptableAveragePrice?: string;
  maxGasCostPercentOfChunk?: number;
  maxSnapshotBlockSpread?: number;
  maxSnapshotCollectionDurationMs?: number;
  maxQuoteAgeSpreadMs?: number;
  focusedRefresh?: boolean;
  focusedQuoteLadderHuman?: string[];
  focusedRefreshMaxDurationMs?: number;
  pairedReferenceAmountHuman?: string;
  pairedCandidateSizesHuman?: string[];
  maximumPairWindowMs?: number;
  confirmationMode?: ConfirmationMode;
  referenceAmountCandidatesHuman?: string[];
  confirmationCandidateSizesHuman?: string[];
  maximumBatchWindowMs?: number;
  maximumReferenceDriftPercent?: number;
  quoteConcurrency?: number;
  maximumAdaptiveRounds?: number;
  maximumBracketWidthHuman?: string;
  allowLowConfidenceFreshness?: boolean;
  trancheIncrementHuman?: string;
  operationalSafetyBufferPercent?: number;
  account?: string;
}

export interface PiteasAccumulationPlanDeps {
  getPiteasQuote: typeof getPiteasQuote;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface SnapshotLimits {
  maxBlockSpread: bigint;
  maxCollectionDurationMs: number;
  maxQuoteAgeSpreadMs: number;
  focusedRefreshMaxDurationMs: number;
  maximumPairWindowMs: number;
  maximumBatchWindowMs: number;
}

export interface QuoteFailure {
  source: string;
  purpose: QuotePurpose;
  inputHuman: string;
  inputRaw: string;
  reason: string;
  requestStartedAt: string;
  responseReceivedAt: string;
  endpoint: string;
  retryCount: number;
  attempts: QuoteAttemptMetadata[];
}

export interface QuoteAttemptMetadata {
  attempt: number;
  requestStartedAt: string;
  responseReceivedAt: string;
  latencyMs: number;
  ok: boolean;
  status: number | null;
  reason: string | null;
}

export interface Ratio {
  numerator: bigint;
  denominator: bigint;
}

export interface QuoteValidityFlags {
  averagePriceImprovedAtLargerSize: boolean;
  marginalPriceAnomaly: boolean;
  outputNonMonotonic: boolean;
  minimumOutputNonMonotonic: boolean;
  cumulativeOutputNonPositive: boolean;
  marginalOutputNonPositive: boolean;
  staleQuote: boolean;
  routeDiscontinuity: boolean;
  snapshotDiscontinuity: boolean;
}

export interface RouteChangeDetails {
  structuralRouteChanged: boolean;
  allocationChanged: boolean;
  poolChanged: boolean;
  protocolChanged: boolean;
  routerChanged: boolean;
  tokenPathChanged: boolean;
  onlyEconomicValuesChanged: boolean;
}

export interface QuotePoint {
  index: number;
  purpose: QuotePurpose;
  inputRaw: string;
  inputHuman: string;
  outputRaw: string | null;
  outputHuman: string | null;
  minimumOutputRaw: string | null;
  minimumOutputHuman: string | null;
  averagePrice: string | null;
  marginalPrice: string | null;
  marginalPriceScope: "local_cluster" | "cluster_first_quote" | null;
  crossStateMarginalPrice: string | null;
  crossStateMarginalPriceExecutable: false;
  envelopeMarginalPrice: string | null;
  envelopeMarginalIsSequentialForecast: false;
  routeLocalMarginalPrice: string | null;
  priceDeteriorationPercent: string | null;
  averageSizePremiumPercent: string | null;
  piteasReportedPriceImpactPercent: number | null;
  thresholdCrossed: boolean | null;
  crossedThresholdsPercent: number[];
  routeComposition: Record<string, unknown> | null;
  routeSignature: string | null;
  structuralRouteSignature: string | null;
  economicRouteFingerprint: string | null;
  routeChangeDetails: RouteChangeDetails | null;
  routeSignatureConfidence: RouteSignatureConfidence;
  routeMetadataCompletenessPercent: number;
  clusterId: string | null;
  routeChangedFromPreviousQuote: boolean | null;
  routeChangedFromPreviousInCluster: boolean | null;
  gasUseEstimate: number | null;
  gasUseEstimateUSD: number | null;
  gasCostPercentOfChunk: string | null;
  gasWarning: string | null;
  blockNumber: string | null;
  requestStartedAt: string;
  responseReceivedAt: string;
  quoteTimestamp: string | null;
  quoteIdentifier: string | null;
  expiresAt: string | null;
  responseFingerprint: string | null;
  cacheHeaders: Record<string, string> | null;
  endpoint: string;
  retryCount: number;
  schedulerRetryCount: number;
  attempts: QuoteAttemptMetadata[];
  fetchedAt: string;
  quoteReady: boolean;
  quoteError: string | null;
  validityFlags: QuoteValidityFlags;
  methodParametersOmitted: true;
}

export interface SuccessfulPoint extends QuotePoint {
  outputRaw: string;
  outputHuman: string;
}

export interface QuoteCollection {
  purpose: QuotePurpose;
  points: QuotePoint[];
  failures: QuoteFailure[];
  collectionStartedAt: string;
  collectionCompletedAt: string;
  collectionDurationMs: number;
}

export interface SnapshotMetadata {
  collectionStartedAt: string;
  collectionCompletedAt: string;
  collectionDurationMs: number;
  minimumBlock: string | null;
  maximumBlock: string | null;
  blockSpread: string | null;
  quoteAgeSpreadMs: number | null;
  quoteAgeSpreadSource: "quoteTimestamp" | "responseReceivedAt" | null;
  atomicSnapshot: boolean;
  coherenceClass: CoherenceClass;
  coherenceReasons: string[];
  limits: {
    maxBlockSpread: string;
    maxCollectionDurationMs: number;
    maxQuoteAgeSpreadMs: number;
  };
}

export interface LocalQuoteCluster {
  clusterId: string;
  purpose: QuotePurpose;
  routeSignature: string | null;
  structuralRouteSignature: string | null;
  economicRouteFingerprints: string[];
  routeSignatureConfidence: RouteSignatureConfidence;
  routeMetadataCompletenessPercent: number;
  structuralRouteFields: Record<string, unknown> | null;
  quoteSizesHuman: string[];
  blockRange: {
    minimumBlock: string | null;
    maximumBlock: string | null;
    blockSpread: string | null;
  };
  timeRange: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
  coherenceClass: CoherenceClass;
  localAveragePriceCurve: Array<Record<string, unknown>>;
  localMarginalPriceCurve: Array<Record<string, unknown>>;
  thresholdCrossings: Array<Record<string, unknown>>;
}

export interface RecommendationSource {
  source:
    | "adaptive_batch_sandwich"
    | "batch_sandwich"
    | "paired_reference"
    | "focused_refresh"
    | "best_route_envelope"
    | "local_cluster";
  sourceId: string;
  points: SuccessfulPoint[];
  snapshotMetadata?: SnapshotMetadata;
  cluster?: LocalQuoteCluster;
  pair?: PairedReferencePair;
  envelope?: BestRouteEnvelopeAnalysis;
  batch?: BatchConfirmation;
  adaptiveSearch?: AdaptiveThresholdSearch;
}

export interface ThresholdSemantics {
  largestObservedBelowThreshold: SuccessfulPoint | null;
  firstObservedAboveThreshold: SuccessfulPoint | null;
  thresholdBoundaryBracketed: boolean;
}

export interface RecommendationEvidence {
  source:
    | "adaptive_batch_sandwich"
    | "batch_sandwich"
    | "paired_reference"
    | "focused_refresh"
    | "best_route_envelope"
    | "local_cluster"
    | null;
  recommendationBasis: RecommendationBasis;
  successfulQuoteCount: number;
  distinctInputCount: number;
  minimumInputHuman: string | null;
  maximumInputHuman: string | null;
  hasAveragePriceTrend: boolean;
  hasMarginalCurve: boolean;
  validMarginalIntervalCount: number;
  hasThresholdBracket: boolean;
  thresholdLowerBoundHuman: string | null;
  thresholdUpperBoundHuman: string | null;
  focusedRefreshComplete: boolean;
  focusedRefreshStatus: FocusedRefreshStatus;
  routeConfidence: RouteSignatureConfidence | null;
  routeMetadataCompletenessPercent: number | null;
  limitations: string[];
}

export interface RecommendationState {
  status: RecommendationStatus;
  basis: RecommendationBasis;
  source: RecommendationSource | null;
  evidence: RecommendationEvidence;
  thresholdSemantics: ThresholdSemantics;
}

export interface BestRouteEnvelopeAnalysis {
  description: string;
  source: "broad_discovery" | "focused_refresh";
  envelopeCoherence: EnvelopeCoherenceClass;
  envelopeCoherenceReasons: string[];
  points: SuccessfulPoint[];
  averagePriceCurve: Array<Record<string, unknown>>;
  envelopeMarginalCurve: Array<Record<string, unknown>>;
  thresholdCrossings: Array<Record<string, unknown>>;
  routeChanges: Array<Record<string, unknown>>;
  bestRouteLargestObservedBelowThreshold: Record<string, unknown> | null;
  bestRouteFirstObservedAboveThreshold: Record<string, unknown> | null;
  bestRouteThresholdBoundaryBracketed: boolean;
  bestRouteRecommendedMaximumTranche: Record<string, unknown> | null;
  successfulQuoteCount: number;
  temporalMetadata: Record<string, unknown>;
  envelopeMarginalIsSequentialForecast: false;
}

export interface PairedReferencePair {
  referenceInputRaw: string;
  referenceInputHuman: string;
  candidateInputRaw: string;
  candidateInputHuman: string;
  referenceAveragePrice: string | null;
  candidateAveragePrice: string | null;
  pairedDeteriorationPercent: string | null;
  pairedReferenceDeteriorationPercent: string | null;
  pairStartedAt: string;
  pairCompletedAt: string;
  pairDurationMs: number;
  referenceRouteSignature: string | null;
  candidateRouteSignature: string | null;
  routeChangedWithinPair: boolean;
  pairUsable: boolean;
  pairFailureReason: string | null;
  referencePriceDriftPercent: string | null;
  candidatePriceDriftPercent: string | null;
  referenceQuotes: QuotePoint[];
  candidateQuotes: QuotePoint[];
}

export interface PairedReferenceAnalysis {
  status: "complete" | "incomplete" | "failed" | "not_run";
  envelopeCoherence: EnvelopeCoherenceClass;
  referenceInputHuman: string | null;
  candidateSizesHuman: string[];
  maximumPairWindowMs: number;
  usablePairCount: number;
  pairs: PairedReferencePair[];
  pairedLargestObservedBelowThreshold: Record<string, unknown> | null;
  pairedFirstObservedAboveThreshold: Record<string, unknown> | null;
  pairedThresholdBoundaryBracketed: boolean;
  pairedRecommendedMaximumTranche: Record<string, unknown> | null;
  partialFailures: QuoteFailure[];
  warnings: string[];
}

export interface BatchCandidateResult {
  inputRaw: string;
  inputHuman: string;
  quote: QuotePoint;
  candidateAveragePrice: string | null;
  batchReferenceDeteriorationPercent: string | null;
  belowThreshold: boolean | null;
  minimumOutputHuman: string | null;
  routeMetadata: Record<string, unknown> | null;
  routeChangedFromReference: boolean;
  candidateRequestStartedAt: string;
  candidateResponseReceivedAt: string;
  candidateFailureReason: string | null;
}

export interface RejectedReferenceAmount {
  referenceAmountHuman: string;
  reason: string;
  batchStartedAt: string;
  batchCompletedAt: string;
}

export interface BatchConfirmation {
  referenceAmountHuman: string | null;
  selectedReferenceAmountHuman: string | null;
  rejectedReferenceAmounts: RejectedReferenceAmount[];
  referenceBefore: QuotePoint | null;
  referenceAfter: QuotePoint | null;
  referenceEqualityDetected: boolean | null;
  quoteIdentifierBefore: string | null;
  quoteIdentifierAfter: string | null;
  quoteTimestampBefore: string | null;
  quoteTimestampAfter: string | null;
  responseFingerprintBefore: string | null;
  responseFingerprintAfter: string | null;
  cacheHeaders: {
    before: Record<string, string> | null;
    after: Record<string, string> | null;
  };
  possibleCacheDetected: boolean;
  freshnessConfidence: FreshnessConfidence;
  freshnessClassification: "independently_refreshed" | "unchanged_market_possible" | "possible_cache" | "unknown";
  referenceAveragePrice: string | null;
  referenceDriftPercent: string | null;
  candidateResults: BatchCandidateResult[];
  batchStartedAt: string | null;
  batchCompletedAt: string | null;
  batchDurationMs: number | null;
  estimatedCriticalPathMs: number | null;
  actualBatchDurationMs: number | null;
  configuredMaximumBatchWindowMs: number | null;
  timingMarginMs: number | null;
  timingEstimateMethod: string;
  candidateConcurrency: number;
  complete: boolean;
  temporallyUsable: boolean;
  failureReasons: string[];
}

export interface OperationalTranchePlan {
  analyticalMaximumBelowThresholdHuman: string | null;
  bufferedMaximumHuman: string | null;
  operationalMaximumTrancheHuman: string | null;
  trancheIncrementHuman: string;
  roundingPolicy: string;
  analyticalThresholdPercent: string;
  operationalThresholdPercent: string;
  operationalSafetyBufferPercent: number;
  analyticalThresholdPercentRaw: string;
  operationalThresholdPercentRaw: string;
}

export interface ManualGuardrails {
  referenceAmountHuman: string | null;
  proposedTrancheHuman: string | null;
  maximumAllowedDeteriorationPercent: string;
  maximumReferenceDriftPercent: number;
  minimumOutputMustBePresent: true;
  maximumBatchAgeMs: number;
  requoteBeforeEveryExecution: true;
  reusableQuoteAllowed: false;
  stopConditions: string[];
}

export interface AdaptiveThresholdRound {
  round: number;
  candidateSizesHuman: string[];
  batchConfirmation: BatchConfirmation;
  largestObservedBelowThreshold: Record<string, unknown> | null;
  firstObservedAboveThreshold: Record<string, unknown> | null;
  thresholdBoundaryBracketed: boolean;
  bracketWidthHuman: string | null;
}

export interface AdaptiveThresholdSearch {
  initialLowerHuman: string | null;
  initialUpperHuman: string | null;
  rounds: AdaptiveThresholdRound[];
  finalLargestBelowThreshold: Record<string, unknown> | null;
  finalFirstAboveThreshold: Record<string, unknown> | null;
  finalBracketWidthHuman: string | null;
  thresholdBoundaryBracketed: boolean;
  recommendedMaximumTranche: Record<string, unknown> | null;
  terminationReason:
    | "not_run"
    | "no_initial_bracket"
    | "batch_unusable"
    | "bracket_width_reached"
    | "max_rounds_reached"
    | "no_candidate_sizes";
}

export interface PiteasReliability {
  requestsAttempted: number;
  requestsSucceeded: number;
  requestsFailed: number;
  timeoutCount: number;
  http500Count: number;
  retryCount: number;
  medianLatencyMs: number | null;
  p90LatencyMs: number | null;
  selectedConcurrency: number;
}

export interface ScheduledQuoteResult {
  result: PiteasQuoteResult;
  requestStartedAt: string;
  responseReceivedAt: string;
  attempts: QuoteAttemptMetadata[];
  schedulerRetryCount: number;
}

export interface QuoteScheduler {
  quote: (
    req: {
      tokenIn: string;
      tokenOut: string;
      amount: string;
      allowedSlippage: number;
      account?: string;
    },
    options: {
      allowRetries: boolean;
      maxRetries?: number;
    },
  ) => Promise<ScheduledQuoteResult>;
  quoteMany: <T>(
    items: T[],
    concurrency: number,
    task: (item: T, index: number) => Promise<QuotePoint>,
  ) => Promise<QuotePoint[]>;
  metrics: () => PiteasReliability;
}
