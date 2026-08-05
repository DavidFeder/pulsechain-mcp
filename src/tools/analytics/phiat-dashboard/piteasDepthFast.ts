import type { PiteasQuoteData, PiteasQuoteResult } from "../../../data/index.js";
import { USDC_FROM_ETH_ADDRESS } from "../../../constants.js";
import type { AppConfig } from "../../../types.js";
import {
  FAST_MIN_CANDIDATE_BUDGET_MS,
  FAST_OPTIONAL_MIDPOINT_MIN_REMAINING_MS,
  FAST_PITEAS_ANALYTICAL_THRESHOLD_PERCENT,
  FAST_PITEAS_DEFAULT_PHIAT_DECIMALS,
  FAST_PITEAS_EUSDC_DECIMALS,
  FAST_PITEAS_LOWER_CANDIDATE_HUMAN,
  FAST_PITEAS_OPERATIONAL_SAFETY_BUFFER_PERCENT,
  FAST_PITEAS_REFERENCE_AMOUNT_HUMAN,
  FAST_PITEAS_UPPER_CANDIDATE_HUMAN,
  FAST_REFERENCE_AFTER_RESERVE_MS,
  PITEAS_DEPTH_CANDIDATE_SIZES,
  PITEAS_DEPTH_MAX_ADAPTIVE_ROUNDS,
} from "./constants.js";
import { asRecord, errorMessage, numberOrNull, stringOrNull } from "./math.js";
import {
  formatRawUnits,
  integerOrNull,
  parseStrictRawBigInt,
  round,
  withTimeout,
} from "./math.js";
import {
  addAttemptFailure,
  emptyFastEvaluation,
  evaluateFastPiteasBatch,
  fastDepthPayload,
  midpointHuman,
  normalizeCacheHeaders,
  nowMs,
  parseHumanAmountRaw,
} from "./piteasDepthEvaluation.js";
import type {
  FastQuoteAttempt,
  FastQuoteSummary,
  PartialFailure,
  PhiatDashboardDeps,
  PiteasDepthOptions,
  PiteasDepthMode,
  RecommendationStatus,
} from "./builder.js";

export async function buildBoundedPiteasDepth(
  config: AppConfig,
  deps: PhiatDashboardDeps,
  tokenAddress: string,
  options: PiteasDepthOptions,
): Promise<Record<string, unknown>> {
  return options.mode === "adaptive"
    ? buildPiteasDepthSummaryAdaptive(config, deps, tokenAddress, options.timeoutMs)
    : buildPiteasDepthSummaryFast(config, deps, tokenAddress, options.timeoutMs);
}

async function buildPiteasDepthSummaryAdaptive(
  config: AppConfig,
  deps: PhiatDashboardDeps,
  tokenAddress: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const fetchedAt = new Date(nowMs(deps)).toISOString();
  try {
    const plan = await withTimeout(
      deps.buildPiteasAccumulationPlan(config, {
        eUsdcAddress: USDC_FROM_ETH_ADDRESS,
        phiatAddress: tokenAddress,
        totalBudgetHuman: "600",
        quoteSizeLadderHuman: ["50", "150", "600"],
        confirmationMode: "adaptive",
        referenceAmountCandidatesHuman: ["5", "10", "20"],
        confirmationCandidateSizesHuman: [...PITEAS_DEPTH_CANDIDATE_SIZES],
        candidateChunkCounts: [1, 4, 6, 8, 12],
        maximumBatchWindowMs: 45_000,
        maximumReferenceDriftPercent: 0.5,
        quoteConcurrency: 2,
        maximumAdaptiveRounds: PITEAS_DEPTH_MAX_ADAPTIVE_ROUNDS,
        maximumBracketWidthHuman: "25",
        allowedSlippagePercent: 0.5,
        priceImpactThresholdsPercent: [3],
        focusedRefresh: false,
        trancheIncrementHuman: "5",
        operationalSafetyBufferPercent: 0.5,
      }),
      timeoutMs,
      "piteas.depth",
    );
    return summarizeAdaptivePiteasDepth(plan, fetchedAt, timeoutMs);
  } catch (err) {
    return unavailablePiteasDepth({
      mode: "adaptive",
      fetchedAt,
      configuredTimeoutMs: timeoutMs,
      error: errorMessage(err),
      status: "unavailable",
    });
  }
}

