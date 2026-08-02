import type { AppConfig } from "../../../types.js";
import { PITEAS_QUOTE_ENDPOINT, PRICE_SCALE_DECIMALS } from "./constants.js";
import { decorateCurve } from "./coherence.js";
import {
  durationMs,
  formatBpsAsPercent,
  formatFixed,
  formatRawAmount,
  isSuccessfulPoint,
  nowIso,
  parseHumanAmount,
  parseUnsignedRaw,
} from "./decimalMath.js";
import { meanAveragePriceRaw } from "./pairedReference.js";
import { failedQuotePoint, successfulQuotePoint } from "./quoteNormalization.js";
import { routesStructurallyIncompatible } from "./routeSignatures.js";
import type {
  BatchCandidateResult,
  BatchConfirmation,
  FreshnessConfidence,
  PiteasAccumulationPlanDeps,
  QuotePoint,
  QuotePurpose,
  QuoteScheduler,
  RejectedReferenceAmount,
  SuccessfulPoint,
} from "./types.js";

export async function buildBatchConfirmation(input: {
  config: AppConfig;
  deps: PiteasAccumulationPlanDeps;
  scheduler: QuoteScheduler;
  eUsdcAddress: string;
  phiatAddress: string;
  account?: string;
  allowedSlippagePercent: number;
  eUsdcDecimals: number;
  phiatDecimals: number;
  thresholds: number[];
  maxGasCostBps: bigint;
  primaryThresholdBps: bigint;
  referenceAmountsRaw: bigint[];
  candidateSizesRaw: bigint[];
  maximumBatchWindowMs: number;
  maximumReferenceDriftBps: bigint;
  quoteConcurrency: number;
  allowLowConfidenceFreshness: boolean;
}): Promise<BatchConfirmation> {
  const rejectedReferenceAmounts: RejectedReferenceAmount[] = [];
  if (input.referenceAmountsRaw.length === 0 || input.candidateSizesRaw.length === 0) {
    return emptyBatchConfirmation({
      quoteConcurrency: input.quoteConcurrency,
      rejectedReferenceAmounts,
      reason:
        input.referenceAmountsRaw.length === 0
          ? "no_reference_amounts"
          : "no_candidate_sizes",
    });
  }

  for (const referenceRaw of input.referenceAmountsRaw) {
    const batch = await collectOneBatchConfirmation({
      ...input,
      referenceRaw,
      candidateSizesRaw: input.candidateSizesRaw,
    });
    if (referenceQuoteValid(batch.referenceBefore) && referenceQuoteValid(batch.referenceAfter)) {
      return {
        ...batch,
        selectedReferenceAmountHuman: batch.referenceAmountHuman,
        rejectedReferenceAmounts,
      };
    }
    rejectedReferenceAmounts.push({
      referenceAmountHuman: formatRawAmount(referenceRaw, input.eUsdcDecimals),
      reason: batch.failureReasons.join("; ") || "reference_invalid",
      batchStartedAt: batch.batchStartedAt ?? nowIso(input.deps),
      batchCompletedAt: batch.batchCompletedAt ?? nowIso(input.deps),
    });
  }

  return emptyBatchConfirmation({
    quoteConcurrency: input.quoteConcurrency,
    rejectedReferenceAmounts,
    reason: "all_reference_amounts_rejected",
  });
}

