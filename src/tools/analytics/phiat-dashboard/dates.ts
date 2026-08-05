import { numberOrNull, round } from "./math.js";

export function timestampToIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const numeric = numberOrNull(value);
  if (numeric === null || numeric <= 0) return null;
  const ms = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function unixSecondsToIso(seconds: unknown): string | null {
  const numeric = numberOrNull(seconds);
  if (numeric === null || numeric <= 0) return null;
  return timestampToIso(numeric);
}

export function ageDaysFromIso(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return round(Math.max(0, Date.now() - ms) / 86_400_000, 2);
}