async function buildPiteasDepthSummaryFast(
  config: AppConfig,
  deps: PhiatDashboardDeps,
  tokenAddress: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const startedMs = nowMs(deps);
  const fetchedAt = new Date(startedMs).toISOString();
  const deadlineMs = startedMs + timeoutMs;
  const warnings: string[] = [];
  const partialFailures: PartialFailure[] = [];
  const attempts: FastQuoteAttempt[] = [];
  const analyticalThresholdPercent = FAST_PITEAS_ANALYTICAL_THRESHOLD_PERCENT;
  const operationalThresholdPercent =
    analyticalThresholdPercent - FAST_PITEAS_OPERATIONAL_SAFETY_BUFFER_PERCENT;

  try {
    const referenceBefore = await requestFastPiteasQuote({
      config,
      deps,
      tokenAddress,
      label: "reference_before",
      inputHuman: FAST_PITEAS_REFERENCE_AMOUNT_HUMAN,
      deadlineMs,
      maxBudgetMs: deadlineMs - nowMs(deps),
    });
    attempts.push(referenceBefore);

    if (!referenceBefore.ok) {
      addAttemptFailure(partialFailures, referenceBefore);
      warnings.push("Fast Piteas depth stopped because reference-before quote failed.");
      return fastDepthPayload({
        fetchedAt,
        configuredTimeoutMs: timeoutMs,
        startedMs,
        attempts,
        evaluation: emptyFastEvaluation("unavailable", "none", warnings),
        partialFailures,
      });
    }

    const beforeCandidatesRemaining = deadlineMs - nowMs(deps);
    if (
      beforeCandidatesRemaining <=
      FAST_REFERENCE_AFTER_RESERVE_MS + FAST_MIN_CANDIDATE_BUDGET_MS
    ) {
      const error =
        "Insufficient deadline remaining to start candidate quotes while reserving reference-after time.";
      partialFailures.push({ source: "piteas.depth.fast.candidates", error });
      warnings.push(error);
      return fastDepthPayload({
        fetchedAt,
        configuredTimeoutMs: timeoutMs,
        startedMs,
        attempts,
        evaluation: emptyFastEvaluation("requote_required", "partial_evidence", warnings),
        partialFailures,
      });
    }

    const candidateBudgetMs =
      beforeCandidatesRemaining - FAST_REFERENCE_AFTER_RESERVE_MS;
    const lowerPromise = requestFastPiteasQuote({
      config,
      deps,
      tokenAddress,
      label: "lower_candidate",
      inputHuman: FAST_PITEAS_LOWER_CANDIDATE_HUMAN,
      deadlineMs,
      maxBudgetMs: candidateBudgetMs,
    });
    const upperPromise = requestFastPiteasQuote({
      config,
      deps,
      tokenAddress,
      label: "upper_candidate",
      inputHuman: FAST_PITEAS_UPPER_CANDIDATE_HUMAN,
      deadlineMs,
      maxBudgetMs: candidateBudgetMs,
    });
    const [lowerCandidate, upperCandidate] = await Promise.all([
      lowerPromise,
      upperPromise,
    ]);
    attempts.push(lowerCandidate, upperCandidate);
    addAttemptFailure(partialFailures, lowerCandidate);
    addAttemptFailure(partialFailures, upperCandidate);

    const beforeReferenceAfterRemaining = deadlineMs - nowMs(deps);
    if (beforeReferenceAfterRemaining <= 0) {
      const error =
        "Fast Piteas depth deadline expired before reference-after quote could start.";
      partialFailures.push({ source: "piteas.depth.fast.reference_after", error });
      warnings.push(error);
      return fastDepthPayload({
        fetchedAt,
        configuredTimeoutMs: timeoutMs,
        startedMs,
        attempts,
        evaluation: emptyFastEvaluation("requote_required", "partial_evidence", warnings),
        partialFailures,
      });
    }

    const referenceAfter = await requestFastPiteasQuote({
      config,
      deps,
      tokenAddress,
      label: "reference_after",
      inputHuman: FAST_PITEAS_REFERENCE_AMOUNT_HUMAN,
      deadlineMs,
      maxBudgetMs: beforeReferenceAfterRemaining,
    });
    attempts.push(referenceAfter);
    addAttemptFailure(partialFailures, referenceAfter);

    let evaluation = evaluateFastPiteasBatch({
      attempts,
      warnings,
      deadlineMs,
      analyticalThresholdPercent,
      operationalThresholdPercent,
    });

    const remainingAfterRequired = deadlineMs - nowMs(deps);
    if (
      evaluation.recommendationStatus === "available" &&
      remainingAfterRequired >= FAST_OPTIONAL_MIDPOINT_MIN_REMAINING_MS
    ) {
      const midpointAmountHuman = midpointHuman(
        evaluation.analyticalMaximumBelowThresholdHuman,
        evaluation.firstConfirmedAboveThresholdHuman,
      );
      if (midpointAmountHuman !== null) {
        const midpointAttempt = await requestFastPiteasQuote({
          config,
          deps,
          tokenAddress,
          label: "optional_midpoint",
          inputHuman: midpointAmountHuman,
          deadlineMs,
          maxBudgetMs: remainingAfterRequired,
        });
        attempts.push(midpointAttempt);
        addAttemptFailure(partialFailures, midpointAttempt);
        if (midpointAttempt.ok) {
          warnings.push(
            "Optional midpoint quote refined the fast dashboard bracket without starting a broader adaptive search.",
          );
          evaluation = evaluateFastPiteasBatch({
            attempts,
            warnings,
            deadlineMs,
            analyticalThresholdPercent,
            operationalThresholdPercent,
          });
        }
      }
    } else if (evaluation.recommendationStatus === "available") {
      evaluation.warnings.push(
        "Optional midpoint refinement skipped because insufficient deadline remained after the required quote sandwich.",
      );
    }

    return fastDepthPayload({
      fetchedAt,
      configuredTimeoutMs: timeoutMs,
      startedMs,
      attempts,
      evaluation,
      partialFailures,
    });
  } catch (err) {
    const usefulQuoteCount = attempts.filter((attempt) => attempt.ok).length;
    const status: RecommendationStatus =
      usefulQuoteCount > 0 ? "requote_required" : "unavailable";
    return fastDepthPayload({
      fetchedAt,
      configuredTimeoutMs: timeoutMs,
      startedMs,
      attempts,
      evaluation: emptyFastEvaluation(status, usefulQuoteCount > 0 ? "partial_evidence" : "none", [
        `Fast Piteas depth failed: ${errorMessage(err)}`,
      ]),
      partialFailures: [
        ...partialFailures,
        { source: "piteas.depth.fast", error: errorMessage(err) },
      ],
    });
  }
}

