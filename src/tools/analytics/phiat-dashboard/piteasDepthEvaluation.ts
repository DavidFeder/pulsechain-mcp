import {
  FAST_PITEAS_ANALYTICAL_THRESHOLD_PERCENT,
  FAST_PITEAS_EUSDC_DECIMALS,
  FAST_PITEAS_LOWER_CANDIDATE_HUMAN,
  FAST_PITEAS_MAX_REFERENCE_DRIFT_PERCENT,
  FAST_PITEAS_OPERATIONAL_SAFETY_BUFFER_PERCENT,
  FAST_PITEAS_REFERENCE_AMOUNT_HUMAN,
  FAST_PITEAS_TRANCHE_INCREMENT_HUMAN,
  FAST_PITEAS_UPPER_CANDIDATE_HUMAN,
} from "./constants.js";
import { dedupeFailures, formatRawUnits, numberOrNull, round } from "./math.js";
import type {
  FreshnessConfidence,
  FastFreshnessAnalysis,
  FastPiteasEvaluation,
  FastQuoteAttempt,
  FastQuoteSummary,
  PartialFailure,
  PhiatDashboardDeps,
  RecommendationBasis,
  RecommendationStatus,
  ThresholdRecommendationStatus,
} from "./builder.js";

export function evaluateFastPiteasBatch(input: {
  attempts: FastQuoteAttempt[];
  warnings: string[];
  deadlineMs: number;
  analyticalThresholdPercent: number;
  operationalThresholdPercent: number;
}): FastPiteasEvaluation {
  const referenceBefore = latestAttempt(input.attempts, "reference_before");
  const referenceAfter = latestAttempt(input.attempts, "reference_after");
  const lowerCandidate = latestAttempt(input.attempts, "lower_candidate");
  const upperCandidate = latestAttempt(input.attempts, "upper_candidate");
  const requiredAttempts = [
    referenceBefore,
    lowerCandidate,
    upperCandidate,
    referenceAfter,
  ];
  const successfulRequired = requiredAttempts.every((attempt) => attempt?.ok);
  const usefulQuoteCount = input.attempts.filter((attempt) => attempt.ok).length;
  const freshness =
    referenceBefore?.quote && referenceAfter?.quote
      ? analyzeFastReferenceFreshness(referenceBefore.quote, referenceAfter.quote)
      : emptyFreshnessAnalysis();
  const warnings = [...input.warnings, ...freshness.warnings];

  const referenceAveragePrice = meanReferenceAveragePrice(input.attempts);
  const referenceDriftPercent =
    referenceBefore?.quote?.averagePrice !== null &&
    referenceBefore?.quote?.averagePrice !== undefined &&
    referenceAfter?.quote?.averagePrice !== null &&
    referenceAfter?.quote?.averagePrice !== undefined
      ? round(
          Math.abs(
            (referenceAfter.quote.averagePrice / referenceBefore.quote.averagePrice - 1) *
              100,
          ),
          6,
        )
      : null;
  const lowerDeteriorationPercent = computeDeteriorationPercent(
    lowerCandidate?.quote ?? null,
    referenceAveragePrice,
  );
  const upperDeteriorationPercent = computeDeteriorationPercent(
    upperCandidate?.quote ?? null,
    referenceAveragePrice,
  );
  const candidateEvaluations = input.attempts
    .filter((attempt) =>
      attempt.label === "lower_candidate" ||
      attempt.label === "upper_candidate" ||
      attempt.label === "optional_midpoint",
    )
    .map((attempt) => ({
      attempt,
      deteriorationPercent: computeDeteriorationPercent(
        attempt.quote,
        referenceAveragePrice,
      ),
    }))
    .filter((row) => row.attempt.ok && row.deteriorationPercent !== null);

  if (usefulQuoteCount === 0) {
    return {
      recommendationStatus: "unavailable",
      recommendationBasis: "none",
      analyticalRecommendationStatus: "unavailable",
      operationalRecommendationStatus: "unavailable",
      analyticalMaximumBelowThresholdHuman: null,
      analyticalLargestConfirmedBelowThresholdHuman: null,
      analyticalFirstConfirmedAboveThresholdHuman: null,
      analyticalThresholdBoundaryBracketed: false,
      operationalMaximumTrancheHuman: null,
      operationalLargestConfirmedBelowThresholdHuman: null,
      operationalFirstConfirmedAboveThresholdHuman: null,
      operationalRecommendedMaximumTrancheHuman: null,
      operationalThresholdBoundaryBracketed: false,
      firstConfirmedAboveThresholdHuman: null,
      thresholdBoundaryBracketed: false,
      lowerDeteriorationPercent,
      upperDeteriorationPercent,
      referenceDriftPercent,
      freshness,
      warnings,
    };
  }

  if (!successfulRequired) {
    const analyticalEvidence = buildThresholdEvidence({
      candidateEvaluations,
      thresholdPercent: input.analyticalThresholdPercent,
      batchUsable: false,
      usefulQuoteCount,
    });
    const operationalEvidence = buildThresholdEvidence({
      candidateEvaluations,
      thresholdPercent: input.operationalThresholdPercent,
      batchUsable: false,
      usefulQuoteCount,
    });
    const operationalRecommendedMaximumTrancheHuman =
      operationalEvidence.largestConfirmedBelowThresholdHuman !== null
        ? roundHumanDownToIncrement(
            operationalEvidence.largestConfirmedBelowThresholdHuman,
            FAST_PITEAS_TRANCHE_INCREMENT_HUMAN,
            FAST_PITEAS_EUSDC_DECIMALS,
          )
        : null;
    return {
      recommendationStatus: "requote_required",
      recommendationBasis: "partial_evidence",
      analyticalRecommendationStatus: analyticalEvidence.recommendationStatus,
      operationalRecommendationStatus: operationalEvidence.recommendationStatus,
      analyticalMaximumBelowThresholdHuman:
        analyticalEvidence.largestConfirmedBelowThresholdHuman,
      analyticalLargestConfirmedBelowThresholdHuman:
        analyticalEvidence.largestConfirmedBelowThresholdHuman,
      analyticalFirstConfirmedAboveThresholdHuman:
        analyticalEvidence.firstConfirmedAboveThresholdHuman,
      analyticalThresholdBoundaryBracketed:
        analyticalEvidence.thresholdBoundaryBracketed,
      operationalMaximumTrancheHuman: operationalRecommendedMaximumTrancheHuman,
      operationalLargestConfirmedBelowThresholdHuman:
        operationalEvidence.largestConfirmedBelowThresholdHuman,
      operationalFirstConfirmedAboveThresholdHuman:
        operationalEvidence.firstConfirmedAboveThresholdHuman,
      operationalRecommendedMaximumTrancheHuman,
      operationalThresholdBoundaryBracketed:
        operationalEvidence.thresholdBoundaryBracketed,
      firstConfirmedAboveThresholdHuman:
        analyticalEvidence.firstConfirmedAboveThresholdHuman,
      thresholdBoundaryBracketed: analyticalEvidence.thresholdBoundaryBracketed,
      lowerDeteriorationPercent,
      upperDeteriorationPercent,
      referenceDriftPercent,
      freshness,
      warnings,
    };
  }

  if (
    referenceDriftPercent === null ||
    referenceDriftPercent > FAST_PITEAS_MAX_REFERENCE_DRIFT_PERCENT
  ) {
    warnings.push(
      "Reference drift exceeded the dashboard threshold; fast Piteas recommendation withheld.",
    );
  }
  if (!freshness.freshnessAcceptable) {
    warnings.push(
      "Reference freshness was insufficient for an available dashboard Piteas recommendation.",
    );
  }
  const completedWithinDeadline = requiredAttempts.every((attempt) => {
    if (!attempt?.responseReceivedAt) return false;
    return Date.parse(attempt.responseReceivedAt) <= input.deadlineMs;
  });
  if (!completedWithinDeadline) {
    warnings.push("Fast Piteas quote sandwich completed after the configured deadline.");
  }

  const batchUsable =
    referenceDriftPercent !== null &&
    referenceDriftPercent <= FAST_PITEAS_MAX_REFERENCE_DRIFT_PERCENT &&
    freshness.freshnessAcceptable &&
    completedWithinDeadline;
  const analyticalEvidence = buildThresholdEvidence({
    candidateEvaluations,
    thresholdPercent: input.analyticalThresholdPercent,
    batchUsable,
    usefulQuoteCount,
  });
  const operationalEvidence = buildThresholdEvidence({
    candidateEvaluations,
    thresholdPercent: input.operationalThresholdPercent,
    batchUsable,
    usefulQuoteCount,
  });
  const operationalRecommendedMaximumTrancheHuman =
    operationalEvidence.largestConfirmedBelowThresholdHuman !== null
      ? roundHumanDownToIncrement(
          operationalEvidence.largestConfirmedBelowThresholdHuman,
          FAST_PITEAS_TRANCHE_INCREMENT_HUMAN,
          FAST_PITEAS_EUSDC_DECIMALS,
        )
      : null;
  const canRecommend = analyticalEvidence.recommendationStatus === "available";

  return {
    recommendationStatus: canRecommend ? "available" : "requote_required",
    recommendationBasis: canRecommend ? "batch_sandwich" : "partial_evidence",
    analyticalRecommendationStatus: analyticalEvidence.recommendationStatus,
    operationalRecommendationStatus: operationalEvidence.recommendationStatus,
    analyticalMaximumBelowThresholdHuman:
      analyticalEvidence.largestConfirmedBelowThresholdHuman,
    analyticalLargestConfirmedBelowThresholdHuman:
      analyticalEvidence.largestConfirmedBelowThresholdHuman,
    analyticalFirstConfirmedAboveThresholdHuman:
      analyticalEvidence.firstConfirmedAboveThresholdHuman,
    analyticalThresholdBoundaryBracketed:
      analyticalEvidence.thresholdBoundaryBracketed,
    operationalMaximumTrancheHuman: operationalRecommendedMaximumTrancheHuman,
    operationalLargestConfirmedBelowThresholdHuman:
      operationalEvidence.largestConfirmedBelowThresholdHuman,
    operationalFirstConfirmedAboveThresholdHuman:
      operationalEvidence.firstConfirmedAboveThresholdHuman,
    operationalRecommendedMaximumTrancheHuman,
    operationalThresholdBoundaryBracketed:
      operationalEvidence.thresholdBoundaryBracketed,
    firstConfirmedAboveThresholdHuman:
      analyticalEvidence.firstConfirmedAboveThresholdHuman,
    thresholdBoundaryBracketed: analyticalEvidence.thresholdBoundaryBracketed,
    lowerDeteriorationPercent,
    upperDeteriorationPercent,
    referenceDriftPercent,
    freshness,
    warnings,
  };
}

