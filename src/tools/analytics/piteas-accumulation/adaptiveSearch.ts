import type { AppConfig } from "../../../types.js";
import { MAX_FOCUSED_POINTS } from "./constants.js";
import { batchThresholdPlans, buildBatchConfirmation } from "./batchSandwich.js";
import { formatRawAmount, isSuccessfulPoint } from "./decimalMath.js";
import { limitLadder, uniqueSorted } from "./inputNormalization.js";
import { quoteFailure } from "./quoteNormalization.js";
import type {
  AdaptiveThresholdRound,
  AdaptiveThresholdSearch,
  BatchConfirmation,
  BestRouteEnvelopeAnalysis,
  PiteasAccumulationPlanDeps,
  QuoteFailure,
  QuotePoint,
  QuoteScheduler,
  SuccessfulPoint,
} from "./types.js";

export async function buildAdaptiveThresholdSearch(input: {
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
  initialCandidateSizesRaw: bigint[];
  discoveryEnvelope: BestRouteEnvelopeAnalysis;
  maximumBatchWindowMs: number;
  maximumReferenceDriftBps: bigint;
  quoteConcurrency: number;
  maximumAdaptiveRounds: number;
  maximumBracketWidthRaw: bigint | null;
  allowLowConfidenceFreshness: boolean;
  totalBudgetRaw: bigint;

  includeGasEstimate?: boolean;
}): Promise<AdaptiveThresholdSearch> {
  const initial = initialAdaptiveBracket(input.discoveryEnvelope);
  if (!initial) {
    return {
      ...adaptiveThresholdSearchNotRun(),
      terminationReason: "no_initial_bracket",
    };
  }
  if (input.maximumAdaptiveRounds <= 0) {
    return {
      ...adaptiveThresholdSearchNotRun(),
      initialLowerHuman: formatRawAmount(initial.lowerRaw, input.eUsdcDecimals),
      initialUpperHuman: formatRawAmount(initial.upperRaw, input.eUsdcDecimals),
      terminationReason: "max_rounds_reached",
    };
  }

  let lowerRaw = initial.lowerRaw;
  let upperRaw = initial.upperRaw;
  const rounds: AdaptiveThresholdRound[] = [];
  let terminationReason: AdaptiveThresholdSearch["terminationReason"] =
    "max_rounds_reached";
  let finalLargestBelowThreshold: Record<string, unknown> | null = null;
  let finalFirstAboveThreshold: Record<string, unknown> | null = null;
  let thresholdBoundaryBracketed = false;
  let recommendedMaximumTranche: Record<string, unknown> | null = null;

  for (let round = 1; round <= input.maximumAdaptiveRounds; round += 1) {
    const candidateSizesRaw = adaptiveRoundCandidateSizes({
      round,
      lowerRaw,
      upperRaw,
      explicitCandidatesRaw: input.initialCandidateSizesRaw,
      totalBudgetRaw: input.totalBudgetRaw,
    });
    if (candidateSizesRaw.length === 0) {
      terminationReason = "no_candidate_sizes";
      break;
    }

    const batch = await buildBatchConfirmation({
      config: input.config,
      deps: input.deps,
      scheduler: input.scheduler,
      eUsdcAddress: input.eUsdcAddress,
      phiatAddress: input.phiatAddress,
      account: input.account,
      allowedSlippagePercent: input.allowedSlippagePercent,
      eUsdcDecimals: input.eUsdcDecimals,
      phiatDecimals: input.phiatDecimals,
      thresholds: input.thresholds,
      maxGasCostBps: input.maxGasCostBps,
      primaryThresholdBps: input.primaryThresholdBps,
      referenceAmountsRaw: input.referenceAmountsRaw,
      candidateSizesRaw,
      maximumBatchWindowMs: input.maximumBatchWindowMs,
      maximumReferenceDriftBps: input.maximumReferenceDriftBps,
      quoteConcurrency: input.quoteConcurrency,
      allowLowConfidenceFreshness: input.allowLowConfidenceFreshness,
      includeGasEstimate: input.includeGasEstimate,
    });
    const threshold = batchThresholdPlans(batch);
    const bracketWidthRaw =
      threshold.largestObservedBelowThreshold && threshold.firstObservedAboveThreshold
        ? BigInt(threshold.firstObservedAboveThreshold.inputRaw as string) -
          BigInt(threshold.largestObservedBelowThreshold.inputRaw as string)
        : upperRaw - lowerRaw;
    rounds.push({
      round,
      candidateSizesHuman: candidateSizesRaw.map((size) =>
        formatRawAmount(size, input.eUsdcDecimals),
      ),
      batchConfirmation: batch,
      largestObservedBelowThreshold: threshold.largestObservedBelowThreshold,
      firstObservedAboveThreshold: threshold.firstObservedAboveThreshold,
      thresholdBoundaryBracketed: threshold.thresholdBoundaryBracketed,
      bracketWidthHuman:
        bracketWidthRaw > 0n
          ? formatRawAmount(bracketWidthRaw, input.eUsdcDecimals)
          : null,
    });

    if (!batch.temporallyUsable) {
      // Keep last usable-round bounds and recommendation. Overwriting finals with an
      // unusable batch (often partial/null) while leaving thresholdBoundaryBracketed
      // and recommendedMaximumTranche from a prior success produces a stale
      // "available" recommendation tied to failed-round evidence.
      terminationReason = "batch_unusable";
      break;
    }

    if (threshold.largestObservedBelowThreshold) {
      const candidateLowerRaw = BigInt(
        threshold.largestObservedBelowThreshold.inputRaw as string,
      );
      if (candidateLowerRaw > lowerRaw) lowerRaw = candidateLowerRaw;
    }
    if (threshold.firstObservedAboveThreshold) {
      const candidateUpperRaw = BigInt(
        threshold.firstObservedAboveThreshold.inputRaw as string,
      );
      if (candidateUpperRaw < upperRaw) upperRaw = candidateUpperRaw;
    }

    finalLargestBelowThreshold = threshold.largestObservedBelowThreshold;
    finalFirstAboveThreshold = threshold.firstObservedAboveThreshold;
    thresholdBoundaryBracketed = threshold.thresholdBoundaryBracketed;
    recommendedMaximumTranche = threshold.recommendedMaximumTranche;

    if (
      threshold.thresholdBoundaryBracketed &&
      input.maximumBracketWidthRaw !== null &&
      upperRaw - lowerRaw <= input.maximumBracketWidthRaw
    ) {
      terminationReason = "bracket_width_reached";
      break;
    }
    if (round === input.maximumAdaptiveRounds) {
      terminationReason = "max_rounds_reached";
    }
  }

  return {
    initialLowerHuman: formatRawAmount(initial.lowerRaw, input.eUsdcDecimals),
    initialUpperHuman: formatRawAmount(initial.upperRaw, input.eUsdcDecimals),
    rounds,
    finalLargestBelowThreshold,
    finalFirstAboveThreshold,
    finalBracketWidthHuman:
      lowerRaw < upperRaw ? formatRawAmount(upperRaw - lowerRaw, input.eUsdcDecimals) : null,
    thresholdBoundaryBracketed,
    recommendedMaximumTranche:
      thresholdBoundaryBracketed ? recommendedMaximumTranche : null,
    terminationReason,
  };
}

