import type { PiteasQuoteResult } from "../../../data/piteas.js";
import type { AppConfig } from "../../../types.js";
import { PITEAS_QUOTE_ENDPOINT } from "./constants.js";
import {
  currentMs,
  durationMs,
  emptyValidityFlags,
  formatRawAmount,
  gasCostPercent,
  nowIso,
  parseUnsignedRaw,
  timestampMs,
} from "./decimalMath.js";
import { isRouteSignatureConfidence, routeSummary } from "./routeSignatures.js";
import type {
  PiteasAccumulationPlanDeps,
  QuoteAttemptMetadata,
  QuoteCollection,
  QuoteFailure,
  QuotePoint,
  QuotePurpose,
  QuoteScheduler,
} from "./types.js";

export async function collectQuoteSet(input: {
  config: AppConfig;
  deps: PiteasAccumulationPlanDeps;
  scheduler: QuoteScheduler;
  purpose: QuotePurpose;
  sizesRaw: bigint[];
  eUsdcAddress: string;
  phiatAddress: string;
  account?: string;
  allowedSlippagePercent: number;
  eUsdcDecimals: number;
  phiatDecimals: number;
  thresholds: number[];
  maxGasCostBps: bigint;
  strictDurationMs?: number;
  allowRetries?: boolean;
}): Promise<QuoteCollection> {
  const collectionStartedAt = nowIso(input.deps);
  const collectionStartedMs = timestampMs(collectionStartedAt)!;
  const points: QuotePoint[] = [];
  const failures: QuoteFailure[] = [];

  for (const [idx, sizeRaw] of input.sizesRaw.entries()) {
    const inputHuman = formatRawAmount(sizeRaw, input.eUsdcDecimals);
    const elapsedBeforeRequest = currentMs(input.deps) - collectionStartedMs;
    if (
      input.strictDurationMs !== undefined &&
      elapsedBeforeRequest > input.strictDurationMs
    ) {
      const requestStartedAt = nowIso(input.deps);
      const failure = quoteFailure({
        purpose: input.purpose,
        inputHuman,
        inputRaw: sizeRaw.toString(),
        reason: `focused refresh strict time window exceeded after ${elapsedBeforeRequest}ms`,
        requestStartedAt,
        responseReceivedAt: requestStartedAt,
        endpoint: PITEAS_QUOTE_ENDPOINT,
        retryCount: 0,
        attempts: [],
      });
      failures.push(failure);
      points.push(
        failedQuotePoint({
          index: idx,
          purpose: input.purpose,
          sizeRaw,
          inputHuman,
          requestStartedAt,
          responseReceivedAt: requestStartedAt,
          reason: failure.reason,
          endpoint: failure.endpoint,
          retryCount: 0,
          attempts: [],
        }),
      );
      continue;
    }

    const requestStartedAt = nowIso(input.deps);
    const scheduled = await input.scheduler.quote({
      tokenIn: input.eUsdcAddress,
      tokenOut: input.phiatAddress,
      amount: sizeRaw.toString(),
      allowedSlippage: input.allowedSlippagePercent,
      account: input.account,
    }, {
      allowRetries: input.allowRetries === true,
    });
    const result = scheduled.result;
    const responseReceivedAt = scheduled.responseReceivedAt;
    if (!result.ok) {
      const failure = quoteFailure({
        purpose: input.purpose,
        inputHuman,
        inputRaw: sizeRaw.toString(),
        reason: result.reason,
        requestStartedAt: scheduled.requestStartedAt,
        responseReceivedAt,
        endpoint: PITEAS_QUOTE_ENDPOINT,
        retryCount: scheduled.schedulerRetryCount,
        attempts: scheduled.attempts,
      });
      failures.push(failure);
      points.push(
        failedQuotePoint({
          index: idx,
          purpose: input.purpose,
          sizeRaw,
          inputHuman,
          requestStartedAt,
          responseReceivedAt,
          reason: result.reason,
          endpoint: failure.endpoint,
          retryCount: scheduled.schedulerRetryCount,
          attempts: scheduled.attempts,
        }),
      );
      continue;
    }
    points.push(
      successfulQuotePoint({
        index: idx,
        purpose: input.purpose,
        expectedInputRaw: sizeRaw,
        inputHuman,
        result,
        requestStartedAt: scheduled.requestStartedAt,
        responseReceivedAt,
        eUsdcDecimals: input.eUsdcDecimals,
        phiatDecimals: input.phiatDecimals,
        maxGasCostBps: input.maxGasCostBps,
        schedulerRetryCount: scheduled.schedulerRetryCount,
        attempts: scheduled.attempts,
      }),
    );
  }

  const collectionCompletedAt = nowIso(input.deps);
  return {
    purpose: input.purpose,
    points,
    failures,
    collectionStartedAt,
    collectionCompletedAt,
    collectionDurationMs: durationMs(collectionStartedAt, collectionCompletedAt),
  };
}