export function buildThresholdEvidence(input: {
  candidateEvaluations: Array<{
    attempt: FastQuoteAttempt;
    deteriorationPercent: number | null;
  }>;
  thresholdPercent: number;
  batchUsable: boolean;
  usefulQuoteCount: number;
}): {
  largestConfirmedBelowThresholdHuman: string | null;
  firstConfirmedAboveThresholdHuman: string | null;
  thresholdBoundaryBracketed: boolean;
  recommendationStatus: ThresholdRecommendationStatus;
} {
  // Align with planner/batch sandwich: exact threshold counts as crossed (not below).
  const below = input.candidateEvaluations
    .filter((row) => row.deteriorationPercent !== null)
    .filter((row) => row.deteriorationPercent! < input.thresholdPercent)
    .sort(compareAttemptHuman);
  const above = input.candidateEvaluations
    .filter((row) => row.deteriorationPercent !== null)
    .filter((row) => row.deteriorationPercent! >= input.thresholdPercent)
    .sort(compareAttemptHuman);
  const largestConfirmedBelowThresholdHuman = below.at(-1)?.attempt.inputHuman ?? null;
  const firstConfirmedAboveThresholdHuman = above.find((row) =>
    largestConfirmedBelowThresholdHuman === null
      ? true
      : parseHumanAmountRaw(row.attempt.inputHuman, FAST_PITEAS_EUSDC_DECIMALS) >
        parseHumanAmountRaw(
          largestConfirmedBelowThresholdHuman,
          FAST_PITEAS_EUSDC_DECIMALS,
        ),
  )?.attempt.inputHuman ?? null;
  const thresholdBoundaryBracketed =
    largestConfirmedBelowThresholdHuman !== null &&
    firstConfirmedAboveThresholdHuman !== null;
  const recommendationStatus: ThresholdRecommendationStatus =
    input.usefulQuoteCount === 0
      ? "unavailable"
      : thresholdBoundaryBracketed
        ? input.batchUsable
          ? "available"
          : "requote_required"
        : largestConfirmedBelowThresholdHuman !== null ||
            firstConfirmedAboveThresholdHuman !== null
          ? "partial_boundary"
          : "requote_required";

  return {
    largestConfirmedBelowThresholdHuman,
    firstConfirmedAboveThresholdHuman,
    thresholdBoundaryBracketed,
    recommendationStatus,
  };
}

