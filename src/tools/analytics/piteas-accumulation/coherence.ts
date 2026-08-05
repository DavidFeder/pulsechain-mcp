import { PRICE_SCALE_DECIMALS } from "./constants.js";
import {
  compareRatio,
  durationMs,
  formatBpsAsPercent,
  formatRatio,
  formatRawAmount,
  isSuccessfulPoint,
  parseBlockNumber,
  parseHumanAmount,
  parseUnsignedRaw,
  percentChangeBps,
  percentToBps,
  priceRatio,
  timestampMs,
} from "./decimalMath.js";
import {
  buildRouteChangeDetails,
  emptyRouteChangeDetails,
  routesStructurallyIncompatible,
  weakestRouteConfidence,
  lowestRouteMetadataCompleteness,
} from "./routeSignatures.js";
import { quoteFailure } from "./quoteNormalization.js";
import type {
  CoherenceClass,
  LocalQuoteCluster,
  QuoteCollection,
  QuotePoint,
  QuotePurpose,
  Ratio,
  SnapshotLimits,
  SnapshotMetadata,
  SuccessfulPoint,
} from "./types.js";

export function decorateCurve(
  points: QuotePoint[],
  input: {
    eUsdcDecimals: number;
    phiatDecimals: number;
    thresholds: number[];
  },
): void {
  let baseline: Ratio | null = null;
  let previousPoint: SuccessfulPoint | null = null;
  for (const point of points) {
    if (!isSuccessfulPoint(point)) continue;
    const inputRaw = BigInt(point.inputRaw);
    const outputRaw = BigInt(point.outputRaw);
    const avg = priceRatio(inputRaw, outputRaw, input.eUsdcDecimals, input.phiatDecimals);
    if (avg) {
      point.averagePrice = formatRatio(avg, PRICE_SCALE_DECIMALS);
      baseline ??= avg;
      const deterioration = percentChangeBps(avg, baseline);
      const deteriorationPercent =
        deterioration !== null ? formatBpsAsPercent(deterioration) : null;
      point.priceDeteriorationPercent = deteriorationPercent;
      point.averageSizePremiumPercent = deteriorationPercent;
    }

    const deteriorationBps =
      avg && baseline ? percentChangeBps(avg, baseline) : null;
    const piteasImpactBps =
      point.piteasReportedPriceImpactPercent !== null
        ? percentToBps(point.piteasReportedPriceImpactPercent)
        : null;
    point.crossedThresholdsPercent = input.thresholds.filter((threshold) => {
      const thresholdBps = percentToBps(threshold);
      return (
        (deteriorationBps !== null && deteriorationBps >= thresholdBps) ||
        (piteasImpactBps !== null && piteasImpactBps >= thresholdBps)
      );
    });
    point.thresholdCrossed = point.crossedThresholdsPercent.length > 0;
    const routeChangeDetails = previousPoint
      ? buildRouteChangeDetails(previousPoint, point)
      : emptyRouteChangeDetails();
    point.routeChangeDetails = routeChangeDetails;
    point.routeChangedFromPreviousQuote =
      previousPoint !== null &&
      routesStructurallyIncompatible(previousPoint, point, routeChangeDetails);
    previousPoint = point;
  }
}