async function collectOneBatchConfirmation(input: {
  config: AppConfig;
  deps: PiteasAccumulationPlanDeps;
  scheduler: QuoteScheduler;
  eUsdcAddress: string;
  phiatAddress: string;
  account?: string;
  allowedSlippagePercent: number;
  eUsdcDecimals: number;
  phiatDecimals: number;
  thresholds: number[];
  maxGasCostBps: bigint;
  primaryThresholdBps: bigint;
  referenceRaw: bigint;
  referenceAmountsRaw: bigint[];
  candidateSizesRaw: bigint[];
  maximumBatchWindowMs: number;
  maximumReferenceDriftBps: bigint;
  quoteConcurrency: number;
  allowLowConfidenceFreshness: boolean;
}): Promise<BatchConfirmation> {
  const batchStartedAt = nowIso(input.deps);
  const referenceBefore = await requestQuotePoint({
    ...input,
    purpose: "batch_reference_before",
    sizeRaw: input.referenceRaw,
    index: 0,
    allowRetries: false,
  });
  const candidatePoints = await input.scheduler.quoteMany(
    input.candidateSizesRaw,
    input.quoteConcurrency,
    async (sizeRaw, index) =>
      requestQuotePoint({
        ...input,
        purpose: "batch_candidate",
        sizeRaw,
        index,
        allowRetries: false,
      }),
  );
  const referenceAfter = await requestQuotePoint({
    ...input,
    purpose: "batch_reference_after",
    sizeRaw: input.referenceRaw,
    index: 0,
    allowRetries: false,
  });
  const batchCompletedAt = nowIso(input.deps);
  const allPoints = [referenceBefore, ...candidatePoints, referenceAfter];
  decorateCurve(allPoints, {
    eUsdcDecimals: input.eUsdcDecimals,
    phiatDecimals: input.phiatDecimals,
    thresholds: input.thresholds,
  });
  const referenceAverage = meanAveragePriceRaw(
    [referenceBefore, referenceAfter].filter(isSuccessfulPoint),
  );
  const referenceDriftBps = referenceDriftRaw(referenceBefore, referenceAfter);
  const candidateResults = candidatePoints.map((point) =>
    buildBatchCandidateResult({
      point,
      referenceBefore,
      referenceAfter,
      referenceAverage,
      primaryThresholdBps: input.primaryThresholdBps,
    }),
  );
  const batchDurationMs = durationMs(batchStartedAt, batchCompletedAt);
  const freshness = buildReferenceFreshnessEvidence(referenceBefore, referenceAfter);
  const timing = buildBatchTimingEstimate({
    referenceBefore,
    referenceAfter,
    candidateResults,
    quoteConcurrency: input.quoteConcurrency,
    maximumBatchWindowMs: input.maximumBatchWindowMs,
  });
  const failureReasons = batchFailureReasons({
    referenceBefore,
    referenceAfter,
    candidateResults,
    referenceDriftBps,
    batchDurationMs,
    maximumBatchWindowMs: input.maximumBatchWindowMs,
    maximumReferenceDriftBps: input.maximumReferenceDriftBps,
    freshness,
    allowLowConfidenceFreshness: input.allowLowConfidenceFreshness,
  });
  return {
    referenceAmountHuman: formatRawAmount(input.referenceRaw, input.eUsdcDecimals),
    selectedReferenceAmountHuman: null,
    rejectedReferenceAmounts: [],
    referenceBefore,
    referenceAfter,
    ...freshness,
    referenceAveragePrice:
      referenceAverage !== null ? formatFixed(referenceAverage, PRICE_SCALE_DECIMALS) : null,
    referenceDriftPercent:
      referenceDriftBps !== null ? formatBpsAsPercent(referenceDriftBps) : null,
    candidateResults,
    batchStartedAt,
    batchCompletedAt,
    batchDurationMs,
    estimatedCriticalPathMs: timing.estimatedCriticalPathMs,
    actualBatchDurationMs: timing.actualBatchDurationMs,
    configuredMaximumBatchWindowMs: timing.configuredMaximumBatchWindowMs,
    timingMarginMs: timing.timingMarginMs,
    timingEstimateMethod: timing.timingEstimateMethod,
    candidateConcurrency: input.quoteConcurrency,
    complete:
      referenceQuoteValid(referenceBefore) &&
      referenceQuoteValid(referenceAfter) &&
      candidateResults.every((candidate) => candidate.candidateFailureReason === null),
    temporallyUsable: failureReasons.length === 0,
    failureReasons,
  };
}

