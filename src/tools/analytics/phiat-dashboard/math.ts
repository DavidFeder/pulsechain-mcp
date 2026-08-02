import { formatUnits } from "viem";
import type { PartialFailure } from "./builder.js";

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function formatRawUnits(raw: string | null, decimals: number | null): string | null {
  if (raw === null || decimals === null) return null;
  try {
    return formatUnits(parseRawBigInt(raw), decimals);
  } catch {
    return null;
  }
}

export function parseRawBigInt(raw: string | null): bigint {
  if (!raw) return 0n;
  try {
    return BigInt(raw.split(".")[0] ?? "0");
  } catch {
    return 0n;
  }
}

export function parseStrictRawBigInt(raw: string | null): bigint | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

export function integerOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  if (n === null || !Number.isInteger(n)) return null;
  return n >= 0 && n <= 36 ? n : null;
}

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(n) ? n : null;
}

export function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === "" ? null : s;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function dedupeFailures(failures: PartialFailure[]): PartialFailure[] {
  const seen = new Set<string>();
  const out: PartialFailure[] = [];
  for (const failure of failures) {
    const key = `${failure.source}:${failure.error}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(failure);
  }
  return out;
}