export function fastDepthPayload(input: {
  fetchedAt: string;
  configuredTimeoutMs: number;
  startedMs: number;
  attempts: FastQuoteAttempt[];
  evaluation: FastPiteasEvaluation;
  partialFailures: PartialFailure[];
}): Record<string, unknown> {
  const completedMs = lastAttemptMs(input.attempts) ?? nowFromIso(input.fetchedAt) ?? input.startedMs;
  const batchDurationMs = Math.max(0, completedMs - input.startedMs);
  const timingMarginMs = input.configuredTimeoutMs - batchDurationMs;
  const piteasReliability = buildFastPiteasReliability({
    attempts: input.attempts,
    configuredTimeoutMs: input.configuredTimeoutMs,
    batchDurationMs,
    timingMarginMs,
    evaluation: input.evaluation,
  });
  const guardrails = {
    referenceAmountHuman: FAST_PITEAS_REFERENCE_AMOUNT_HUMAN,
    proposedTrancheHuman:
      input.evaluation.operationalRecommendedMaximumTrancheHuman,
    maximumAllowedDeteriorationPercent:
      FAST_PITEAS_ANALYTICAL_THRESHOLD_PERCENT -
      FAST_PITEAS_OPERATIONAL_SAFETY_BUFFER_PERCENT,
    maximumReferenceDriftPercent: FAST_PITEAS_MAX_REFERENCE_DRIFT_PERCENT,
    minimumOutputMustBePresent: true,
    maximumBatchAgeMs: input.configuredTimeoutMs,
    requoteBeforeEveryExecution: true,
    reusableQuoteAllowed: false,
    stopConditions: [
      "Stop if either reference quote fails or lacks positive output/minimum output.",
      "Stop if lower or upper candidate quote fails or lacks positive output/minimum output.",
      "Stop if before/after reference drift exceeds 0.5%.",
      "Stop if identical references lack independent freshness evidence.",
      "Stop if any transaction preparation, signing, submission, broadcast, execution, or wallet path would be required.",
    ],
  };

  return {
    mode: "fast",
    recommendationStatus: input.evaluation.recommendationStatus,
    recommendationBasis: input.evaluation.recommendationBasis,
    analyticalRecommendationStatus:
      input.evaluation.analyticalRecommendationStatus,
    operationalRecommendationStatus:
      input.evaluation.operationalRecommendationStatus,
    selectedReferenceAmountHuman: FAST_PITEAS_REFERENCE_AMOUNT_HUMAN,
    lowerCandidateHuman: FAST_PITEAS_LOWER_CANDIDATE_HUMAN,
    upperCandidateHuman: FAST_PITEAS_UPPER_CANDIDATE_HUMAN,
    analyticalMaximumBelowThresholdHuman:
      input.evaluation.analyticalMaximumBelowThresholdHuman,
    analyticalLargestConfirmedBelowThresholdHuman:
      input.evaluation.analyticalLargestConfirmedBelowThresholdHuman,
    analyticalFirstConfirmedAboveThresholdHuman:
      input.evaluation.analyticalFirstConfirmedAboveThresholdHuman,
    analyticalThresholdBoundaryBracketed:
      input.evaluation.analyticalThresholdBoundaryBracketed,
    operationalMaximumTrancheHuman: input.evaluation.operationalMaximumTrancheHuman,
    operationalLargestConfirmedBelowThresholdHuman:
      input.evaluation.operationalLargestConfirmedBelowThresholdHuman,
    operationalFirstConfirmedAboveThresholdHuman:
      input.evaluation.operationalFirstConfirmedAboveThresholdHuman,
    operationalRecommendedMaximumTrancheHuman:
      input.evaluation.operationalRecommendedMaximumTrancheHuman,
    operationalThresholdBoundaryBracketed:
      input.evaluation.operationalThresholdBoundaryBracketed,
    firstConfirmedAboveThresholdHuman:
      input.evaluation.firstConfirmedAboveThresholdHuman,
    thresholdBoundaryBracketed: input.evaluation.thresholdBoundaryBracketed,
    lowerDeteriorationPercent: input.evaluation.lowerDeteriorationPercent,
    upperDeteriorationPercent: input.evaluation.upperDeteriorationPercent,
    analyticalThresholdPercent: FAST_PITEAS_ANALYTICAL_THRESHOLD_PERCENT,
    operationalThresholdPercent:
      FAST_PITEAS_ANALYTICAL_THRESHOLD_PERCENT -
      FAST_PITEAS_OPERATIONAL_SAFETY_BUFFER_PERCENT,
    referenceDriftPercent: input.evaluation.referenceDriftPercent,
    freshnessConfidence: input.evaluation.freshness.freshnessConfidence,
    possibleCacheDetected: input.evaluation.freshness.possibleCacheDetected,
    batchDurationMs,
    configuredTimeoutMs: input.configuredTimeoutMs,
    timingMarginMs,
    piteasReliability,
    guardrails,
    partialFailures: dedupeFailures(input.partialFailures),
    warnings: [...new Set(input.evaluation.warnings)],
    fetchedAt: input.fetchedAt,
  };
}

