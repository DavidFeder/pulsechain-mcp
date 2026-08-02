import type { AppConfig } from "../../../types.js";
import { MAX_LADDER_POINTS, PRICE_SCALE_DECIMALS } from "./constants.js";
import { decorateCurve } from "./coherence.js";
import {
  durationMs,
  formatBpsAsPercent,
  formatFixed,
  formatRawAmount,
  isSuccessfulPoint,
  nowIso,
  parseHumanAmount,
  percentStringToBps,
} from "./decimalMath.js";
import { limitLadder, uniqueSorted } from "./inputNormalization.js";
import { collectQuoteSet } from "./quoteNormalization.js";
import type {
  PairedReferenceAnalysis,
  PairedReferencePair,
  PiteasAccumulationPlanDeps,
  PiteasAccumulationPlanInput,
  QuoteFailure,
  QuotePoint,
  QuoteScheduler,
  SnapshotLimits,
  SuccessfulPoint,
} from "./types.js";

export async function buildPairedReferenceAnalysis(input: {
  config: AppConfig;
  deps: PiteasAccumulationPlanDeps;
  scheduler: QuoteScheduler;
  request: PiteasAccumulationPlanInput;
  eUsdcAddress: string;
  phiatAddress: string;
  account?: string;
  totalBudgetRaw: bigint;
  allowedSlippagePercent: number;
  eUsdcDecimals: number;
  phiatDecimals: number;
  thresholds: number[];
  maxGasCostBps: bigint;
  snapshotLimits: SnapshotLimits;
  primaryThresholdBps: bigint;
}): Promise<PairedReferenceAnalysis> {
  if (
    !input.request.pairedReferenceAmountHuman ||
    !input.request.pairedCandidateSizesHuman?.length
  ) {
    return pairedReferenceNotRun(input.snapshotLimits.maximumPairWindowMs);
  }

  const referenceRaw = parseHumanAmount(
    input.request.pairedReferenceAmountHuman,
    input.eUsdcDecimals,
    "pairedReferenceAmountHuman",
  );
  if (referenceRaw <= 0n) {
    throw new Error("pairedReferenceAmountHuman must be positive");
  }
  const candidateSizesRaw = limitLadder(
    uniqueSorted(
      input.request.pairedCandidateSizesHuman
        .map((human) =>
          parseHumanAmount(human, input.eUsdcDecimals, "pairedCandidateSizesHuman"),
        )
        .filter((raw) => raw > 0n && raw <= input.totalBudgetRaw),
    ),
    input.totalBudgetRaw,
    MAX_LADDER_POINTS,
  );
  if (candidateSizesRaw.length === 0) {
    return {
      ...pairedReferenceNotRun(input.snapshotLimits.maximumPairWindowMs),
      status: "failed",
      referenceInputHuman: formatRawAmount(referenceRaw, input.eUsdcDecimals),
      warnings: ["No valid paired candidate sizes were provided."],
    };
  }

  const pairs: PairedReferencePair[] = [];
  const partialFailures: QuoteFailure[] = [];
  for (const candidateRaw of candidateSizesRaw) {
    const pairStartedAt = nowIso(input.deps);
    const refBefore = await collectQuoteSet({
      config: input.config,
      deps: input.deps,
      scheduler: input.scheduler,
      purpose: "paired_reference",
      sizesRaw: [referenceRaw],
      eUsdcAddress: input.eUsdcAddress,
      phiatAddress: input.phiatAddress,
      account: input.account,
      allowedSlippagePercent: input.allowedSlippagePercent,
      eUsdcDecimals: input.eUsdcDecimals,
      phiatDecimals: input.phiatDecimals,
      thresholds: input.thresholds,
      maxGasCostBps: input.maxGasCostBps,
      strictDurationMs: input.snapshotLimits.maximumPairWindowMs,
    });
    const candidateBefore = await collectQuoteSet({
      config: input.config,
      deps: input.deps,
      scheduler: input.scheduler,
      purpose: "paired_candidate",
      sizesRaw: [candidateRaw],
      eUsdcAddress: input.eUsdcAddress,
      phiatAddress: input.phiatAddress,
      account: input.account,
      allowedSlippagePercent: input.allowedSlippagePercent,
      eUsdcDecimals: input.eUsdcDecimals,
      phiatDecimals: input.phiatDecimals,
      thresholds: input.thresholds,
      maxGasCostBps: input.maxGasCostBps,
      strictDurationMs: input.snapshotLimits.maximumPairWindowMs,
    });
    const refAfter = await collectQuoteSet({
      config: input.config,
      deps: input.deps,
      scheduler: input.scheduler,
      purpose: "paired_reference",
      sizesRaw: [referenceRaw],
      eUsdcAddress: input.eUsdcAddress,
      phiatAddress: input.phiatAddress,
      account: input.account,
      allowedSlippagePercent: input.allowedSlippagePercent,
      eUsdcDecimals: input.eUsdcDecimals,
      phiatDecimals: input.phiatDecimals,
      thresholds: input.thresholds,
      maxGasCostBps: input.maxGasCostBps,
      strictDurationMs: input.snapshotLimits.maximumPairWindowMs,
    });
    const candidateAfter = await collectQuoteSet({
      config: input.config,
      deps: input.deps,
      scheduler: input.scheduler,
      purpose: "paired_candidate",
      sizesRaw: [candidateRaw],
      eUsdcAddress: input.eUsdcAddress,
      phiatAddress: input.phiatAddress,
      account: input.account,
      allowedSlippagePercent: input.allowedSlippagePercent,
      eUsdcDecimals: input.eUsdcDecimals,
      phiatDecimals: input.phiatDecimals,
      thresholds: input.thresholds,
      maxGasCostBps: input.maxGasCostBps,
      strictDurationMs: input.snapshotLimits.maximumPairWindowMs,
    });
    const pairCompletedAt = nowIso(input.deps);
    const allPairPoints = [
      ...refBefore.points,
      ...candidateBefore.points,
      ...refAfter.points,
      ...candidateAfter.points,
    ];
    decorateCurve(allPairPoints, {
      eUsdcDecimals: input.eUsdcDecimals,
      phiatDecimals: input.phiatDecimals,
      thresholds: input.thresholds,
    });
    partialFailures.push(
      ...refBefore.failures,
      ...candidateBefore.failures,
      ...refAfter.failures,
      ...candidateAfter.failures,
    );
    pairs.push(
      buildPairedReferencePair({
        referenceRaw,
        candidateRaw,
        referenceQuotes: [...refBefore.points, ...refAfter.points],
        candidateQuotes: [...candidateBefore.points, ...candidateAfter.points],
        pairStartedAt,
        pairCompletedAt,
        maximumPairWindowMs: input.snapshotLimits.maximumPairWindowMs,
        eUsdcDecimals: input.eUsdcDecimals,
      }),
    );
  }

  const threshold = buildPairedThresholdSemantics(pairs, input.primaryThresholdBps);
  const usablePairCount = pairs.filter((pair) => pair.pairUsable).length;
  const status =
    usablePairCount === 0
      ? "failed"
      : usablePairCount === pairs.length
        ? "complete"
        : "incomplete";
  const warnings = buildPairedReferenceWarnings(pairs);
  return {
    status,
    envelopeCoherence: usablePairCount > 0 ? "usable_paired_quotes" : "insufficient_metadata",
    referenceInputHuman: formatRawAmount(referenceRaw, input.eUsdcDecimals),
    candidateSizesHuman: candidateSizesRaw.map((raw) =>
      formatRawAmount(raw, input.eUsdcDecimals),
    ),
    maximumPairWindowMs: input.snapshotLimits.maximumPairWindowMs,
    usablePairCount,
    pairs,
    pairedLargestObservedBelowThreshold: threshold.largestObservedBelowThreshold
      ? pairPlan(threshold.largestObservedBelowThreshold)
      : null,
    pairedFirstObservedAboveThreshold: threshold.firstObservedAboveThreshold
      ? pairPlan(threshold.firstObservedAboveThreshold)
      : null,
    pairedThresholdBoundaryBracketed: threshold.thresholdBoundaryBracketed,
    pairedRecommendedMaximumTranche:
      threshold.thresholdBoundaryBracketed && threshold.largestObservedBelowThreshold
        ? pairPlan(threshold.largestObservedBelowThreshold)
        : null,
    partialFailures,
    warnings,
  };
}

