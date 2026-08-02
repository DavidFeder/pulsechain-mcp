import { PRICE_SCALE_DECIMALS, SAME_STATE_WARNING } from "./constants.js";
import { parseHumanAmount, percentStringToBps, percentToBps } from "./decimalMath.js";
import type { SuccessfulPoint } from "./types.js";

export function buildStopRules(
  primaryThresholdPercent: number,
  maximumAveragePrice: string | null,
  maxGasCostPercentOfChunk: number | null,
): string[] {
  const rules = [
    "Re-quote before every execution.",
    SAME_STATE_WARNING,
    `Stop if Piteas-reported price impact or computed price deterioration exceeds ${primaryThresholdPercent}%.`,
    "Stop if the route composition changes and review the new route before continuing.",
    "Stop if a fresh quote returns null, zero, or unavailable minimum output.",
  ];
  if (maximumAveragePrice !== null) {
    rules.push(
      `Stop if average execution price exceeds ${maximumAveragePrice} eUSDC per PHIAT.`,
    );
  }
  if (maxGasCostPercentOfChunk !== null) {
    rules.push(
      `Stop if gas estimate exceeds ${maxGasCostPercentOfChunk}% of the chunk budget.`,
    );
  }
  return rules;
}

export function stopReasonsForPoint(
  point: SuccessfulPoint,
  primaryThresholdBps: bigint,
  maximumAveragePriceRaw: bigint | null,
): string[] {
  const reasons: string[] = [];
  const deteriorationBps = point.priceDeteriorationPercent
    ? percentStringToBps(point.priceDeteriorationPercent)
    : null;
  const piteasImpactBps =
    point.piteasReportedPriceImpactPercent !== null
      ? percentToBps(point.piteasReportedPriceImpactPercent)
      : null;
  if (
    (deteriorationBps !== null && deteriorationBps >= primaryThresholdBps) ||
    (piteasImpactBps !== null && piteasImpactBps >= primaryThresholdBps)
  ) {
    reasons.push("price_impact_threshold_crossed");
  }
  if (maximumAveragePriceRaw !== null) {
    const avgRaw = point.averagePrice
      ? parseHumanAmount(point.averagePrice, PRICE_SCALE_DECIMALS, "averagePrice")
      : null;
    if (avgRaw !== null && avgRaw > maximumAveragePriceRaw) {
      reasons.push("maximum_average_price_exceeded");
    }
  }
  if (point.routeChangedFromPreviousInCluster) {
    reasons.push("route_changed");
  }
  if (point.gasWarning) {
    reasons.push("gas_cost_threshold_exceeded");
  }
  if (point.minimumOutputRaw === null || point.minimumOutputRaw === "0") {
    reasons.push("minimum_output_unavailable");
  }
  return reasons;
}