export function buildFastPiteasReliability(input: {
  attempts: FastQuoteAttempt[];
  configuredTimeoutMs: number;
  batchDurationMs: number;
  timingMarginMs: number;
  evaluation: FastPiteasEvaluation;
}): Record<string, unknown> {
  const referenceAveragePrice = meanReferenceAveragePrice(input.attempts);
  return {
    requestsAttempted: input.attempts.length,
    requestsSucceeded: input.attempts.filter((attempt) => attempt.ok).length,
    requestsFailed: input.attempts.filter((attempt) => !attempt.ok).length,
    timeoutCount: input.attempts.filter((attempt) => attempt.timedOut).length,
    successfulQuoteSizes: input.attempts
      .filter((attempt) => attempt.ok)
      .map((attempt) => attempt.inputHuman),
    referenceBefore: formatFastAttemptForOutput(
      latestAttempt(input.attempts, "reference_before"),
    ),
    referenceAfter: formatFastAttemptForOutput(
      latestAttempt(input.attempts, "reference_after"),
    ),
    candidateResults: input.attempts
      .filter((attempt) =>
        attempt.label === "lower_candidate" ||
        attempt.label === "upper_candidate" ||
        attempt.label === "optional_midpoint",
      )
      .map((attempt) => ({
        ...formatFastAttemptForOutput(attempt),
        deteriorationPercent: computeDeteriorationPercent(
          attempt.quote,
          referenceAveragePrice,
        ),
      })),
    attempts: input.attempts.map(formatFastAttemptForOutput),
    elapsedMs: input.batchDurationMs,
    deadlineMs: input.configuredTimeoutMs,
    remainingMsAtFailure:
      input.evaluation.recommendationStatus === "available"
        ? null
        : Math.max(0, input.configuredTimeoutMs - input.batchDurationMs),
    timingMarginMs: input.timingMarginMs,
    referenceEqualityDetected:
      input.evaluation.freshness.referenceEqualityDetected,
    referenceFreshnessClassification: input.evaluation.freshness.classification,
  };
}