async function requestQuotePoint(input: {
  config: AppConfig;
  deps: PiteasAccumulationPlanDeps;
  scheduler: QuoteScheduler;
  eUsdcAddress: string;
  phiatAddress: string;
  account?: string;
  allowedSlippagePercent: number;
  eUsdcDecimals: number;
  phiatDecimals: number;
  maxGasCostBps: bigint;
  purpose: QuotePurpose;
  sizeRaw: bigint;
  index: number;
  allowRetries: boolean;
}): Promise<QuotePoint> {
  const inputHuman = formatRawAmount(input.sizeRaw, input.eUsdcDecimals);
  const scheduled = await input.scheduler.quote({
    tokenIn: input.eUsdcAddress,
    tokenOut: input.phiatAddress,
    amount: input.sizeRaw.toString(),
    allowedSlippage: input.allowedSlippagePercent,
    account: input.account,
  }, {
    allowRetries: input.allowRetries,
  });
  if (!scheduled.result.ok) {
    return failedQuotePoint({
      index: input.index,
      purpose: input.purpose,
      sizeRaw: input.sizeRaw,
      inputHuman,
      requestStartedAt: scheduled.requestStartedAt,
      responseReceivedAt: scheduled.responseReceivedAt,
      reason: scheduled.result.reason,
      endpoint: PITEAS_QUOTE_ENDPOINT,
      retryCount: scheduled.schedulerRetryCount,
      attempts: scheduled.attempts,
    });
  }
  return successfulQuotePoint({
    index: input.index,
    purpose: input.purpose,
    expectedInputRaw: input.sizeRaw,
    inputHuman,
    result: scheduled.result,
    requestStartedAt: scheduled.requestStartedAt,
    responseReceivedAt: scheduled.responseReceivedAt,
    eUsdcDecimals: input.eUsdcDecimals,
    phiatDecimals: input.phiatDecimals,
    maxGasCostBps: input.maxGasCostBps,
    schedulerRetryCount: scheduled.schedulerRetryCount,
    attempts: scheduled.attempts,
  });
}

function buildBatchCandidateResult(input: {
  point: QuotePoint;
  referenceBefore: QuotePoint;
  referenceAfter: QuotePoint;
  referenceAverage: bigint | null;
  primaryThresholdBps: bigint;
}): BatchCandidateResult {
  const point = input.point;
  const candidateAverageRaw = isSuccessfulPoint(point) && point.averagePrice
    ? parseHumanAmount(point.averagePrice, PRICE_SCALE_DECIMALS, "averagePrice")
    : null;
  const deteriorationBps =
    candidateAverageRaw !== null &&
    input.referenceAverage !== null &&
    input.referenceAverage > 0n
      ? ((candidateAverageRaw - input.referenceAverage) * 10000n) /
        input.referenceAverage
      : null;
  return {
    inputRaw: point.inputRaw,
    inputHuman: point.inputHuman,
    quote: point,
    candidateAveragePrice: point.averagePrice,
    batchReferenceDeteriorationPercent:
      deteriorationBps !== null ? formatBpsAsPercent(deteriorationBps) : null,
    belowThreshold:
      deteriorationBps !== null ? deteriorationBps < input.primaryThresholdBps : null,
    minimumOutputHuman: point.minimumOutputHuman,
    routeMetadata: point.routeComposition,
    routeChangedFromReference:
      isSuccessfulPoint(input.referenceBefore) && isSuccessfulPoint(point)
        ? routesStructurallyIncompatible(input.referenceBefore, point)
        : false,
    candidateRequestStartedAt: point.requestStartedAt,
    candidateResponseReceivedAt: point.responseReceivedAt,
    candidateFailureReason: isSuccessfulPoint(point)
      ? validPositiveQuoteReason(point)
      : point.quoteError ?? "quote unavailable",
  };
}

function buildReferenceFreshnessEvidence(
  before: QuotePoint,
  after: QuotePoint,
): Pick<
  BatchConfirmation,
  | "referenceEqualityDetected"
  | "quoteIdentifierBefore"
  | "quoteIdentifierAfter"
  | "quoteTimestampBefore"
  | "quoteTimestampAfter"
  | "responseFingerprintBefore"
  | "responseFingerprintAfter"
  | "cacheHeaders"
  | "possibleCacheDetected"
  | "freshnessConfidence"
  | "freshnessClassification"