export function buildSnapshotMetadata(
  collection: QuoteCollection,
  limits: SnapshotLimits,
): SnapshotMetadata {
  const successful = collection.points.filter(isSuccessfulPoint);
  const blockValues = successful
    .map((point) => parseBlockNumber(point.blockNumber))
    .filter((block): block is bigint => block !== null);
  const hasCompleteBlockMetadata =
    successful.length > 0 && blockValues.length === successful.length;
  const minimumBlock =
    blockValues.length > 0 ? blockValues.reduce((min, value) => (value < min ? value : min)) : null;
  const maximumBlock =
    blockValues.length > 0 ? blockValues.reduce((max, value) => (value > max ? value : max)) : null;
  const blockSpread =
    minimumBlock !== null && maximumBlock !== null ? maximumBlock - minimumBlock : null;

  const quoteTimestampValues = successful
    .map((point) => timestampMs(point.quoteTimestamp))
    .filter((value): value is number => value !== null);
  const responseTimestampValues = successful
    .map((point) => timestampMs(point.responseReceivedAt))
    .filter((value): value is number => value !== null);
  const quoteAgeSpreadSource =
    quoteTimestampValues.length === successful.length && quoteTimestampValues.length > 0
      ? "quoteTimestamp"
      : responseTimestampValues.length === successful.length && responseTimestampValues.length > 0
        ? "responseReceivedAt"
        : null;
  const quoteAgeValues =
    quoteAgeSpreadSource === "quoteTimestamp" ? quoteTimestampValues : responseTimestampValues;
  const quoteAgeSpreadMs =
    quoteAgeSpreadSource !== null ? Math.max(...quoteAgeValues) - Math.min(...quoteAgeValues) : null;

  const reasons: string[] = [];
  if (successful.length === 0) {
    reasons.push("no successful quote metadata");
  }
  if (!hasCompleteBlockMetadata) {
    reasons.push("block metadata incomplete");
  }
  if (quoteAgeSpreadSource !== "quoteTimestamp") {
    reasons.push("upstream quoteTimestamp metadata incomplete; responseReceivedAt used when available");
  }
  if (collection.points.some((point) => point.retryCount > 0)) {
    reasons.push("one or more quote points report retryCount > 0");
  }
  if (collection.failures.length > 0) {
    reasons.push("one or more quote sizes failed");
  }
  if (blockSpread !== null && blockSpread > limits.maxBlockSpread) {
    reasons.push("block spread exceeds configured limit");
  }
  if (collection.collectionDurationMs > limits.maxCollectionDurationMs) {
    reasons.push("collection duration exceeds configured limit");
  }
  if (quoteAgeSpreadMs !== null && quoteAgeSpreadMs > limits.maxQuoteAgeSpreadMs) {
    reasons.push("quote age spread exceeds configured limit");
  }

  const noRetries = collection.points.every((point) => point.retryCount === 0);
  let coherenceClass: CoherenceClass;
  if (successful.length === 0 || quoteAgeSpreadSource === null) {
    coherenceClass = "insufficient_metadata";
  } else if (
    collection.failures.length > 0 ||
    !noRetries ||
    (blockSpread !== null && blockSpread > limits.maxBlockSpread) ||
    collection.collectionDurationMs > limits.maxCollectionDurationMs ||
    (quoteAgeSpreadMs !== null && quoteAgeSpreadMs > limits.maxQuoteAgeSpreadMs)
  ) {
    coherenceClass = "stitched_multi_state";
  } else if (hasCompleteBlockMetadata && blockSpread === 0n) {
    coherenceClass = "coherent_same_block";
  } else {
    coherenceClass = "coherent_narrow_window";
  }

  return {
    collectionStartedAt: collection.collectionStartedAt,
    collectionCompletedAt: collection.collectionCompletedAt,
    collectionDurationMs: collection.collectionDurationMs,
    minimumBlock: minimumBlock?.toString() ?? null,
    maximumBlock: maximumBlock?.toString() ?? null,
    blockSpread: blockSpread?.toString() ?? null,
    quoteAgeSpreadMs,
    quoteAgeSpreadSource,
    atomicSnapshot: coherenceClass === "coherent_same_block",
    coherenceClass,
    coherenceReasons: reasons,
    limits: {
      maxBlockSpread: limits.maxBlockSpread.toString(),
      maxCollectionDurationMs: limits.maxCollectionDurationMs,
      maxQuoteAgeSpreadMs: limits.maxQuoteAgeSpreadMs,
    },
  };
}

