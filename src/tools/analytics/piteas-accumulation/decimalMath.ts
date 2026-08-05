import { PRICE_SCALE_DECIMALS } from "./constants.js";
import type {
  PiteasAccumulationPlanDeps,
  QuotePoint,
  QuoteValidityFlags,
  Ratio,
  SuccessfulPoint,
} from "./types.js";

export function compareRatio(a: Ratio, b: Ratio): number {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function gasCostPercent(
  gasUseEstimateUSD: number | null,
  chunkInputRaw: bigint,
  eUsdcDecimals: number,
): { bps: bigint; percent: string } | null {
  if (gasUseEstimateUSD === null || chunkInputRaw <= 0n) return null;
  const gasRawScaled = parseHumanAmount(
    decimalNumberToString(gasUseEstimateUSD),
    PRICE_SCALE_DECIMALS,
    "gasUseEstimateUSD",
  );
  const chunkInputScaled =
    eUsdcDecimals <= PRICE_SCALE_DECIMALS
      ? chunkInputRaw * pow10(PRICE_SCALE_DECIMALS - eUsdcDecimals)
      : chunkInputRaw / pow10(eUsdcDecimals - PRICE_SCALE_DECIMALS);
  if (chunkInputScaled <= 0n) return null;
  const bps = (gasRawScaled * 10000n) / chunkInputScaled;
  return { bps, percent: formatBpsAsPercent(bps) };
}

export function priceRatio(
  inputRaw: bigint,
  outputRaw: bigint,
  inputDecimals: number,
  outputDecimals: number,
): Ratio | null {
  if (inputRaw <= 0n || outputRaw <= 0n) return null;
  return {
    numerator: inputRaw * pow10(outputDecimals),
    denominator: outputRaw * pow10(inputDecimals),
  };
}

export function percentChangeBps(current: Ratio, baseline: Ratio): bigint | null {
  const left = current.numerator * baseline.denominator;
  const right = baseline.numerator * current.denominator;
  if (right === 0n) return null;
  return ((left - right) * 10000n) / right;
}

export function formatRatio(ratio: Ratio, precision: number): string {
  return formatFixed((ratio.numerator * pow10(precision)) / ratio.denominator, precision);
}

export function formatBpsAsPercent(bps: bigint): string {
  const negative = bps < 0n;
  const abs = negative ? -bps : bps;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  const text = `${whole}.${fraction}`.replace(/\.?0+$/, "");
  return negative ? `-${text}` : text;
}

export function percentStringToBps(percent: string): bigint | null {
  try {
    return parseHumanAmount(percent, 2, "percent");
  } catch {
    return null;
  }
}

export function percentToBps(percent: number): bigint {
  return parseHumanAmount(decimalNumberToString(percent), 2, "percent");
}

export function parseHumanAmount(value: string, decimals: number, label: string): bigint {
  const raw = String(value ?? "").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    throw new Error(`${label} must be a non-negative decimal string`);
  }
  const [whole, frac = ""] = raw.split(".");
  if (frac.length > decimals) {
    throw new Error(`${label} has more than ${decimals} decimal places`);
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(`${whole}${padded}`.replace(/^0+(?=\d)/, "") || "0");
}

export function parseUnsignedRaw(value: string | null | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function parseBlockNumber(value: string | null | undefined): bigint | null {
  if (!value) return null;
  try {
    if (/^0x[a-fA-F0-9]+$/.test(value)) return BigInt(value);
    if (/^\d+$/.test(value)) return BigInt(value);
  } catch {
    return null;
  }
  return null;
}

export function formatRawAmount(raw: bigint, decimals: number): string {
  return formatFixed(raw, decimals);
}

export function formatFixed(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  if (decimals === 0) return `${negative ? "-" : ""}${abs.toString()}`;
  const scale = pow10(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

export function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

export function decimalNumberToString(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(12).replace(/\.?0+$/, "");
}

export function assertDecimals(decimals: number, label: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`${label} must be an integer between 0 and 36`);
  }
}

export function emptyValidityFlags(): QuoteValidityFlags {
  return {
    averagePriceImprovedAtLargerSize: false,
    marginalPriceAnomaly: false,
    outputNonMonotonic: false,
    minimumOutputNonMonotonic: false,
    cumulativeOutputNonPositive: false,
    marginalOutputNonPositive: false,
    staleQuote: false,
    routeDiscontinuity: false,
    snapshotDiscontinuity: false,
  };
}

export function isSuccessfulPoint(point: QuotePoint): point is SuccessfulPoint {
  return point.quoteReady && point.outputRaw !== null && point.outputHuman !== null;
}

export function currentMs(deps: PiteasAccumulationPlanDeps): number {
  return (deps.now?.() ?? new Date()).getTime();
}

export function nowIso(deps: PiteasAccumulationPlanDeps): string {
  return (deps.now?.() ?? new Date()).toISOString();
}

export function timestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function durationMs(start: string, end: string): number {
  const startMs = timestampMs(start);
  const endMs = timestampMs(end);
  if (startMs === null || endMs === null) return 0;
  return Math.max(0, endMs - startMs);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