> {
  const beforeFingerprint = quoteResponseFingerprint(before);
  const afterFingerprint = quoteResponseFingerprint(after);
  const referenceEqualityDetected =
    beforeFingerprint !== null && afterFingerprint !== null
      ? beforeFingerprint === afterFingerprint
      : null;
  const independentRefreshEvidence =
    differentNonNull(before.quoteIdentifier, after.quoteIdentifier) ||
    differentNonNull(before.quoteTimestamp, after.quoteTimestamp) ||
    differentNonNull(before.expiresAt, after.expiresAt) ||
    differentNonNull(before.blockNumber, after.blockNumber);
  const freshnessMetadataPresent =
    hasFreshnessMetadata(before) || hasFreshnessMetadata(after);
  const cacheHeaderSignal =
    cacheHeadersSuggestPossibleCache(before.cacheHeaders) ||
    cacheHeadersSuggestPossibleCache(after.cacheHeaders);
  const possibleCacheDetected =
    cacheHeaderSignal ||
    (referenceEqualityDetected === true &&
      !independentRefreshEvidence &&
      !freshnessMetadataPresent);
  const freshnessConfidence: FreshnessConfidence =
    referenceEqualityDetected === false || independentRefreshEvidence
      ? "high"
      : referenceEqualityDetected === true && !freshnessMetadataPresent
        ? "low"
        : "medium";
  const freshnessClassification =
    freshnessConfidence === "high"
      ? "independently_refreshed"
      : referenceEqualityDetected === true && possibleCacheDetected
        ? "possible_cache"
        : referenceEqualityDetected === true
          ? "unchanged_market_possible"
          : "unknown";
  return {
    referenceEqualityDetected,
    quoteIdentifierBefore: before.quoteIdentifier,
    quoteIdentifierAfter: after.quoteIdentifier,
    quoteTimestampBefore: before.quoteTimestamp,
    quoteTimestampAfter: after.quoteTimestamp,
    responseFingerprintBefore: beforeFingerprint,
    responseFingerprintAfter: afterFingerprint,
    cacheHeaders: {
      before: before.cacheHeaders,
      after: after.cacheHeaders,
    },
    possibleCacheDetected,
    freshnessConfidence,
    freshnessClassification,
  };
}

function quoteResponseFingerprint(point: QuotePoint): string | null {
  return point.responseFingerprint;
}

function differentNonNull(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left !== right;
}

function hasFreshnessMetadata(point: QuotePoint): boolean {
  return Boolean(
    point.quoteIdentifier ||
      point.quoteTimestamp ||
      point.expiresAt ||
      point.blockNumber,
  );
}

function cacheHeadersSuggestPossibleCache(
  headers: Record<string, string> | null,
): boolean {
  if (!headers) return false;
  const age = Number(headers.age);
  if (Number.isFinite(age) && age > 0) return true;
  const joined = Object.entries(headers)
    .map(([key, value]) => `${key}:${value}`)
    .join("\n")
    .toLowerCase();
  return /\b(hit|cached|stale)\b/.test(joined);
}

function buildBatchTimingEstimate(input: {
  referenceBefore: QuotePoint;
  referenceAfter: QuotePoint;
  candidateResults: BatchCandidateResult[];
  quoteConcurrency: number;
  maximumBatchWindowMs: number;
}): Pick<
  BatchConfirmation,
  | "estimatedCriticalPathMs"
  | "actualBatchDurationMs"
  | "configuredMaximumBatchWindowMs"
  | "timingMarginMs"
  | "timingEstimateMethod"
> {
  const beforeLatency = quoteLatencyMs(input.referenceBefore);
  const afterLatency = quoteLatencyMs(input.referenceAfter);
  const candidateLatencies = input.candidateResults
    .map((candidate) => quoteLatencyMs(candidate.quote))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const candidateMedianLatency =
    candidateLatencies.length > 0 ? medianNumber(candidateLatencies) : null;
  const actualBatchDurationMs = durationMs(
    input.referenceBefore.requestStartedAt,
    input.referenceAfter.responseReceivedAt,
  );
  const estimatedCriticalPathMs =
    beforeLatency !== null &&
    afterLatency !== null &&
    candidateMedianLatency !== null
      ? beforeLatency +
        Math.ceil(input.candidateResults.length / Math.max(1, input.quoteConcurrency)) *
          candidateMedianLatency +
        afterLatency
      : null;
  return {
    estimatedCriticalPathMs,
    actualBatchDurationMs,
    configuredMaximumBatchWindowMs: input.maximumBatchWindowMs,
    timingMarginMs:
      estimatedCriticalPathMs !== null
        ? input.maximumBatchWindowMs - estimatedCriticalPathMs
        : null,
    timingEstimateMethod:
      "referenceBeforeLatency + ceil(candidateCount / concurrency) * candidateMedianLatency + referenceAfterLatency",
  };
}

function quoteLatencyMs(point: QuotePoint): number | null {
  if (point.attempts.length > 0) {
    return point.attempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0);
  }
  return durationMs(point.requestStartedAt, point.responseReceivedAt);
}