function pairedReferenceNotRun(maximumPairWindowMs: number): PairedReferenceAnalysis {
  return {
    status: "not_run",
    envelopeCoherence: "insufficient_metadata",
    referenceInputHuman: null,
    candidateSizesHuman: [],
    maximumPairWindowMs,
    usablePairCount: 0,
    pairs: [],
    pairedLargestObservedBelowThreshold: null,
    pairedFirstObservedAboveThreshold: null,
    pairedThresholdBoundaryBracketed: false,
    pairedRecommendedMaximumTranche: null,
    partialFailures: [],
    warnings: [],
  };
}

function buildPairedReferencePair(input: {
  referenceRaw: bigint;
  candidateRaw: bigint;
  referenceQuotes: QuotePoint[];
  candidateQuotes: QuotePoint[];
  pairStartedAt: string;
  pairCompletedAt: string;
  maximumPairWindowMs: number;
  eUsdcDecimals: number;
}): PairedReferencePair {
  const referenceSuccessful = input.referenceQuotes.filter(isSuccessfulPoint);
  const candidateSuccessful = input.candidateQuotes.filter(isSuccessfulPoint);
  const referenceAverageRaw = meanAveragePriceRaw(referenceSuccessful);
  const candidateAverageRaw = meanAveragePriceRaw(candidateSuccessful);
  const pairedBps =
    referenceAverageRaw !== null &&
    candidateAverageRaw !== null &&
    referenceAverageRaw > 0n
      ? ((candidateAverageRaw - referenceAverageRaw) * 10000n) / referenceAverageRaw
      : null;
  const pairDurationMs = durationMs(input.pairStartedAt, input.pairCompletedAt);
  const pairFailureReason = pairedFailureReason({
    referenceQuotes: input.referenceQuotes,
    candidateQuotes: input.candidateQuotes,
    referenceAverageRaw,
    candidateAverageRaw,
    pairDurationMs,
    maximumPairWindowMs: input.maximumPairWindowMs,
  });
  const referenceRouteSignature =
    referenceSuccessful[0]?.structuralRouteSignature ?? null;
  const candidateRouteSignature =
    candidateSuccessful[0]?.structuralRouteSignature ?? null;
  return {
    referenceInputRaw: input.referenceRaw.toString(),
    referenceInputHuman: formatRawAmount(input.referenceRaw, input.eUsdcDecimals),
    candidateInputRaw: input.candidateRaw.toString(),
    candidateInputHuman: formatRawAmount(input.candidateRaw, input.eUsdcDecimals),
    referenceAveragePrice:
      referenceAverageRaw !== null ? formatFixed(referenceAverageRaw, PRICE_SCALE_DECIMALS) : null,
    candidateAveragePrice:
      candidateAverageRaw !== null ? formatFixed(candidateAverageRaw, PRICE_SCALE_DECIMALS) : null,
    pairedDeteriorationPercent:
      pairedBps !== null ? formatBpsAsPercent(pairedBps) : null,
    pairedReferenceDeteriorationPercent:
      pairedBps !== null ? formatBpsAsPercent(pairedBps) : null,
    pairStartedAt: input.pairStartedAt,
    pairCompletedAt: input.pairCompletedAt,
    pairDurationMs,
    referenceRouteSignature,
    candidateRouteSignature,
    routeChangedWithinPair: routeChangedWithinPair([
      ...referenceSuccessful,
      ...candidateSuccessful,
    ]),
    pairUsable: pairFailureReason === null,
    pairFailureReason,
    referencePriceDriftPercent: driftPercent(referenceSuccessful),
    candidatePriceDriftPercent: driftPercent(candidateSuccessful),
    referenceQuotes: input.referenceQuotes,
    candidateQuotes: input.candidateQuotes,
  };
}