function summarizeAdaptivePiteasDepth(
  plan: Record<string, unknown>,
  fetchedAt: string,
  configuredTimeoutMs: number,
): Record<string, unknown> {
  const plans = asRecord(plan.plans);
  const coherence = asRecord(plan.coherence);
  const batch = asRecord(plan.batchConfirmation);
  const adaptive = asRecord(plan.adaptiveThresholdSearch);
  const operational = asRecord(plan.operationalTranchePlan);
  const dataQuality = asRecord(plan.dataQuality);
  const firstAbove = asRecord(adaptive.finalFirstAboveThreshold);
  const batchDurationMs = numberOrNull(batch.batchDurationMs);
  const timingMarginMs =
    batchDurationMs !== null ? configuredTimeoutMs - batchDurationMs : null;
  return {
    mode: "adaptive",
    recommendationStatus: stringOrNull(plans.recommendationStatus) ??
      stringOrNull(coherence.recommendationStatus) ??
      "unavailable",
    recommendationBasis: stringOrNull(plans.recommendationBasis) ??
      stringOrNull(coherence.recommendationBasis) ??
      "none",
    analyticalRecommendationStatus: null,
    operationalRecommendationStatus: null,
    selectedReferenceAmountHuman:
      stringOrNull(batch.selectedReferenceAmountHuman) ??
      stringOrNull(batch.referenceAmountHuman),
    lowerCandidateHuman: null,
    upperCandidateHuman: null,
    analyticalMaximumBelowThresholdHuman:
      stringOrNull(operational.analyticalMaximumBelowThresholdHuman) ??
      stringOrNull(plans.analyticalMaximumBelowThresholdHuman),
    analyticalLargestConfirmedBelowThresholdHuman: null,
    analyticalFirstConfirmedAboveThresholdHuman: null,
    analyticalThresholdBoundaryBracketed: null,
    operationalMaximumTrancheHuman:
      stringOrNull(operational.operationalMaximumTrancheHuman) ??
      stringOrNull(plans.operationalMaximumTrancheHuman),
    operationalLargestConfirmedBelowThresholdHuman: null,
    operationalFirstConfirmedAboveThresholdHuman: null,
    operationalRecommendedMaximumTrancheHuman:
      stringOrNull(operational.operationalMaximumTrancheHuman) ??
      stringOrNull(plans.operationalMaximumTrancheHuman),
    operationalThresholdBoundaryBracketed: null,
    firstConfirmedAboveThresholdHuman:
      stringOrNull(firstAbove.inputHuman) ??
      stringOrNull(asRecord(plans.firstObservedAboveThreshold).inputHuman),
    thresholdBoundaryBracketed:
      Boolean(adaptive.thresholdBoundaryBracketed) ||
      Boolean(plans.thresholdBoundaryBracketed),
    lowerDeteriorationPercent: null,
    upperDeteriorationPercent: null,
    analyticalThresholdPercent: FAST_PITEAS_ANALYTICAL_THRESHOLD_PERCENT,
    operationalThresholdPercent:
      FAST_PITEAS_ANALYTICAL_THRESHOLD_PERCENT -
      FAST_PITEAS_OPERATIONAL_SAFETY_BUFFER_PERCENT,
    referenceDriftPercent: stringOrNull(batch.referenceDriftPercent),
    freshnessConfidence: freshnessConfidenceOrLow(batch.freshnessConfidence),
    possibleCacheDetected: Boolean(batch.possibleCacheDetected),
    batchDurationMs,
    configuredTimeoutMs,
    timingMarginMs,
    piteasReliability: asRecord(plan.piteasReliability),
    guardrails: asRecord(plan.guardrails),
    partialFailures: piteasFailuresForDashboard(dataQuality.partialFailures),
    warnings: Array.isArray(dataQuality.warnings) ? dataQuality.warnings : [],
    fetchedAt,
  };
}