export function validateMonotonicity(
  points: QuotePoint[],
  snapshot: SnapshotMetadata,
  limits: SnapshotLimits,
  eUsdcDecimals: number,
  phiatDecimals: number,
): Record<string, unknown> {
  const successful = points.filter(isSuccessfulPoint);
  const anomalies: Array<Record<string, unknown>> = [];
  const crossStateComparisons: Array<Record<string, unknown>> = [];
  const latestQuoteMs = Math.max(
    ...successful
      .map((point) => timestampMs(point.quoteTimestamp) ?? timestampMs(point.responseReceivedAt))
      .filter((value): value is number => value !== null),
    0,
  );
  let previous: SuccessfulPoint | null = null;
  let previousMarginal: Ratio | null = null;

  for (const point of successful) {
    const pointQuoteMs =
      timestampMs(point.quoteTimestamp) ?? timestampMs(point.responseReceivedAt);
    if (
      pointQuoteMs !== null &&
      latestQuoteMs > 0 &&
      latestQuoteMs - pointQuoteMs > limits.maxQuoteAgeSpreadMs
    ) {
      point.validityFlags.staleQuote = true;
      anomalies.push({
        flag: "staleQuote",
        inputHuman: point.inputHuman,
        ageDeltaMs: latestQuoteMs - pointQuoteMs,
      });
    }
    if (point.retryCount > 0) {
      point.validityFlags.staleQuote = true;
      anomalies.push({
        flag: "staleQuote",
        inputHuman: point.inputHuman,
        retryCount: point.retryCount,
      });
    }
    if (BigInt(point.outputRaw) <= 0n) {
      point.validityFlags.cumulativeOutputNonPositive = true;
      anomalies.push({ flag: "cumulativeOutputNonPositive", inputHuman: point.inputHuman });
    }

    if (!previous) {
      previous = point;
      continue;
    }

    const inputRaw = BigInt(point.inputRaw);
    const previousInputRaw = BigInt(previous.inputRaw);
    if (inputRaw <= previousInputRaw) {
      previous = point;
      continue;
    }
    const outputRaw = BigInt(point.outputRaw);
    const previousOutputRaw = BigInt(previous.outputRaw);
    const minimumRaw = parseUnsignedRaw(point.minimumOutputRaw);
    const previousMinimumRaw = parseUnsignedRaw(previous.minimumOutputRaw);
    const deltaInputRaw = inputRaw - previousInputRaw;
    const deltaOutputRaw = outputRaw - previousOutputRaw;
    const routeChanged = routesStructurallyIncompatible(previous, point);

    if (routeChanged) {
      point.validityFlags.routeDiscontinuity = true;
      anomalies.push({
        flag: "routeDiscontinuity",
        fromInputHuman: previous.inputHuman,
        toInputHuman: point.inputHuman,
        fromStructuralRouteSignature: previous.structuralRouteSignature,
        toStructuralRouteSignature: point.structuralRouteSignature,
        routeChangeDetails: point.routeChangeDetails,
      });
    }
    if (snapshot.coherenceClass === "stitched_multi_state") {
      point.validityFlags.snapshotDiscontinuity = true;
    }
    if (outputRaw <= previousOutputRaw) {
      point.validityFlags.outputNonMonotonic = true;
      anomalies.push({
        flag: "outputNonMonotonic",
        fromInputHuman: previous.inputHuman,
        toInputHuman: point.inputHuman,
      });
    }
    if (
      minimumRaw !== null &&
      previousMinimumRaw !== null &&
      minimumRaw <= previousMinimumRaw
    ) {
      point.validityFlags.minimumOutputNonMonotonic = true;
      anomalies.push({
        flag: "minimumOutputNonMonotonic",
        fromInputHuman: previous.inputHuman,
        toInputHuman: point.inputHuman,
      });
    }
    if (deltaOutputRaw <= 0n) {
      point.validityFlags.marginalOutputNonPositive = true;
      point.validityFlags.marginalPriceAnomaly = true;
      anomalies.push({
        flag: "marginalOutputNonPositive",
        fromInputHuman: previous.inputHuman,
        toInputHuman: point.inputHuman,
      });
    }

    const currentAvg = point.averagePrice
      ? parseHumanAmount(point.averagePrice, PRICE_SCALE_DECIMALS, "averagePrice")
      : null;
    const previousAvg = previous.averagePrice
      ? parseHumanAmount(previous.averagePrice, PRICE_SCALE_DECIMALS, "averagePrice")
      : null;
    if (currentAvg !== null && previousAvg !== null && currentAvg < previousAvg) {
      point.validityFlags.averagePriceImprovedAtLargerSize = true;
      anomalies.push({
        flag: "averagePriceImprovedAtLargerSize",
        fromInputHuman: previous.inputHuman,
        toInputHuman: point.inputHuman,
        context: routeChanged
          ? "route discontinuity; re-quote a fresh local cluster"
          : snapshot.coherenceClass === "stitched_multi_state"
            ? "snapshot discontinuity; re-quote a fresh local cluster"
            : "same-cluster price improvement; review route details",
      });
    }

    if (deltaOutputRaw > 0n) {
      const marginal = priceRatio(
        deltaInputRaw,
        deltaOutputRaw,
        eUsdcDecimals,
        phiatDecimals,
      );
        if (marginal) {
        point.envelopeMarginalPrice = formatRatio(marginal, PRICE_SCALE_DECIMALS);
        point.envelopeMarginalIsSequentialForecast = false;
        if (
          previousMarginal &&
          compareRatio(marginal, previousMarginal) < 0
        ) {
          point.validityFlags.marginalPriceAnomaly = true;
          anomalies.push({
            flag: "marginalPriceAnomaly",
            fromInputHuman: previous.inputHuman,
            toInputHuman: point.inputHuman,
            context: routeChanged
              ? "route discontinuity"
              : snapshot.coherenceClass === "stitched_multi_state"
                ? "snapshot discontinuity"
                : "local marginal price improved at larger size",
          });
        }
        if (routeChanged || snapshot.coherenceClass === "stitched_multi_state") {
          point.crossStateMarginalPrice = point.envelopeMarginalPrice;
          crossStateComparisons.push({
            fromInputHuman: previous.inputHuman,
            toInputHuman: point.inputHuman,
            crossStateMarginalPrice: point.crossStateMarginalPrice,
            envelopeMarginalPrice: point.envelopeMarginalPrice,
            envelopeMarginalIsSequentialForecast: false,
            executable: false,
            reason: routeChanged ? "routeDiscontinuity" : "stitched_multi_state",
          });
        }
        previousMarginal = marginal;
      }
    }
    previous = point;
  }

  return {
    outputRawStrictlyIncreases: !successful.some(
      (point) => point.validityFlags.outputNonMonotonic,
    ),
    minimumOutputRawStrictlyIncreases: !successful.some(
      (point) => point.validityFlags.minimumOutputNonMonotonic,
    ),
    cumulativeOutputAlwaysPositive: !successful.some(
      (point) => point.validityFlags.cumulativeOutputNonPositive,
    ),
    marginalOutputAlwaysPositive: !successful.some(
      (point) => point.validityFlags.marginalOutputNonPositive,
    ),
    averagePriceImprovedAtLargerSize: successful.some(
      (point) => point.validityFlags.averagePriceImprovedAtLargerSize,
    ),
    marginalPriceAnomaly: successful.some(
      (point) => point.validityFlags.marginalPriceAnomaly,
    ),
    outputNonMonotonic: successful.some((point) => point.validityFlags.outputNonMonotonic),
    staleQuote: successful.some((point) => point.validityFlags.staleQuote),
    routeDiscontinuity: successful.some((point) => point.validityFlags.routeDiscontinuity),
    anomalies,
    crossStateComparisons,
  };
}

