/**
 * Precise PLS ↔ wei conversion for agent-wallet accounting.
 *
 * Source of truth for on-chain value and spend ledgers is integer wei (bigint).
 * Display PLS uses formatEther; policy caps are configured in PLS units but
 * comparisons run in wei after parsePlsToWei.
 *
 * Number inputs use JS default `String(n)` when it yields a clean decimal
 * (so JSON `0.1` → `"0.1"` → exact parseEther). Never use `toFixed(18)` —
 * that embeds IEEE-754 residue (e.g. 0.1 → 100000000000000006 wei).
 * Scientific notation is rejected; prefer string decimals for exact fractions.
 */

import { formatEther, parseEther } from "viem";
import { PolicyError } from "../utils/errors.js";
import type { DailySpendLedger } from "./types.js";

/** Strict decimal: optional integer part, optional fraction up to 18 digits. No exp. */
const PLS_DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Normalize a tool/API PLS amount into a clean decimal string for parseEther.
 * Rejects scientific notation, NaN, Infinity, negatives, and malformed decimals.
 */
export function normalizePlsDecimal(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PolicyError(
        "PLS amount must be a finite number (got NaN or Infinity)",
      );
    }
    if (value < 0) {
      throw new PolicyError("PLS amount must be >= 0");
    }
    if (Object.is(value, -0) || value === 0) {
      return "0";
    }
    // Safe integers: exact string form.
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) {
        throw new PolicyError(
          "PLS integer amount exceeds Number.MAX_SAFE_INTEGER; pass a decimal string instead",
        );
      }
      return String(value);
    }
    // Fractional numbers: use default String(n), NOT toFixed(18).
    // JSON/tool numbers like 0.1 stringify as "0.1" (clean) and match parseEther("0.1").
    // Scientific notation (1e-18) and non-decimal forms are rejected.
    const raw = String(value);
    if (/[eE]/.test(raw)) {
      throw new PolicyError(
        `PLS amount "${raw}" uses scientific notation or is too small/large for safe number conversion. ` +
          `Pass a plain decimal string (e.g. "0.000000000000000001") or a safe integer.`,
      );
    }
    if (!PLS_DECIMAL_RE.test(raw)) {
      throw new PolicyError(
        `PLS amount ${value} ("${raw}") cannot be represented as a clean decimal (max 18 fractional digits). ` +
          `Pass a plain decimal string for exact amounts.`,
      );
    }
    return raw;
  }

  if (typeof value !== "string") {
    throw new PolicyError("PLS amount must be a string or number");
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new PolicyError("PLS amount must not be empty");
  }
  if (/[eE]/.test(trimmed)) {
    throw new PolicyError(
      `PLS amount "${trimmed}" must not use scientific notation. Use a plain decimal string.`,
    );
  }
  if (trimmed.startsWith("-")) {
    throw new PolicyError("PLS amount must be >= 0");
  }
  if (!PLS_DECIMAL_RE.test(trimmed)) {
    throw new PolicyError(
      `Invalid PLS decimal "${trimmed}". Expected plain decimal with at most 18 fractional digits (e.g. "1.5", "0.0001").`,
    );
  }
  return trimmed;
}

/**
 * Convert a PLS amount (string or number) to integer wei.
 * Throws PolicyError on invalid / scientific / negative inputs.
 */
export function parsePlsToWei(value: string | number): bigint {
  const decimal = normalizePlsDecimal(value);
  if (decimal === "0") {
    return 0n;
  }
  try {
    return parseEther(decimal);
  } catch (err) {
    throw new PolicyError(
      `Invalid PLS amount for wei conversion: ${decimal}` +
        (err instanceof Error ? ` (${err.message})` : ""),
    );
  }
}

/** Display wei as a PLS decimal string (exact). */
export function weiToPlsDecimal(wei: bigint | string): string {
  const w = typeof wei === "bigint" ? wei : BigInt(wei);
  return formatEther(w);
}

/**
 * Approximate number for legacy display fields only.
 * Prefer weiToPlsDecimal for exact display.
 */
export function weiToPlsNumber(wei: bigint | string): number {
  const d = weiToPlsDecimal(wei);
  const n = Number(d);
  return Number.isFinite(n) ? n : 0;
}

/** Read spend as wei; migrate legacy spentPls-only ledgers. */
export function getSpendWei(ledger: DailySpendLedger): bigint {
  if (ledger.spentWei !== undefined && ledger.spentWei !== "") {
    try {
      const w = BigInt(ledger.spentWei);
      return w < 0n ? 0n : w;
    } catch {
      // fall through
    }
  }
  if (
    typeof ledger.spentPls === "number" &&
    Number.isFinite(ledger.spentPls) &&
    ledger.spentPls > 0
  ) {
    try {
      return parsePlsToWei(ledger.spentPls);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Normalize ledger for current UTC day and ensure spentWei is populated.
 * spentPls is kept as display/compat.
 */
export function normalizeDailySpendWei(
  ledger: DailySpendLedger,
  now = new Date(),
): DailySpendLedger {
  const today = utcDay(now);
  if (ledger.date !== today) {
    return { date: today, spentPls: 0, spentWei: "0" };
  }
  const wei = getSpendWei(ledger);
  return {
    date: today,
    spentWei: wei.toString(),
    spentPls: weiToPlsNumber(wei),
  };
}

/** Add amountWei to a daily ledger (same UTC day). */
export function addSpendWei(
  ledger: DailySpendLedger,
  amountWei: bigint,
  now = new Date(),
): DailySpendLedger {
  const base = normalizeDailySpendWei(ledger, now);
  if (amountWei < 0n) {
    throw new PolicyError("Cannot add negative spend");
  }
  const next = getSpendWei(base) + amountWei;
  return {
    date: base.date,
    spentWei: next.toString(),
    spentPls: weiToPlsNumber(next),
  };
}

/** Convert a PLS-unit policy cap to wei for comparison. */
export function capPlsToWei(capPls: number): bigint {
  if (!Number.isFinite(capPls) || capPls < 0) {
    throw new PolicyError("Policy cap must be a finite number >= 0");
  }
  // Integer caps (common) stay exact; fractional caps use number path.
  return parsePlsToWei(capPls);
}