export function formatFastAttemptForOutput(
  attempt: FastQuoteAttempt | null | undefined,
): Record<string, unknown> | null {
  if (!attempt) return null;
  return {
    label: attempt.label,
    inputHuman: attempt.inputHuman,
    inputRaw: attempt.inputRaw,
    requestStartedAt: attempt.requestStartedAt,
    responseReceivedAt: attempt.responseReceivedAt,
    elapsedMs: attempt.elapsedMs,
    timeoutMs: attempt.timeoutMs,
    ok: attempt.ok,
    rawQuoteSucceeded: attempt.rawQuoteSucceeded,
    timedOut: attempt.timedOut,
    error: attempt.error,
    outputHuman: attempt.quote?.outputHuman ?? null,
    minimumOutputHuman: attempt.quote?.minimumOutputHuman ?? null,
    averagePrice: attempt.quote?.averagePrice ?? null,
    quoteIdentifier: attempt.quote?.quoteIdentifier ?? null,
    quoteTimestamp: attempt.quote?.quoteTimestamp ?? null,
    expiresAt: attempt.quote?.expiresAt ?? null,
    blockNumber: attempt.quote?.blockNumber ?? null,
    responseFingerprint: attempt.quote?.responseFingerprint ?? null,
    cacheHeaders: attempt.quote?.cacheHeaders ?? null,
    endpoint: attempt.quote?.endpoint ?? null,
    routeSignature: attempt.quote?.routeSignature ?? null,
  };
}

