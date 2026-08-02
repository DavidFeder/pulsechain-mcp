import type { AppConfig } from "../../../types.js";
import { buildBestRouteEnvelope } from "./bestRouteEnvelope.js";
import {
  buildLocalQuoteClusters,
  buildSnapshotMetadata,
  decorateCurve,
  validateMonotonicity,
} from "./coherence.js";
import { formatRawAmount, isSuccessfulPoint, percentToBps } from "./decimalMath.js";
import { buildFocusedLadder, identifyDecisionBoundary } from "./inputNormalization.js";
import { collectQuoteSet } from "./quoteNormalization.js";
import { isCoherent } from "./recommendationPrimitives.js";
import type {
  FocusedRefreshStatus,
  PiteasAccumulationPlanDeps,
  PiteasAccumulationPlanInput,
  QuoteCollection,
  QuotePoint,
  QuoteScheduler,
  SnapshotLimits,
  SnapshotMetadata,
} from "./types.js";

export async function buildFocusedRefresh(input: {
  config: AppConfig;
  deps: PiteasAccumulationPlanDeps;
  scheduler: QuoteScheduler;
  input: PiteasAccumulationPlanInput;
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
  broadPoints: QuotePoint[];
}): Promise<Record<string, unknown>> {
  const focusedSizesRaw = buildFocusedLadder({
    explicitLadderHuman: input.input.focusedQuoteLadderHuman,
    broadPoints: input.broadPoints,
    totalBudgetRaw: input.totalBudgetRaw,
    decimals: input.eUsdcDecimals,
  });
  const collection = await collectQuoteSet({
    config: input.config,
    deps: input.deps,
    scheduler: input.scheduler,
    purpose: "focused_refresh",
    sizesRaw: focusedSizesRaw,
    eUsdcAddress: input.eUsdcAddress,
    phiatAddress: input.phiatAddress,
    account: input.account,
    allowedSlippagePercent: input.allowedSlippagePercent,
    eUsdcDecimals: input.eUsdcDecimals,
    phiatDecimals: input.phiatDecimals,
    thresholds: input.thresholds,
    maxGasCostBps: input.maxGasCostBps,
    strictDurationMs: input.snapshotLimits.focusedRefreshMaxDurationMs,
    allowRetries: false,
  });
  decorateCurve(collection.points, {
    eUsdcDecimals: input.eUsdcDecimals,
    phiatDecimals: input.phiatDecimals,
    thresholds: input.thresholds,
  });
  const snapshotMetadata = buildSnapshotMetadata(collection, input.snapshotLimits);
  const monotonicityChecks = validateMonotonicity(
    collection.points,
    snapshotMetadata,
    input.snapshotLimits,
    input.eUsdcDecimals,
    input.phiatDecimals,
  );
  const localQuoteClusters = buildLocalQuoteClusters({
    points: collection.points,
    purpose: "focused_refresh",
    limits: input.snapshotLimits,
    thresholds: input.thresholds,
    eUsdcDecimals: input.eUsdcDecimals,
    phiatDecimals: input.phiatDecimals,
    clusterPrefix: "focused",
  });
  const bestRouteEnvelope = buildBestRouteEnvelope({
    collection,
    source: "focused_refresh",
    limits: input.snapshotLimits,
    thresholds: input.thresholds,
    primaryThresholdBps: percentToBps(input.thresholds[0] ?? 2),
    eUsdcDecimals: input.eUsdcDecimals,
    phiatDecimals: input.phiatDecimals,
  });
  const complete =
    collection.failures.length === 0 &&
    collection.points.length === focusedSizesRaw.length &&
    collection.points.every(isSuccessfulPoint) &&
    snapshotMetadata.coherenceClass !== "stitched_multi_state" &&
    collection.points.every((point) => point.retryCount === 0);
  const focusedRefreshStatus = classifyFocusedRefresh({
    requestedCount: focusedSizesRaw.length,
    collection,
    snapshotMetadata,
  });
  return {
    description:
      "Fresh focused ladder around the broad discovery decision boundary. Failed points remain failures; no later retry is inserted into the original curve.",
    likelyDecisionBoundaryHuman: formatRawAmount(
      identifyDecisionBoundary(input.broadPoints, input.totalBudgetRaw),
      input.eUsdcDecimals,
    ),
    quoteSizeLadderHuman: focusedSizesRaw.map((size) =>
      formatRawAmount(size, input.eUsdcDecimals),
    ),
    strictTimeWindowMs: input.snapshotLimits.focusedRefreshMaxDurationMs,
    complete,
    focusedRefreshStatus,
    snapshotMetadata,
    monotonicityChecks,
    bestRouteEnvelope,
    executableQuoteDepth: collection.points,
    localQuoteClusters,
    partialFailures: collection.failures,
  };
}

function classifyFocusedRefresh(input: {
  requestedCount: number;
  collection: QuoteCollection;
  snapshotMetadata: SnapshotMetadata;
}): FocusedRefreshStatus {
  const successfulCount = input.collection.points.filter(isSuccessfulPoint).length;
  if (input.requestedCount === 0 || successfulCount === 0) return "failed";
  const complete =
    input.collection.failures.length === 0 &&
    input.collection.points.length === input.requestedCount &&
    successfulCount === input.requestedCount &&
    input.collection.points.every((point) => point.retryCount === 0);
  if (!complete) return "incomplete";
  return isCoherent(input.snapshotMetadata.coherenceClass)
    ? "complete_coherent"
    : "complete_incoherent";
}

export function focusedRefreshStatusFromPayload(
  focusedRefresh: Record<string, unknown> | null,
): FocusedRefreshStatus {
  if (!focusedRefresh) return "not_run";
  const status = focusedRefresh.focusedRefreshStatus;
  if (
    status === "complete_coherent" ||
    status === "complete_incoherent" ||
    status === "incomplete" ||
    status === "failed"
  ) {
    return status;
  }
  if (focusedRefresh.complete === true) return "complete_coherent";
  return "incomplete";
}