function medianNumber(sortedValues: number[]): number {
  const mid = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[mid]!;
  return Math.round((sortedValues[mid - 1]! + sortedValues[mid]!) / 2);
}

function batchFailureReasons(input: {
  referenceBefore: QuotePoint;
  referenceAfter: QuotePoint;
  candidateResults: BatchCandidateResult[];
  referenceDriftBps: bigint | null;
  batchDurationMs: number;
  maximumBatchWindowMs: number;
  maximumReferenceDriftBps: bigint;
  freshness: Pick<
    BatchConfirmation,
    "referenceEqualityDetected" | "possibleCacheDetected" | "freshnessConfidence"
  >;
  allowLowConfidenceFreshness: boolean;
}): string[] {
  const reasons: string[] = [];
  if (!referenceQuoteValid(input.referenceBefore)) reasons.push("reference_before_invalid");
  if (!referenceQuoteValid(input.referenceAfter)) reasons.push("reference_after_invalid");
  if (input.referenceDriftBps === null) {
    reasons.push("reference_drift_unavailable");
  } else if (absBigInt(input.referenceDriftBps) > input.maximumReferenceDriftBps) {
    reasons.push("reference_drift_exceeded");
  }
  if (input.batchDurationMs > input.maximumBatchWindowMs) {
    reasons.push("batch_duration_exceeded");
  }
  if (
    input.freshness.referenceEqualityDetected === true &&
    input.freshness.freshnessConfidence === "low" &&
    input.freshness.possibleCacheDetected &&
    !input.allowLowConfidenceFreshness
  ) {
    reasons.push("low_confidence_reference_freshness");
  }
  const successfulCandidates = input.candidateResults.filter(
    (candidate) => candidate.candidateFailureReason === null,
  );
  if (successfulCandidates.length < 2) reasons.push("fewer_than_two_successful_candidates");
  if (input.candidateResults.some((candidate) => candidate.candidateFailureReason !== null)) {
    reasons.push("one_or_more_candidate_quotes_invalid");
  }
  return reasons;
}

export function emptyBatchConfirmation(input: {
  quoteConcurrency: number;
  rejectedReferenceAmounts: RejectedReferenceAmount[];
  reason: string;
}): BatchConfirmation {
  return {
    referenceAmountHuman: null,
    selectedReferenceAmountHuman: null,
    rejectedReferenceAmounts: input.rejectedReferenceAmounts,
    referenceBefore: null,
    referenceAfter: null,
    referenceEqualityDetected: null,
    quoteIdentifierBefore: null,
    quoteIdentifierAfter: null,
    quoteTimestampBefore: null,
    quoteTimestampAfter: null,
    responseFingerprintBefore: null,
    responseFingerprintAfter: null,
    cacheHeaders: { before: null, after: null },
    possibleCacheDetected: false,
    freshnessConfidence: "low",
    freshnessClassification: "unknown",
    referenceAveragePrice: null,
    referenceDriftPercent: null,
    candidateResults: [],
    batchStartedAt: null,
    batchCompletedAt: null,
    batchDurationMs: null,
    estimatedCriticalPathMs: null,
    actualBatchDurationMs: null,
    configuredMaximumBatchWindowMs: null,
    timingMarginMs: null,
    timingEstimateMethod:
      "referenceBeforeLatency + ceil(candidateCount / concurrency) * candidateMedianLatency + referenceAfterLatency",
    candidateConcurrency: input.quoteConcurrency,
    complete: false,
    temporallyUsable: false,
    failureReasons: [input.reason],
  };
}

function referenceQuoteValid(point: QuotePoint | null): point is SuccessfulPoint {
  if (!point || !isSuccessfulPoint(point)) return false;
  return validPositiveQuoteReason(point) === null;
}

function validPositiveQuoteReason(point: QuotePoint): string | null {
  if (!isSuccessfulPoint(point)) return point.quoteError ?? "quote unavailable";
  if (parseUnsignedRaw(point.outputRaw) === null || parseUnsignedRaw(point.outputRaw)! <= 0n) {
    return "output_not_positive";
  }
  const minRaw = parseUnsignedRaw(point.minimumOutputRaw);
  if (minRaw === null || minRaw <= 0n) return "minimum_output_not_positive";
  if (!point.averagePrice) return "average_price_unavailable";
  return null;
}