export function emptyFastEvaluation(
  recommendationStatus: RecommendationStatus,
  recommendationBasis: RecommendationBasis,
  warnings: string[],
): FastPiteasEvaluation {
  return {
    recommendationStatus,
    recommendationBasis,
    analyticalRecommendationStatus: recommendationStatus === "unavailable"
      ? "unavailable"
      : "requote_required",
    operationalRecommendationStatus: recommendationStatus === "unavailable"
      ? "unavailable"
      : "requote_required",
    analyticalMaximumBelowThresholdHuman: null,
    analyticalLargestConfirmedBelowThresholdHuman: null,
    analyticalFirstConfirmedAboveThresholdHuman: null,
    analyticalThresholdBoundaryBracketed: false,
    operationalMaximumTrancheHuman: null,
    operationalLargestConfirmedBelowThresholdHuman: null,
    operationalFirstConfirmedAboveThresholdHuman: null,
    operationalRecommendedMaximumTrancheHuman: null,
    operationalThresholdBoundaryBracketed: false,
    firstConfirmedAboveThresholdHuman: null,
    thresholdBoundaryBracketed: false,
    lowerDeteriorationPercent: null,
    upperDeteriorationPercent: null,
    referenceDriftPercent: null,
    freshness: emptyFreshnessAnalysis(),
    warnings,
  };
}

export function emptyFreshnessAnalysis(): FastFreshnessAnalysis {
  return {
    referenceEqualityDetected: false,
    possibleCacheDetected: false,
    freshnessConfidence: "low",
    freshnessAcceptable: false,
    classification: "unknown",
    warnings: [],
  };
}

export function analyzeFastReferenceFreshness(
  before: FastQuoteSummary,
  after: FastQuoteSummary,
): FastFreshnessAnalysis {
  const referenceEqualityDetected =
    before.responseFingerprint !== null &&
    after.responseFingerprint !== null &&
    before.responseFingerprint === after.responseFingerprint;
  const independentFreshnessEvidence =
    valuesDiffer(before.quoteIdentifier, after.quoteIdentifier) ||
    valuesDiffer(before.quoteTimestamp, after.quoteTimestamp) ||
    valuesDiffer(before.expiresAt, after.expiresAt) ||
    valuesDiffer(before.blockNumber, after.blockNumber);
  const hasAnyFreshnessMetadata =
    hasFreshnessMetadata(before) || hasFreshnessMetadata(after);
  const cacheHeaderSignal =
    cacheHeadersSuggestCache(before.cacheHeaders) ||
    cacheHeadersSuggestCache(after.cacheHeaders);
  const possibleCacheDetected =
    cacheHeaderSignal ||
    (referenceEqualityDetected && !independentFreshnessEvidence);
  const fingerprintChanged =
    before.responseFingerprint !== null &&
    after.responseFingerprint !== null &&
    before.responseFingerprint !== after.responseFingerprint;
  const freshnessConfidence: FreshnessConfidence = possibleCacheDetected
    ? "low"
    : independentFreshnessEvidence
      ? "high"
      : fingerprintChanged || hasAnyFreshnessMetadata
        ? "medium"
        : "low";
  const classification =
    possibleCacheDetected
      ? "possible_cache"
      : referenceEqualityDetected && independentFreshnessEvidence
        ? "unchanged_market"
        : fingerprintChanged
          ? "freshened"
          : "unknown";
  const warnings: string[] = [];
  if (classification === "unchanged_market") {
    warnings.push(
      "Reference quotes were byte-identical but carried independent freshness metadata; classified as unchanged market, not proof of caching.",
    );
  } else if (classification === "possible_cache") {
    warnings.push(
      "Reference quotes were byte-identical or cache-marked without independent freshness evidence; possible cache or unknown freshness, recommendation withheld.",
    );
  }

  return {
    referenceEqualityDetected,
    possibleCacheDetected,
    freshnessConfidence,
    freshnessAcceptable: freshnessConfidence === "high" || freshnessConfidence === "medium",
    classification,
    warnings,
  };
}

