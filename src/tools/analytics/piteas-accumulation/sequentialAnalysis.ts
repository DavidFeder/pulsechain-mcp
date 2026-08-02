import { PRICE_SCALE_DECIMALS, SAME_STATE_WARNING } from "./constants.js";
import {
  formatRawAmount,
  formatRatio,
  parseUnsignedRaw,
  priceRatio,
} from "./decimalMath.js";
import { stopReasonsForPoint } from "./operationalGuardrails.js";
import type { SuccessfulPoint } from "./types.js";

export function buildIndependentQuoteComparison(
  points: SuccessfulPoint[],
  totalBudgetRaw: bigint,
  eUsdcDecimals: number,
  phiatDecimals: number,
): Array<Record<string, unknown>> {
  return points.map((point) => {
    const inputRaw = BigInt(point.inputRaw);
    const outputRaw = BigInt(point.outputRaw);
    const fullChunks = inputRaw > 0n ? totalBudgetRaw / inputRaw : 0n;
    const remainderRaw = inputRaw > 0n ? totalBudgetRaw % inputRaw : totalBudgetRaw;
    const repeatedOutputRaw = outputRaw * fullChunks;
    return {
      chunkInputRaw: point.inputRaw,
      chunkInputHuman: point.inputHuman,
      sameStateSingleQuoteOutputRaw: point.outputRaw,
      sameStateSingleQuoteOutputHuman: point.outputHuman,
      sameStateFullChunksToBudget: fullChunks.toString(),
      sameStateRemainderBudgetRaw: remainderRaw.toString(),
      sameStateRemainderBudgetHuman: formatRawAmount(remainderRaw, eUsdcDecimals),
      sameStateRepeatedOutputExcludingRemainderRaw: repeatedOutputRaw.toString(),
      sameStateRepeatedOutputExcludingRemainderHuman: formatRawAmount(
        repeatedOutputRaw,
        phiatDecimals,
      ),
      averagePrice: point.averagePrice,
      warning: SAME_STATE_WARNING,
      independentTotalIsSequentialForecast: false,
    };
  });
}