function unavailablePiteasDepth(input: {
  mode: PiteasDepthMode;
  fetchedAt: string;
  configuredTimeoutMs: number;
  error: string;
  status: RecommendationStatus;
}): Record<string, unknown> {
  return {
    mode: input.mode,
    recommendationStatus: input.status,
    recommendationBasis: "none",
    analyticalRecommendationStatus: "unavailable",
    operationalRecommendationStatus: "unavailable",
    selectedReferenceAmountHuman: null,
    lowerCandidateHuman: input.mode === "fast" ? FAST_PITEAS_LOWER_CANDIDATE_HUMAN : null,
    upperCandidateHuman: input.mode === "fast" ? FAST_PITEAS_UPPER_CANDIDATE_HUMAN : null,
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
    analyticalThresholdPercent: FAST_PITEAS_ANALYTICAL_THRESHOLD_PERCENT,
    operationalThresholdPercent:
      FAST_PITEAS_ANALYTICAL_THRESHOLD_PERCENT -
      FAST_PITEAS_OPERATIONAL_SAFETY_BUFFER_PERCENT,
    referenceDriftPercent: null,
    freshnessConfidence: "low",
    possibleCacheDetected: false,
    batchDurationMs: null,
    configuredTimeoutMs: input.configuredTimeoutMs,
    timingMarginMs: null,
    piteasReliability: {
      requestsAttempted: 0,
      requestsSucceeded: 0,
      requestsFailed: 0,
      timeoutCount: 0,
      successfulQuoteSizes: [],
      attempts: [],
      elapsedMs: 0,
      deadlineMs: input.configuredTimeoutMs,
      remainingMsAtFailure: input.configuredTimeoutMs,
    },
    guardrails: null,
    partialFailures: [{ source: "piteas.depth", error: input.error }],
    warnings: ["Piteas depth failed; dashboard returned the remaining read-only data."],
    fetchedAt: input.fetchedAt,
  };
}

function piteasFailuresForDashboard(raw: unknown): PartialFailure[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((failure) => {
    const rec = asRecord(failure);
    return {
      source: stringOrNull(rec.source) ?? "piteas.quote",
      error:
        stringOrNull(rec.error) ??
        stringOrNull(rec.reason) ??
        "Piteas quote failure",
    };
  });
}

function freshnessConfidenceOrLow(value: unknown): "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : "low";
}