export function computeDeteriorationPercent(
  quote: FastQuoteSummary | null,
  referenceAveragePrice: number | null,
): number | null {
  if (
    quote?.averagePrice === null ||
    quote?.averagePrice === undefined ||
    referenceAveragePrice === null ||
    referenceAveragePrice <= 0
  ) {
    return null;
  }
  return round((quote.averagePrice / referenceAveragePrice - 1) * 100, 6);
}

export function meanReferenceAveragePrice(attempts: FastQuoteAttempt[]): number | null {
  const before = latestAttempt(attempts, "reference_before")?.quote?.averagePrice;
  const after = latestAttempt(attempts, "reference_after")?.quote?.averagePrice;
  if (before === null || before === undefined || after === null || after === undefined) {
    return null;
  }
  return round((before + after) / 2, 12);
}

export function latestAttempt(
  attempts: FastQuoteAttempt[],
  label: FastQuoteAttempt["label"],
): FastQuoteAttempt | null {
  return attempts.filter((attempt) => attempt.label === label).at(-1) ?? null;
}

export function addAttemptFailure(
  failures: PartialFailure[],
  attempt: FastQuoteAttempt,
): void {
  if (attempt.ok) return;
  failures.push({
    source: `piteas.depth.fast.${attempt.label}`,
    error: attempt.error ?? "Piteas fast quote failed",
  });
}

export function compareAttemptHuman(
  a: { attempt: FastQuoteAttempt },
  b: { attempt: FastQuoteAttempt },
): number {
  const left = parseHumanAmountRaw(a.attempt.inputHuman, FAST_PITEAS_EUSDC_DECIMALS);
  const right = parseHumanAmountRaw(b.attempt.inputHuman, FAST_PITEAS_EUSDC_DECIMALS);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function midpointHuman(
  lowerHuman: string | null,
  upperHuman: string | null,
): string | null {
  if (lowerHuman === null || upperHuman === null) return null;
  const lower = parseHumanAmountRaw(lowerHuman, FAST_PITEAS_EUSDC_DECIMALS);
  const upper = parseHumanAmountRaw(upperHuman, FAST_PITEAS_EUSDC_DECIMALS);
  if (upper <= lower) return null;
  return formatRawUnits(
    ((lower + upper) / 2n).toString(),
    FAST_PITEAS_EUSDC_DECIMALS,
  );
}

export function roundHumanDownToIncrement(
  valueHuman: string,
  incrementHuman: string,
  decimals: number,
): string | null {
  const valueRaw = parseHumanAmountRaw(valueHuman, decimals);
  const incrementRaw = parseHumanAmountRaw(incrementHuman, decimals);
  if (incrementRaw <= 0n) return null;
  return formatRawUnits(((valueRaw / incrementRaw) * incrementRaw).toString(), decimals);
}

export function parseHumanAmountRaw(value: string, decimals: number): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Too many decimal places for amount: ${value}`);
  }
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

export function normalizeCacheHeaders(
  value: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!value) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key.toLowerCase()] = String(raw);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function cacheHeadersSuggestCache(headers: Record<string, string> | null): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(([key, value]) => {
    const normalized = value.toLowerCase();
    return (
      (key.includes("cache") && /hit|stale|cached/.test(normalized)) ||
      (key === "age" && numberOrNull(value) !== null && numberOrNull(value)! > 0)
    );
  });
}

export function hasFreshnessMetadata(quote: FastQuoteSummary): boolean {
  // Endpoint is a constant quote URL and does not prove independent refresh.
  return Boolean(
    quote.quoteIdentifier ||
    quote.quoteTimestamp ||
    quote.expiresAt ||
    quote.blockNumber,
  );
}

export function valuesDiffer(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left !== right;
}

export function lastAttemptMs(attempts: FastQuoteAttempt[]): number | null {
  const timestamps = attempts
    .map((attempt) => nowFromIso(attempt.responseReceivedAt))
    .filter((timestamp): timestamp is number => timestamp !== null);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

export function nowFromIso(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nowMs(deps: Pick<PhiatDashboardDeps, "now">): number {
  return deps.now?.().getTime() ?? Date.now();
}