function pairedFailureReason(input: {
  referenceQuotes: QuotePoint[];
  candidateQuotes: QuotePoint[];
  referenceAverageRaw: bigint | null;
  candidateAverageRaw: bigint | null;
  pairDurationMs: number;
  maximumPairWindowMs: number;
}): string | null {
  if (!input.referenceQuotes.every(isSuccessfulPoint)) return "reference_quote_failed";
  if (!input.candidateQuotes.every(isSuccessfulPoint)) return "candidate_quote_failed";
  if (input.pairDurationMs > input.maximumPairWindowMs) return "pair_duration_exceeded";
  if (input.referenceAverageRaw === null || input.candidateAverageRaw === null) {
    return "invalid_average_price";
  }
  if (
    [...input.referenceQuotes, ...input.candidateQuotes].some(
      (point) => point.outputRaw === null || point.outputRaw === "0",
    )
  ) {
    return "missing_or_zero_output";
  }
  return null;
}

export function meanAveragePriceRaw(points: SuccessfulPoint[]): bigint | null {
  const values = points
    .map((point) =>
      point.averagePrice
        ? parseHumanAmount(point.averagePrice, PRICE_SCALE_DECIMALS, "averagePrice")
        : null,
    )
    .filter((value): value is bigint => value !== null);
  if (values.length !== points.length || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0n) / BigInt(values.length);
}