export function buildLocalQuoteClusters(input: {
  points: QuotePoint[];
  purpose: QuotePurpose;
  limits: SnapshotLimits;
  thresholds: number[];
  eUsdcDecimals: number;
  phiatDecimals: number;
  clusterPrefix: string;
}): LocalQuoteCluster[] {
  const successful = input.points.filter(isSuccessfulPoint);
  const clusters: SuccessfulPoint[][] = [];
  let current: SuccessfulPoint[] = [];

  for (const point of successful) {
    if (current.length === 0) {
      current = [point];
      continue;
    }
    const candidate = [...current, point];
    const sameRoute = !routesStructurallyIncompatible(current[0]!, point);
    const candidateSnapshot = buildSnapshotMetadata(
      collectionFromPoints(input.purpose, candidate),
      input.limits,
    );
    if (!sameRoute || candidateSnapshot.coherenceClass === "stitched_multi_state") {
      clusters.push(current);
      current = [point];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) clusters.push(current);

  return clusters.map((cluster, idx) => {
    const clusterId = `${input.clusterPrefix}-${idx + 1}`;
    for (const [pointIndex, point] of cluster.entries()) {
      point.clusterId = clusterId;
      const previousInCluster = pointIndex > 0 ? cluster[pointIndex - 1]! : null;
      point.routeChangedFromPreviousInCluster = previousInCluster
        ? routesStructurallyIncompatible(previousInCluster, point)
        : false;
    }
    const metadata = buildSnapshotMetadata(collectionFromPoints(input.purpose, cluster), input.limits);
    const localAveragePriceCurve = buildLocalAverageCurve(cluster, input.thresholds);
    const localMarginalPriceCurve = buildLocalMarginalCurve(
      cluster,
      input.eUsdcDecimals,
      input.phiatDecimals,
    );
    return {
      clusterId,
      purpose: input.purpose,
      routeSignature: cluster[0]?.routeSignature ?? null,
      structuralRouteSignature: cluster[0]?.structuralRouteSignature ?? null,
      economicRouteFingerprints: cluster
        .map((point) => point.economicRouteFingerprint)
        .filter((value): value is string => value !== null),
      routeSignatureConfidence: weakestRouteConfidence(cluster),
      routeMetadataCompletenessPercent: lowestRouteMetadataCompleteness(cluster),
      structuralRouteFields:
        (cluster[0]?.routeComposition?.structuralRouteFields as Record<string, unknown> | undefined) ??
        null,
      quoteSizesHuman: cluster.map((point) => point.inputHuman),
      blockRange: {
        minimumBlock: metadata.minimumBlock,
        maximumBlock: metadata.maximumBlock,
        blockSpread: metadata.blockSpread,
      },
      timeRange: {
        startedAt: metadata.collectionStartedAt,
        completedAt: metadata.collectionCompletedAt,
        durationMs: metadata.collectionDurationMs,
      },
      coherenceClass: metadata.coherenceClass,
      localAveragePriceCurve,
      localMarginalPriceCurve,
      thresholdCrossings: buildClusterThresholdCrossings(localAveragePriceCurve, input.thresholds),
    };
  });
}

function buildLocalAverageCurve(
  cluster: SuccessfulPoint[],
  thresholds: number[],
): Array<Record<string, unknown>> {
  const baseline = cluster[0]?.averagePrice
    ? parseHumanAmount(cluster[0].averagePrice, PRICE_SCALE_DECIMALS, "averagePrice")
    : null;
  return cluster.map((point) => {
    const avg = point.averagePrice
      ? parseHumanAmount(point.averagePrice, PRICE_SCALE_DECIMALS, "averagePrice")
      : null;
    const deteriorationBps =
      avg !== null && baseline !== null && baseline > 0n
        ? ((avg - baseline) * 10000n) / baseline
        : null;
    const deteriorationPercent =
      deteriorationBps !== null ? formatBpsAsPercent(deteriorationBps) : null;
    return {
      inputHuman: point.inputHuman,
      averagePrice: point.averagePrice,
      localPriceDeteriorationPercent: deteriorationPercent,
      crossedThresholdsPercent: thresholds.filter((threshold) => {
        const bps = percentToBps(threshold);
        return deteriorationBps !== null && deteriorationBps >= bps;
      }),
    };
  });
}

function buildLocalMarginalCurve(
  cluster: SuccessfulPoint[],
  eUsdcDecimals: number,
  phiatDecimals: number,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let previous: SuccessfulPoint | null = null;
  for (const point of cluster) {
    if (!previous) {
      point.marginalPrice = point.averagePrice;
      point.routeLocalMarginalPrice = point.marginalPrice;
      point.marginalPriceScope = "cluster_first_quote";
      rows.push({
        inputHuman: point.inputHuman,
        marginalPrice: point.marginalPrice,
        routeLocalMarginalPrice: point.routeLocalMarginalPrice,
        marginalInputHuman: point.inputHuman,
        marginalOutputHuman: point.outputHuman,
        scope: "cluster_first_quote",
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
    point.marginalPrice = marginal ? formatRatio(marginal, PRICE_SCALE_DECIMALS) : null;
    point.routeLocalMarginalPrice = point.marginalPrice;
    point.marginalPriceScope = "local_cluster";
    rows.push({
      fromInputHuman: previous.inputHuman,
      toInputHuman: point.inputHuman,
      marginalInputHuman: formatRawAmount(deltaInputRaw, eUsdcDecimals),
      marginalOutputHuman:
        deltaOutputRaw > 0n ? formatRawAmount(deltaOutputRaw, phiatDecimals) : null,
      marginalPrice: point.marginalPrice,
      routeLocalMarginalPrice: point.routeLocalMarginalPrice,
      scope: "local_cluster",
    });
    previous = point;
  }
  return rows;
}

function buildClusterThresholdCrossings(
  curve: Array<Record<string, unknown>>,
  thresholds: number[],
): Array<Record<string, unknown>> {
  return thresholds.map((threshold) => {
    const first = curve.find((row) =>
      ((row.crossedThresholdsPercent as number[] | undefined) ?? []).includes(threshold),
    );
    return {
      thresholdPercent: threshold,
      firstCrossedAtInputHuman: first?.inputHuman ?? null,
      firstCrossedAtAveragePrice: first?.averagePrice ?? null,
    };
  });
}

function collectionFromPoints(purpose: QuotePurpose, points: QuotePoint[]): QuoteCollection {
  const started = points[0]?.requestStartedAt ?? new Date(0).toISOString();
  const completed = points.at(-1)?.responseReceivedAt ?? started;
  return {
    purpose,
    points,
    failures: points
      .filter((point) => !point.quoteReady)
      .map((point) =>
        quoteFailure({
          purpose,
          inputHuman: point.inputHuman,
          inputRaw: point.inputRaw,
          reason: point.quoteError ?? "quote unavailable",
          requestStartedAt: point.requestStartedAt,
          responseReceivedAt: point.responseReceivedAt,
          endpoint: point.endpoint,
          retryCount: point.retryCount,
          attempts: point.attempts,
        }),
      ),
    collectionStartedAt: started,
    collectionCompletedAt: completed,
    collectionDurationMs: durationMs(started, completed),
  };
}