export function quoteFailure(input: {
  purpose: QuotePurpose;
  inputHuman: string;
  inputRaw: string;
  reason: string;
  requestStartedAt: string;
  responseReceivedAt: string;
  endpoint: string;
  retryCount: number;
  attempts: QuoteAttemptMetadata[];
}): QuoteFailure {
  return {
    source: "piteas.quote",
    purpose: input.purpose,
    inputHuman: input.inputHuman,
    inputRaw: input.inputRaw,
    reason: input.reason,
    requestStartedAt: input.requestStartedAt,
    responseReceivedAt: input.responseReceivedAt,
    endpoint: input.endpoint,
    retryCount: input.retryCount,
    attempts: input.attempts,
  };
}

export function failedQuotePoint(input: {
  index: number;
  purpose: QuotePurpose;
  sizeRaw: bigint;
  inputHuman: string;
  requestStartedAt: string;
  responseReceivedAt: string;
  reason: string;
  endpoint: string;
  retryCount: number;
  attempts: QuoteAttemptMetadata[];
}): QuotePoint {
  return {
    index: input.index,
    purpose: input.purpose,
    inputRaw: input.sizeRaw.toString(),
    inputHuman: input.inputHuman,
    outputRaw: null,
    outputHuman: null,
    minimumOutputRaw: null,
    minimumOutputHuman: null,
    averagePrice: null,
    marginalPrice: null,
    marginalPriceScope: null,
    crossStateMarginalPrice: null,
    crossStateMarginalPriceExecutable: false,
    envelopeMarginalPrice: null,
    envelopeMarginalIsSequentialForecast: false,
    routeLocalMarginalPrice: null,
    priceDeteriorationPercent: null,
    averageSizePremiumPercent: null,
    piteasReportedPriceImpactPercent: null,
    thresholdCrossed: null,
    crossedThresholdsPercent: [],
    routeComposition: null,
    routeSignature: null,
    structuralRouteSignature: null,
    economicRouteFingerprint: null,
    routeChangeDetails: null,
    routeSignatureConfidence: "low",
    routeMetadataCompletenessPercent: 0,
    clusterId: null,
    routeChangedFromPreviousQuote: null,
    routeChangedFromPreviousInCluster: null,
    gasUseEstimate: null,
    gasUseEstimateUSD: null,
    gasCostPercentOfChunk: null,
    gasWarning: null,
    blockNumber: null,
    requestStartedAt: input.requestStartedAt,
    responseReceivedAt: input.responseReceivedAt,
    quoteTimestamp: null,
    quoteIdentifier: null,
    expiresAt: null,
    responseFingerprint: null,
    cacheHeaders: null,
    endpoint: input.endpoint,
    retryCount: input.retryCount,
    schedulerRetryCount: input.retryCount,
    attempts: input.attempts,
    fetchedAt: input.responseReceivedAt,
    quoteReady: false,
    quoteError: input.reason,
    validityFlags: emptyValidityFlags(),
    methodParametersOmitted: true,
  };
}

