import { PRICE_SCALE_DECIMALS } from "./constants.js";
import {
  formatRawAmount,
  formatRatio,
  isSuccessfulPoint,
  parseBlockNumber,
  priceRatio,
  timestampMs,
} from "./decimalMath.js";
import {
  buildRouteChanges,
  buildThresholdCrossings,
  buildThresholdSemantics,
  isEnvelopeCoherent,
  planFromPoint,
} from "./recommendationPrimitives.js";
import type {
  BestRouteEnvelopeAnalysis,
  EnvelopeCoherenceClass,
  QuoteCollection,
  SnapshotLimits,
  SuccessfulPoint,
} from "./types.js";

export function buildBestRouteEnvelope(input: {
  collection: QuoteCollection;
  source: "broad_discovery" | "focused_refresh";
  limits: SnapshotLimits;
  thresholds: number[];
  primaryThresholdBps: bigint;
  eUsdcDecimals: number;
  phiatDecimals: number;
}): BestRouteEnvelopeAnalysis {
  const points = input.collection.points
    .filter(isSuccessfulPoint)
    .sort((a, b) => {
      const ar = BigInt(a.inputRaw);
      const br = BigInt(b.inputRaw);
      return ar < br ? -1 : ar > br ? 1 : 0;
    });
  const temporalMetadata = buildEnvelopeTemporalMetadata(input.collection, input.limits);
  const envelopeCoherence = temporalMetadata.envelopeCoherence as EnvelopeCoherenceClass;
  const thresholdSemantics = buildThresholdSemantics(points, input.primaryThresholdBps);
  const sufficientForRecommendation =
    isEnvelopeCoherent(envelopeCoherence) &&
    points.length >= 3 &&
    thresholdSemantics.thresholdBoundaryBracketed;

  return {
    description:
      "Best-route envelope: every valid Piteas quote in ascending input order. Structural route changes are allowed and surfaced; envelope marginal values are cross-size comparisons, not sequential forecasts.",
    source: input.source,
    envelopeCoherence,
    envelopeCoherenceReasons:
      (temporalMetadata.envelopeCoherenceReasons as string[] | undefined) ?? [],
    points,
    averagePriceCurve: points.map((point) => ({
      inputHuman: point.inputHuman,
      outputHuman: point.outputHuman,
      minimumOutputHuman: point.minimumOutputHuman,
      averagePrice: point.averagePrice,
      averageSizePremiumPercent: point.averageSizePremiumPercent,
      piteasReportedPriceImpactPercent: point.piteasReportedPriceImpactPercent,
      crossedThresholdsPercent: point.crossedThresholdsPercent,
      structuralRouteSignature: point.structuralRouteSignature,
      routeSignatureConfidence: point.routeSignatureConfidence,
      routeMetadataCompletenessPercent: point.routeMetadataCompletenessPercent,
    })),
    envelopeMarginalCurve: buildEnvelopeMarginalCurve(
      points,
      input.eUsdcDecimals,
      input.phiatDecimals,
    ),
    thresholdCrossings: buildThresholdCrossings(points, input.thresholds),
    routeChanges: buildRouteChanges(points),
    bestRouteLargestObservedBelowThreshold:
      thresholdSemantics.largestObservedBelowThreshold
        ? planFromPoint(thresholdSemantics.largestObservedBelowThreshold)
        : null,
    bestRouteFirstObservedAboveThreshold:
      thresholdSemantics.firstObservedAboveThreshold
        ? planFromPoint(thresholdSemantics.firstObservedAboveThreshold)
        : null,
    bestRouteThresholdBoundaryBracketed:
      thresholdSemantics.thresholdBoundaryBracketed,
    bestRouteRecommendedMaximumTranche:
      sufficientForRecommendation && thresholdSemantics.largestObservedBelowThreshold
        ? planFromPoint(thresholdSemantics.largestObservedBelowThreshold)
        : null,
    successfulQuoteCount: points.length,
    temporalMetadata,
    envelopeMarginalIsSequentialForecast: false,
  };
}

function buildEnvelopeMarginalCurve(
  points: SuccessfulPoint[],
  eUsdcDecimals: number,
  phiatDecimals: number,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let previous: SuccessfulPoint | null = null;
  for (const point of points) {
    if (!previous) {
      rows.push({
        inputHuman: point.inputHuman,
        envelopeMarginalPrice: null,
        envelopeMarginalIsSequentialForecast: false,
        scope: "envelope_first_quote",
      });
      previous = point;
      continue;
    }
    const deltaInputRaw = BigInt(point.inputRaw) - BigInt(previous.inputRaw);
    const deltaOutputRaw = BigInt(point.outputRaw) - BigInt(previous.outputRaw);
    const marginal =
      deltaInputRaw > 0n && deltaOutputRaw > 0n
        ? priceRatio(deltaInputRaw, deltaOutputRaw, eUsdcDecimals, phiatDecimals)
        : null;
    point.envelopeMarginalPrice = marginal
      ? formatRatio(marginal, PRICE_SCALE_DECIMALS)
      : null;
    point.envelopeMarginalIsSequentialForecast = false;
    rows.push({
      fromInputHuman: previous.inputHuman,
      toInputHuman: point.inputHuman,
      marginalInputHuman: formatRawAmount(deltaInputRaw, eUsdcDecimals),
      marginalOutputHuman:
        deltaOutputRaw > 0n ? formatRawAmount(deltaOutputRaw, phiatDecimals) : null,
      envelopeMarginalPrice: point.envelopeMarginalPrice,
      envelopeMarginalIsSequentialForecast: false,
      structuralRouteChanged:
        point.routeChangeDetails?.structuralRouteChanged ?? false,
      allocationChanged: point.routeChangeDetails?.allocationChanged ?? false,
      scope:
        point.routeChangeDetails?.structuralRouteChanged === true
          ? "cross_route_envelope"
          : "same_route_envelope",
    });
    previous = point;
  }
  return rows;
}