export function buildConservativeSequentialEstimate(
  points: SuccessfulPoint[],
  totalBudgetRaw: bigint,
  eUsdcDecimals: number,
  phiatDecimals: number,
  primaryThresholdBps: bigint,
  maximumAveragePriceRaw: bigint | null,
): Record<string, unknown> {
  const rows: Array<Record<string, unknown>> = [];
  let previous: SuccessfulPoint | null = null;
  let selectedBudgetRaw = 0n;
  let selectedOutputRaw = 0n;
  let selectedMinimumRaw: bigint | null = 0n;
  let stopped = false;
  let stoppedBeforeQuoteSizeHuman: string | null = null;
  let stopReasons: string[] = [];
  let sumOfIncrementalOutputs = 0n;

  for (const point of points) {
    const currentInputRaw = BigInt(point.inputRaw);
    const currentOutputRaw = BigInt(point.outputRaw);
    const currentMinRaw = parseUnsignedRaw(point.minimumOutputRaw);
    const prevInputRaw = previous ? BigInt(previous.inputRaw) : 0n;
    const prevOutputRaw = previous ? BigInt(previous.outputRaw) : 0n;
    const prevMinRaw = previous ? parseUnsignedRaw(previous.minimumOutputRaw) : 0n;
    const chunkInputRaw = currentInputRaw - prevInputRaw;
    const incrementalOutputRaw = currentOutputRaw - prevOutputRaw;
    const incrementalMinRaw =
      currentMinRaw !== null && prevMinRaw !== null ? currentMinRaw - prevMinRaw : null;
    const stop = stopReasonsForPoint(point, primaryThresholdBps, maximumAveragePriceRaw);
    if (incrementalOutputRaw > 0n) sumOfIncrementalOutputs += incrementalOutputRaw;
    rows.push({
      step: rows.length + 1,
      cumulativeInputRaw: point.inputRaw,
      cumulativeInputHuman: point.inputHuman,
      chunkInputRaw: chunkInputRaw.toString(),
      chunkInputHuman: formatRawAmount(chunkInputRaw, eUsdcDecimals),
      cumulativeOutputRaw: point.outputRaw,
      cumulativeOutputHuman: point.outputHuman,
      incrementalOutputRaw:
        incrementalOutputRaw >= 0n ? incrementalOutputRaw.toString() : null,
      incrementalOutputHuman:
        incrementalOutputRaw >= 0n
          ? formatRawAmount(incrementalOutputRaw, phiatDecimals)
          : null,
      incrementalMinimumOutputRaw:
        incrementalMinRaw !== null && incrementalMinRaw >= 0n
          ? incrementalMinRaw.toString()
          : null,
      incrementalMinimumOutputHuman:
        incrementalMinRaw !== null && incrementalMinRaw >= 0n
          ? formatRawAmount(incrementalMinRaw, phiatDecimals)
          : null,
      incrementalAveragePrice:
        incrementalOutputRaw > 0n
          ? formatRatio(
              priceRatio(
                chunkInputRaw,
                incrementalOutputRaw,
                eUsdcDecimals,
                phiatDecimals,
              )!,
              PRICE_SCALE_DECIMALS,
            )
          : null,
      stopTriggered: stop.length > 0,
      stopReasons: stop,
    });
    if (!stopped && stop.length === 0) {
      selectedBudgetRaw = currentInputRaw;
      selectedOutputRaw = currentOutputRaw;
      selectedMinimumRaw = currentMinRaw;
    } else if (!stopped && stop.length > 0) {
      stopped = true;
      stoppedBeforeQuoteSizeHuman = point.inputHuman;
      stopReasons = stop;
    }
    previous = point;
  }

  const cumulativeCurveTotal = points.at(-1) ?? null;
  const firstPoint = points[0] ?? null;
  const independentRepeatedQuoteTotalRaw =
    firstPoint && BigInt(firstPoint.inputRaw) > 0n
      ? BigInt(firstPoint.outputRaw) * (totalBudgetRaw / BigInt(firstPoint.inputRaw))
      : null;

  return {
    method:
      "incrementalOutput(k) = Q(k * chunkSize) - Q((k - 1) * chunkSize), using adjacent cumulative Piteas quotes from one compatible curve.",
    warning: SAME_STATE_WARNING,
    rows,
    selectedBudgetRaw: selectedBudgetRaw.toString(),
    selectedBudgetHuman: formatRawAmount(selectedBudgetRaw, eUsdcDecimals),
    estimatedOutputRaw: selectedOutputRaw.toString(),
    estimatedOutputHuman: formatRawAmount(selectedOutputRaw, phiatDecimals),
    minimumOutputRaw: selectedMinimumRaw?.toString() ?? null,
    minimumOutputHuman:
      selectedMinimumRaw !== null
        ? formatRawAmount(selectedMinimumRaw, phiatDecimals)
        : null,
    stoppedBeforeQuoteSizeHuman,
    stopReasons,
    cumulativeCurveTotal: cumulativeCurveTotal
      ? {
          inputRaw: cumulativeCurveTotal.inputRaw,
          inputHuman: cumulativeCurveTotal.inputHuman,
          outputRaw: cumulativeCurveTotal.outputRaw,
          outputHuman: cumulativeCurveTotal.outputHuman,
        }
      : null,
    sumOfIncrementalOutputsRaw: sumOfIncrementalOutputs.toString(),
    sumOfIncrementalOutputsHuman: formatRawAmount(sumOfIncrementalOutputs, phiatDecimals),
    telescopingEqualityVerified:
      cumulativeCurveTotal !== null &&
      sumOfIncrementalOutputs === BigInt(cumulativeCurveTotal.outputRaw),
    independentRepeatedQuoteTotalRaw: independentRepeatedQuoteTotalRaw?.toString() ?? null,
    independentRepeatedQuoteTotalHuman:
      independentRepeatedQuoteTotalRaw !== null
        ? formatRawAmount(independentRepeatedQuoteTotalRaw, phiatDecimals)
        : null,
    independentTotalIsSequentialForecast: false,
  };
}