export function successfulQuotePoint(input: {
  index: number;
  purpose: QuotePurpose;
  expectedInputRaw: bigint;
  inputHuman: string;
  result: Extract<PiteasQuoteResult, { ok: true }>;
  requestStartedAt: string;
  responseReceivedAt: string;
  eUsdcDecimals: number;
  phiatDecimals: number;
  maxGasCostBps: bigint;
  schedulerRetryCount: number;
  attempts: QuoteAttemptMetadata[];
}): QuotePoint {
  const data = input.result.data;
  const amountInRaw = parseUnsignedRaw(data.amountIn) ?? input.expectedInputRaw;
  const amountOutRaw = parseUnsignedRaw(data.amountOut);
  const amountOutMinRaw = parseUnsignedRaw(data.amountOutMin ?? null);
  const gasCost = gasCostPercent(data.gasUseEstimateUSD ?? null, amountInRaw, input.eUsdcDecimals);
  const routeComposition = routeSummary(data);
  const structuralRouteSignature =
    typeof routeComposition?.structuralRouteSignature === "string"
      ? routeComposition.structuralRouteSignature
      : null;
  const economicRouteFingerprint =
    typeof routeComposition?.economicRouteFingerprint === "string"
      ? routeComposition.economicRouteFingerprint
      : null;
  const routeSignatureConfidence =
    isRouteSignatureConfidence(routeComposition?.routeSignatureConfidence)
      ? routeComposition.routeSignatureConfidence
      : "low";
  const routeMetadataCompletenessPercent =
    typeof routeComposition?.routeMetadataCompletenessPercent === "number"
      ? routeComposition.routeMetadataCompletenessPercent
      : 0;
  return {
    index: input.index,
    purpose: input.purpose,
    inputRaw: amountInRaw.toString(),
    inputHuman: formatRawAmount(amountInRaw, input.eUsdcDecimals),
    outputRaw: amountOutRaw?.toString() ?? null,
    outputHuman:
      amountOutRaw !== null ? formatRawAmount(amountOutRaw, input.phiatDecimals) : null,
    minimumOutputRaw: amountOutMinRaw?.toString() ?? null,
    minimumOutputHuman:
      amountOutMinRaw !== null
        ? formatRawAmount(amountOutMinRaw, input.phiatDecimals)
        : null,
    averagePrice: null,
    marginalPrice: null,
    marginalPriceScope: null,
    crossStateMarginalPrice: null,
    crossStateMarginalPriceExecutable: false,
    envelopeMarginalPrice: null,
    envelopeMarginalIsSequentialForecast: false,
    routeLocalMarginalPrice: null,
    priceDeteriorationPercent: null,
    averageSizePremiumPercent: null,
    piteasReportedPriceImpactPercent: data.priceImpactPercent ?? null,
    thresholdCrossed: null,
    crossedThresholdsPercent: [],
    routeComposition,
    routeSignature: structuralRouteSignature,
    structuralRouteSignature,
    economicRouteFingerprint,
    routeChangeDetails: null,
    routeSignatureConfidence,
    routeMetadataCompletenessPercent,
    clusterId: null,
    routeChangedFromPreviousQuote: null,
    routeChangedFromPreviousInCluster: null,
    gasUseEstimate: data.gasUseEstimate ?? null,
    gasUseEstimateUSD: data.gasUseEstimateUSD ?? null,
    gasCostPercentOfChunk: gasCost?.percent ?? null,
    gasWarning:
      gasCost !== null && gasCost.bps > input.maxGasCostBps
        ? `Gas estimate is ${gasCost.percent}% of this chunk, above the configured threshold.`
        : null,
    blockNumber: data.blockNumber ?? null,
    requestStartedAt: input.requestStartedAt,
    responseReceivedAt: input.responseReceivedAt,
    quoteTimestamp: data.quoteTimestamp ?? null,
    quoteIdentifier: data.quoteIdentifier ?? null,
    expiresAt: data.expiresAt ?? null,
    responseFingerprint: data.responseFingerprint ?? null,
    cacheHeaders: data.cacheHeaders ?? null,
    endpoint: data.endpoint ?? PITEAS_QUOTE_ENDPOINT,
    retryCount: (data.retryCount ?? 0) + input.schedulerRetryCount,
    schedulerRetryCount: input.schedulerRetryCount,
    attempts: input.attempts,
    fetchedAt: input.responseReceivedAt,
    quoteReady: data.quoteReady === true && amountOutRaw !== null && amountOutRaw > 0n,
    quoteError: null,
    validityFlags: emptyValidityFlags(),
    methodParametersOmitted: true,
  };
}