function buildEnvelopeTemporalMetadata(
  collection: QuoteCollection,
  limits: SnapshotLimits,
): Record<string, unknown> {
  const successful = collection.points.filter(isSuccessfulPoint);
  const blockValues = successful
    .map((point) => parseBlockNumber(point.blockNumber))
    .filter((block): block is bigint => block !== null);
  const responseTimestampValues = successful
    .map((point) => timestampMs(point.responseReceivedAt))
    .filter((value): value is number => value !== null);
  const quoteTimestampValues = successful
    .map((point) => timestampMs(point.quoteTimestamp))
    .filter((value): value is number => value !== null);
  const minimumBlock =
    blockValues.length > 0 ? blockValues.reduce((min, value) => (value < min ? value : min)) : null;
  const maximumBlock =
    blockValues.length > 0 ? blockValues.reduce((max, value) => (value > max ? value : max)) : null;
  const blockSpread =
    minimumBlock !== null && maximumBlock !== null ? maximumBlock - minimumBlock : null;
  const responseTimestampSpreadMs =
    responseTimestampValues.length > 0
      ? Math.max(...responseTimestampValues) - Math.min(...responseTimestampValues)
      : null;
  const quoteAgeSpreadMs =
    quoteTimestampValues.length === successful.length && quoteTimestampValues.length > 0
      ? Math.max(...quoteTimestampValues) - Math.min(...quoteTimestampValues)
      : null;
  const reasons: string[] = [];
  if (successful.length === 0) reasons.push("no successful quotes");
  if (collection.failures.length > 0) {
    reasons.push("one or more quote sizes failed; envelope uses successful points only");
  }
  if (blockValues.length !== successful.length) reasons.push("block metadata incomplete");
  if (quoteTimestampValues.length !== successful.length) {
    reasons.push("quoteTimestamp metadata incomplete");
  }
  if (collection.points.some((point) => point.retryCount > 0)) {
    reasons.push("one or more quote points report retryCount > 0");
  }
  if (blockSpread !== null && blockSpread > limits.maxBlockSpread) {
    reasons.push("block spread exceeds configured envelope limit");
  }
  if (collection.collectionDurationMs > limits.maxCollectionDurationMs) {
    reasons.push("collection duration exceeds configured envelope limit");
  }
  if (
    responseTimestampSpreadMs !== null &&
    responseTimestampSpreadMs > limits.maxCollectionDurationMs
  ) {
    reasons.push("response timestamp spread exceeds configured envelope limit");
  }
  if (quoteAgeSpreadMs !== null && quoteAgeSpreadMs > limits.maxQuoteAgeSpreadMs) {
    reasons.push("quote age spread exceeds configured envelope limit");
  }

  let envelopeCoherence: EnvelopeCoherenceClass;
  if (successful.length === 0 || responseTimestampSpreadMs === null) {
    envelopeCoherence = "insufficient_metadata";
  } else if (
    collection.points.some((point) => point.retryCount > 0) ||
    (blockSpread !== null && blockSpread > limits.maxBlockSpread) ||
    collection.collectionDurationMs > limits.maxCollectionDurationMs ||
    responseTimestampSpreadMs > limits.maxCollectionDurationMs ||
    (quoteAgeSpreadMs !== null && quoteAgeSpreadMs > limits.maxQuoteAgeSpreadMs)
  ) {
    envelopeCoherence = "stitched_multi_state";
  } else if (blockValues.length === successful.length && blockSpread === 0n) {
    envelopeCoherence = "coherent_same_block";
  } else {
    envelopeCoherence = "coherent_tight_window";
  }

  return {
    collectionStartedAt: collection.collectionStartedAt,
    collectionCompletedAt: collection.collectionCompletedAt,
    collectionDurationMs: collection.collectionDurationMs,
    minimumBlock: minimumBlock?.toString() ?? null,
    maximumBlock: maximumBlock?.toString() ?? null,
    blockSpread: blockSpread?.toString() ?? null,
    quoteAgeSpreadMs,
    responseTimestampSpreadMs,
    atomicSnapshot: envelopeCoherence === "coherent_same_block",
    envelopeCoherence,
    envelopeCoherenceReasons: reasons,
    limits: {
      maximumBlockSpread: limits.maxBlockSpread.toString(),
      maximumTotalCollectionDurationMs: limits.maxCollectionDurationMs,
      maximumQuoteAgeSpreadMs: limits.maxQuoteAgeSpreadMs,
      maximumResponseTimestampSpreadMs: limits.maxCollectionDurationMs,
    },
  };
}
