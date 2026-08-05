import { PRICE_SCALE_DECIMALS, SAME_STATE_WARNING } from "./constants.js";
import { parseHumanAmount, percentStringToBps, percentToBps } from "./decimalMath.js";
import type {
  CoherenceClass,
  EnvelopeCoherenceClass,
  SuccessfulPoint,
  ThresholdSemantics,
} from "./types.js";

export function firstTrancheObservation(point: SuccessfulPoint): Record<string, unknown> {
  return {
    inputHuman: point.inputHuman,
    outputHuman: point.outputHuman,
    minimumOutputHuman: point.minimumOutputHuman,
    averagePrice: point.averagePrice,
    gasEstimate: {
      gasUseEstimate: point.gasUseEstimate,
      gasUseEstimateUSD: point.gasUseEstimateUSD,
      gasCostPercentOfChunk: point.gasCostPercentOfChunk,
      gasWarning: point.gasWarning,
    },
    quoteTimestamp: point.quoteTimestamp,
    expiresOrStalenessWarning: SAME_STATE_WARNING,
    requoteRequiredBeforeExecution: true,
  };
}

export function planFromPoint(point: SuccessfulPoint): Record<string, unknown> {
  return {
    inputHuman: point.inputHuman,
    inputRaw: point.inputRaw,
    expectedOutputHuman: point.outputHuman,
    expectedOutputRaw: point.outputRaw,
    minimumOutputHuman: point.minimumOutputHuman,
    minimumOutputRaw: point.minimumOutputRaw,
    averagePrice: point.averagePrice,
    marginalPrice: point.marginalPrice,
    marginalPriceScope: point.marginalPriceScope,
    envelopeMarginalPrice: point.envelopeMarginalPrice,
    envelopeMarginalIsSequentialForecast: point.envelopeMarginalIsSequentialForecast,
    routeLocalMarginalPrice: point.routeLocalMarginalPrice,
    priceDeteriorationPercent: point.priceDeteriorationPercent,
    averageSizePremiumPercent: point.averageSizePremiumPercent,
    piteasReportedPriceImpactPercent: point.piteasReportedPriceImpactPercent,
    gasUseEstimate: point.gasUseEstimate,
    gasUseEstimateUSD: point.gasUseEstimateUSD,
    routeComposition: point.routeComposition,
  };
}


export function buildThresholdSemantics(
  points: SuccessfulPoint[],
  primaryThresholdBps: bigint,
): ThresholdSemantics {
  let largestObservedBelowThreshold: SuccessfulPoint | null = null;
  let firstObservedAboveThreshold: SuccessfulPoint | null = null;
  for (const point of points) {
    if (priceImpactThresholdExceeded(point, primaryThresholdBps)) {
      if (largestObservedBelowThreshold !== null) {
        firstObservedAboveThreshold = point;
        break;
      }
      firstObservedAboveThreshold ??= point;
      continue;
    }
    largestObservedBelowThreshold = point;
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

export function priceImpactThresholdExceeded(
  point: SuccessfulPoint,
  primaryThresholdBps: bigint,
): boolean {
  const deteriorationBps = point.priceDeteriorationPercent
    ? percentStringToBps(point.priceDeteriorationPercent)
    : null;
  const piteasImpactBps =
    point.piteasReportedPriceImpactPercent !== null
      ? percentToBps(point.piteasReportedPriceImpactPercent)
      : null;
  return (
    (deteriorationBps !== null && deteriorationBps >= primaryThresholdBps) ||
    (piteasImpactBps !== null && piteasImpactBps >= primaryThresholdBps)
  );
}

export function countValidMarginalIntervals(points: SuccessfulPoint[]): number {
  return points.filter(
    (point) => point.marginalPriceScope === "local_cluster" && point.marginalPrice !== null,
  ).length;
}

export function isCoherent(coherenceClass: CoherenceClass): boolean {
  return (
    coherenceClass === "coherent_same_block" ||
    coherenceClass === "coherent_narrow_window"
  );
}

export function isEnvelopeCoherent(coherenceClass: EnvelopeCoherenceClass): boolean {
  return (
    coherenceClass === "coherent_same_block" ||
    coherenceClass === "coherent_tight_window" ||
    coherenceClass === "usable_paired_quotes"
  );
}

export function buildThresholdCrossings(
  points: SuccessfulPoint[],
  thresholds: number[],
): Array<Record<string, unknown>> {
  return thresholds.map((threshold) => {
    const first = points.find((point) => point.crossedThresholdsPercent.includes(threshold));
    return {
      thresholdPercent: threshold,
      firstCrossedAtInputHuman: first?.inputHuman ?? null,
      firstCrossedAtAveragePrice: first?.averagePrice ?? null,
      firstCrossedAtPiteasImpactPercent:
        first?.piteasReportedPriceImpactPercent ?? null,
    };
  });
}

export function buildRouteChanges(points: SuccessfulPoint[]): Array<Record<string, unknown>> {
  const changes: Array<Record<string, unknown>> = [];
  let previous: SuccessfulPoint | null = null;
  for (const point of points) {
    if (
      previous &&
      point.routeChangeDetails &&
      (point.routeChangeDetails.structuralRouteChanged ||
        point.routeChangeDetails.allocationChanged ||
        point.routeChangeDetails.onlyEconomicValuesChanged)
    ) {
      changes.push({
        fromInputHuman: previous.inputHuman,
        toInputHuman: point.inputHuman,
        fromStructuralRouteSignature: previous.structuralRouteSignature,
        toStructuralRouteSignature: point.structuralRouteSignature,
        fromEconomicRouteFingerprint: previous.economicRouteFingerprint,
        toEconomicRouteFingerprint: point.economicRouteFingerprint,
        routeChangeDetails: point.routeChangeDetails,
        routeSignatureConfidence: point.routeSignatureConfidence,
        routeMetadataCompletenessPercent: point.routeMetadataCompletenessPercent,
      });
    }
    previous = point;
  }
  return changes;
}


export function bestPoint(points: SuccessfulPoint[]): SuccessfulPoint | null {
  return points.reduce<SuccessfulPoint | null>((best, point) => {
    if (!best) return point;
    return compareAveragePrice(point, best) < 0 ? point : best;
  }, null);
}

export function worstPoint(points: SuccessfulPoint[]): SuccessfulPoint | null {
  return points.reduce<SuccessfulPoint | null>((worst, point) => {
    if (!worst) return point;
    return compareAveragePrice(point, worst) > 0 ? point : worst;
  }, null);
}

export function compareAveragePrice(a: SuccessfulPoint, b: SuccessfulPoint): number {
  if (!a.averagePrice && !b.averagePrice) return 0;
  if (!a.averagePrice) return 1;
  if (!b.averagePrice) return -1;
  const ar = parseHumanAmount(a.averagePrice, PRICE_SCALE_DECIMALS, "averagePrice");
  const br = parseHumanAmount(b.averagePrice, PRICE_SCALE_DECIMALS, "averagePrice");
  return ar < br ? -1 : ar > br ? 1 : 0;
}