function driftPercent(points: SuccessfulPoint[]): string | null {
  if (points.length < 2) return null;
  const first = points[0]?.averagePrice
    ? parseHumanAmount(points[0].averagePrice, PRICE_SCALE_DECIMALS, "averagePrice")
    : null;
  const last = points.at(-1)?.averagePrice
    ? parseHumanAmount(points.at(-1)!.averagePrice!, PRICE_SCALE_DECIMALS, "averagePrice")
    : null;
  if (first === null || last === null || first === 0n) return null;
  return formatBpsAsPercent(((last - first) * 10000n) / first);
}

function routeChangedWithinPair(points: SuccessfulPoint[]): boolean {
  if (points.length < 2) return false;
  const [first] = points;
  return points
    .slice(1)
    .some((point) => first.structuralRouteSignature !== point.structuralRouteSignature);
}

function buildPairedThresholdSemantics(
  pairs: PairedReferencePair[],
  primaryThresholdBps: bigint,
): {
  largestObservedBelowThreshold: PairedReferencePair | null;
  firstObservedAboveThreshold: PairedReferencePair | null;
  thresholdBoundaryBracketed: boolean;
} {
  let largestObservedBelowThreshold: PairedReferencePair | null = null;
  let firstObservedAboveThreshold: PairedReferencePair | null = null;
  for (const pair of pairs.filter((candidate) => candidate.pairUsable)) {
    const deteriorationBps = pair.pairedDeteriorationPercent
      ? percentStringToBps(pair.pairedDeteriorationPercent)
      : null;
    if (deteriorationBps === null) continue;
    if (deteriorationBps >= primaryThresholdBps) {
      if (
        largestObservedBelowThreshold !== null &&
        BigInt(pair.candidateInputRaw) > BigInt(largestObservedBelowThreshold.candidateInputRaw)
      ) {
        firstObservedAboveThreshold = pair;
        break;
      }
      firstObservedAboveThreshold ??= pair;
      continue;
    }
    largestObservedBelowThreshold = pair;
  }
  return {
    largestObservedBelowThreshold,
    firstObservedAboveThreshold,
    thresholdBoundaryBracketed:
      largestObservedBelowThreshold !== null &&
      firstObservedAboveThreshold !== null &&
      BigInt(firstObservedAboveThreshold.candidateInputRaw) >
        BigInt(largestObservedBelowThreshold.candidateInputRaw),
  };
}

function pairPlan(pair: PairedReferencePair): Record<string, unknown> {
  return {
    inputHuman: pair.candidateInputHuman,
    inputRaw: pair.candidateInputRaw,
    referenceInputHuman: pair.referenceInputHuman,
    referenceAveragePrice: pair.referenceAveragePrice,
    candidateAveragePrice: pair.candidateAveragePrice,
    pairedDeteriorationPercent: pair.pairedDeteriorationPercent,
    pairedReferenceDeteriorationPercent: pair.pairedReferenceDeteriorationPercent,
    routeChangedWithinPair: pair.routeChangedWithinPair,
    pairDurationMs: pair.pairDurationMs,
    pairUsable: pair.pairUsable,
  };
}

function buildPairedReferenceWarnings(pairs: PairedReferencePair[]): string[] {
  const warnings = new Set<string>();
  if (pairs.some((pair) => pair.routeChangedWithinPair)) {
    warnings.add(
      "A paired reference comparison changed route within the pair; this is allowed for best-route sizing, but review route composition before execution.",
    );
  }
  if (pairs.some((pair) => !pair.pairUsable)) {
    warnings.add("One or more paired reference comparisons are unusable.");
  }
  return [...warnings];
}