export function adaptiveThresholdSearchNotRun(): AdaptiveThresholdSearch {
  return {
    initialLowerHuman: null,
    initialUpperHuman: null,
    rounds: [],
    finalLargestBelowThreshold: null,
    finalFirstAboveThreshold: null,
    finalBracketWidthHuman: null,
    thresholdBoundaryBracketed: false,
    recommendedMaximumTranche: null,
    terminationReason: "not_run",
  };
}

function initialAdaptiveBracket(
  envelope: BestRouteEnvelopeAnalysis,
): { lowerRaw: bigint; upperRaw: bigint } | null {
  const lowerRaw = rawFromPlan(envelope.bestRouteLargestObservedBelowThreshold);
  const upperRaw = rawFromPlan(envelope.bestRouteFirstObservedAboveThreshold);
  if (lowerRaw === null || upperRaw === null || upperRaw <= lowerRaw) return null;
  return { lowerRaw, upperRaw };
}

function adaptiveRoundCandidateSizes(input: {
  round: number;
  lowerRaw: bigint;
  upperRaw: bigint;
  explicitCandidatesRaw: bigint[];
  totalBudgetRaw: bigint;
}): bigint[] {
  const inside = (value: bigint) =>
    value > input.lowerRaw && value < input.upperRaw && value <= input.totalBudgetRaw;
  const explicit =
    input.round === 1
      ? input.explicitCandidatesRaw.filter(inside)
      : [];
  if (explicit.length > 0) {
    return limitLadder(uniqueSorted(explicit), input.totalBudgetRaw, MAX_FOCUSED_POINTS);
  }
  const width = input.upperRaw - input.lowerRaw;
  if (width <= 1n) return [];
  const generated = [
    input.lowerRaw + width / 3n,
    input.lowerRaw + width / 2n,
    input.lowerRaw + (width * 2n) / 3n,
  ].filter(inside);
  return limitLadder(uniqueSorted(generated), input.totalBudgetRaw, MAX_FOCUSED_POINTS);
}

export function rawFromPlan(plan: Record<string, unknown> | null): bigint | null {
  const raw = plan?.inputRaw;
  if (typeof raw !== "string") return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

export function latestAdaptiveBatch(
  adaptive: AdaptiveThresholdSearch,
): BatchConfirmation | null {
  for (let index = adaptive.rounds.length - 1; index >= 0; index -= 1) {
    const batch = adaptive.rounds[index]?.batchConfirmation;
    if (batch?.temporallyUsable) return batch;
  }
  // Fall back to the most recent round for diagnostics when none were usable.
  return adaptive.rounds.at(-1)?.batchConfirmation ?? null;
}

export function successfulBatchCandidatePoints(
  batch: BatchConfirmation | null | undefined,
): SuccessfulPoint[] {
  return (
    batch?.candidateResults
      .filter((candidate) => candidate.candidateFailureReason === null)
      .map((candidate) => candidate.quote)
      .filter(isSuccessfulPoint)
      .sort((a, b) => {
        const ar = BigInt(a.inputRaw);
        const br = BigInt(b.inputRaw);
        return ar < br ? -1 : ar > br ? 1 : 0;
      }) ?? []
  );
}

export function batchPartialFailures(batch: BatchConfirmation): QuoteFailure[] {
  const points = [
    batch.referenceBefore,
    batch.referenceAfter,
    ...batch.candidateResults.map((candidate) => candidate.quote),
  ].filter((point): point is QuotePoint => point !== null);
  return points
    .filter((point) => !point.quoteReady)
    .map((point) =>
      quoteFailure({
        purpose: point.purpose,
        inputHuman: point.inputHuman,
        inputRaw: point.inputRaw,
        reason: point.quoteError ?? "quote unavailable",
        requestStartedAt: point.requestStartedAt,
        responseReceivedAt: point.responseReceivedAt,
        endpoint: point.endpoint,
        retryCount: point.retryCount,
        attempts: point.attempts,
      }),
    );
}

export function adaptivePartialFailures(adaptive: AdaptiveThresholdSearch): QuoteFailure[] {
  return adaptive.rounds.flatMap((round) =>
    batchPartialFailures(round.batchConfirmation),
  );
}