async function requestFastPiteasQuote(input: {
  config: AppConfig;
  deps: PhiatDashboardDeps;
  tokenAddress: string;
  label: FastQuoteAttempt["label"];
  inputHuman: string;
  deadlineMs: number;
  maxBudgetMs: number;
}): Promise<FastQuoteAttempt> {
  const inputRaw = parseHumanAmountRaw(
    input.inputHuman,
    FAST_PITEAS_EUSDC_DECIMALS,
  ).toString();
  const startedMs = nowMs(input.deps);
  const remainingMs = input.deadlineMs - startedMs;
  const requestTimeoutMs = Math.max(
    0,
    Math.min(
      input.config.httpTimeoutMs ?? 30_000,
      input.maxBudgetMs,
      remainingMs,
    ),
  );

  if (requestTimeoutMs <= 0) {
    return {
      label: input.label,
      inputHuman: input.inputHuman,
      inputRaw,
      requestStartedAt: null,
      responseReceivedAt: null,
      elapsedMs: null,
      timeoutMs: 0,
      ok: false,
      rawQuoteSucceeded: false,
      timedOut: true,
      error: "Deadline expired before quote request could start.",
      quote: null,
    };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<PiteasQuoteResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          source: "piteas",
          reason: `Piteas ${input.label} request timed out after ${requestTimeoutMs}ms`,
          advisory: true,
        }),
      requestTimeoutMs,
    );
  });

  const result = await Promise.race([
    input.deps.getPiteasQuote(
      input.config,
      {
        tokenIn: USDC_FROM_ETH_ADDRESS,
        tokenOut: input.tokenAddress,
        amount: inputRaw,
        allowedSlippage: 0.5,
      },
      { timeoutMs: requestTimeoutMs },
    ),
    timeoutResult,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });

  const receivedMs = nowMs(input.deps);
  const summary = result.ok
    ? summarizeFastQuote(result.data, input.inputHuman, inputRaw)
    : null;
  const validationErrors = summary?.validationErrors ?? [];
  const ok = result.ok && validationErrors.length === 0;
  const error = result.ok
    ? validationErrors.length > 0
      ? validationErrors.join("; ")
      : null
    : result.reason;

  return {
    label: input.label,
    inputHuman: input.inputHuman,
    inputRaw,
    requestStartedAt: new Date(startedMs).toISOString(),
    responseReceivedAt: new Date(receivedMs).toISOString(),
    elapsedMs: Math.max(0, receivedMs - startedMs),
    timeoutMs: requestTimeoutMs,
    ok,
    rawQuoteSucceeded: result.ok,
    timedOut: Boolean(error?.toLowerCase().includes("timed out")),
    error,
    quote: summary,
  };
}

function summarizeFastQuote(
  data: PiteasQuoteData,
  inputHuman: string,
  inputRaw: string,
): FastQuoteSummary {
  const outputRaw = stringOrNull(data.amountOut);
  const minimumOutputRaw = stringOrNull(data.amountOutMin);
  const outputDecimals =
    integerOrNull(data.destToken?.decimals) ?? FAST_PITEAS_DEFAULT_PHIAT_DECIMALS;
  const outputHuman = formatRawUnits(outputRaw, outputDecimals);
  const minimumOutputHuman = formatRawUnits(minimumOutputRaw, outputDecimals);
  const inputAmount = numberOrNull(formatRawUnits(inputRaw, FAST_PITEAS_EUSDC_DECIMALS));
  const outputAmount = numberOrNull(outputHuman);
  const averagePrice =
    inputAmount !== null && outputAmount !== null && outputAmount > 0
      ? round(inputAmount / outputAmount, 12)
      : null;
  const output = parseStrictRawBigInt(outputRaw);
  const minimum = parseStrictRawBigInt(minimumOutputRaw);
  const validationErrors: string[] = [];

  if (output === null || output <= 0n) {
    validationErrors.push("amountOut missing or non-positive");
  }
  if (minimum === null || minimum <= 0n) {
    validationErrors.push("amountOutMin missing or non-positive");
  }
  if (averagePrice === null || averagePrice <= 0) {
    validationErrors.push("average price unavailable or non-positive");
  }

  return {
    inputHuman,
    inputRaw,
    outputRaw,
    outputHuman,
    minimumOutputRaw,
    minimumOutputHuman,
    averagePrice,
    quoteIdentifier: stringOrNull(data.quoteIdentifier),
    quoteTimestamp: stringOrNull(data.quoteTimestamp),
    expiresAt: stringOrNull(data.expiresAt),
    blockNumber: stringOrNull(data.blockNumber),
    responseFingerprint: stringOrNull(data.responseFingerprint),
    cacheHeaders: normalizeCacheHeaders(data.cacheHeaders),
    endpoint: stringOrNull(data.endpoint),
    routeSignature: stringOrNull(data.route?.signature),
    validationErrors,
  };
}