function referenceDriftRaw(before: QuotePoint, after: QuotePoint): bigint | null {
  if (!isSuccessfulPoint(before) || !isSuccessfulPoint(after)) return null;
  if (!before.averagePrice || !after.averagePrice) return null;
  const beforeRaw = parseHumanAmount(before.averagePrice, PRICE_SCALE_DECIMALS, "averagePrice");
  const afterRaw = parseHumanAmount(after.averagePrice, PRICE_SCALE_DECIMALS, "averagePrice");
  if (beforeRaw === 0n) return null;
  return ((afterRaw - beforeRaw) * 10000n) / beforeRaw;
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function buildBatchThresholdSemantics(
  batch: BatchConfirmation,
): {
  largestObservedBelowThreshold: BatchCandidateResult | null;
  firstObservedAboveThreshold: BatchCandidateResult | null;
  thresholdBoundaryBracketed: boolean;
} {
  let largestObservedBelowThreshold: BatchCandidateResult | null = null;
  let firstObservedAboveThreshold: BatchCandidateResult | null = null;
  for (const candidate of batch.candidateResults
    .filter((item) => item.candidateFailureReason === null && item.belowThreshold !== null)
    .sort((a, b) => {
      const ar = BigInt(a.inputRaw);
      const br = BigInt(b.inputRaw);
      return ar < br ? -1 : ar > br ? 1 : 0;
    })) {
    if (candidate.belowThreshold === false) {
      if (
        largestObservedBelowThreshold &&
        BigInt(candidate.inputRaw) > BigInt(largestObservedBelowThreshold.inputRaw)
      ) {
        firstObservedAboveThreshold = candidate;
        break;
      }
      firstObservedAboveThreshold ??= candidate;
      continue;
    }
    largestObservedBelowThreshold = candidate;
  }
  return {
    largestObservedBelowThreshold,
    firstObservedAboveThreshold,
    thresholdBoundaryBracketed:
      largestObservedBelowThreshold !== null &&
      firstObservedAboveThreshold !== null &&
      BigInt(firstObservedAboveThreshold.inputRaw) >
        BigInt(largestObservedBelowThreshold.inputRaw),
  };
}

export function batchCandidatePlan(candidate: BatchCandidateResult): Record<string, unknown> {
  return {
    inputHuman: candidate.inputHuman,
    inputRaw: candidate.inputRaw,
    expectedOutputHuman: candidate.quote.outputHuman,
    expectedOutputRaw: candidate.quote.outputRaw,
    minimumOutputHuman: candidate.minimumOutputHuman,
    minimumOutputRaw: candidate.quote.minimumOutputRaw,
    candidateAveragePrice: candidate.candidateAveragePrice,
    batchReferenceDeteriorationPercent:
      candidate.batchReferenceDeteriorationPercent,
    belowThreshold: candidate.belowThreshold,
    routeChangedFromReference: candidate.routeChangedFromReference,
    gasUseEstimate: candidate.quote.gasUseEstimate,
    gasUseEstimateUSD: candidate.quote.gasUseEstimateUSD,
    routeComposition: candidate.routeMetadata,
  };
}

export function batchThresholdPlans(batch: BatchConfirmation): {
  largestObservedBelowThreshold: Record<string, unknown> | null;
  firstObservedAboveThreshold: Record<string, unknown> | null;
  thresholdBoundaryBracketed: boolean;
  recommendedMaximumTranche: Record<string, unknown> | null;
} {
  const threshold = buildBatchThresholdSemantics(batch);
  return {
    largestObservedBelowThreshold: threshold.largestObservedBelowThreshold
      ? batchCandidatePlan(threshold.largestObservedBelowThreshold)
      : null,
    firstObservedAboveThreshold: threshold.firstObservedAboveThreshold
      ? batchCandidatePlan(threshold.firstObservedAboveThreshold)
      : null,
    thresholdBoundaryBracketed: threshold.thresholdBoundaryBracketed,
    recommendedMaximumTranche:
      batch.temporallyUsable &&
      threshold.thresholdBoundaryBracketed &&
      threshold.largestObservedBelowThreshold
        ? batchCandidatePlan(threshold.largestObservedBelowThreshold)
        : null,
  };
}
