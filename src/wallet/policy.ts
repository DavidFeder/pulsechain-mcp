/**
 * Wallet send checks.
 *
 * Product model: if an operator enables wallets and funds an agent EOA, that is
 * authorization to sign. There are no spend caps or allowlists.
 *
 * Hard blocks:
 * - kill switch (killed=true)
 * - soft disable (enabled=false)
 * - invalid destination address or unparseable value
 *
 * Token-notional decode is attached for review visibility only.
 */

import { PolicyError } from "../utils/errors.js";
import { assertAddress } from "../utils/safety.js";
import type {
  AgentWalletPolicy,
  DailySpendLedger,
  PolicyCheckResult,
  TokenNotionalPolicyView,
} from "./types.js";
import {
  getSpendWei,
  normalizeDailySpendWei,
  parsePlsToWei,
  weiToPlsNumber,
} from "./value.js";
import {
  inspectTokenNotional,
  isEmptyData,
} from "./tokenNotional.js";

export { isEmptyData };

export function utcDateString(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Reset daily ledger if the UTC day rolled over; ensure spentWei is set. */
export function normalizeDailySpend(
  ledger: DailySpendLedger,
  now = new Date(),
): DailySpendLedger {
  return normalizeDailySpendWei(ledger, now);
}

/** Normalize all per-destination daily ledgers for the current UTC day. */
export function normalizeTokenDailySpend(
  map: Record<string, DailySpendLedger> | undefined,
  now = new Date(),
): Record<string, DailySpendLedger> {
  if (!map) return {};
  const out: Record<string, DailySpendLedger> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k.toLowerCase()] = normalizeDailySpend(v, now);
  }
  return out;
}

export interface PolicyEvalInput {
  policy: AgentWalletPolicy;
  dailySpend: DailySpendLedger;
  /** Per-destination daily ledgers (optional; spend accounting only) */
  tokenDailySpend?: Record<string, DailySpendLedger>;
  to: string;
  /**
   * Native value: prefer `valueWei` when known (exact). Else `valuePls`
   * (string|number) is converted via parsePlsToWei.
   */
  valuePls?: number | string;
  /** Exact native value in wei — preferred for math when present. */
  valueWei?: bigint | string;
  data?: string;
  /** True if eth_getCode(to) is non-empty */
  destinationIsContract: boolean;
  now?: Date;
}

function resolveValueWei(input: PolicyEvalInput): {
  valueWei: bigint;
  valuePlsDisplay: number;
  parseError?: string;
} {
  if (input.valueWei !== undefined && input.valueWei !== "") {
    try {
      const w =
        typeof input.valueWei === "bigint"
          ? input.valueWei
          : BigInt(input.valueWei);
      if (w < 0n) {
        return {
          valueWei: 0n,
          valuePlsDisplay: 0,
          parseError: "valueWei must be >= 0",
        };
      }
      return { valueWei: w, valuePlsDisplay: weiToPlsNumber(w) };
    } catch {
      return {
        valueWei: 0n,
        valuePlsDisplay: 0,
        parseError: "valueWei is not a valid integer",
      };
    }
  }
  const raw = input.valuePls ?? 0;
  try {
    const w = parsePlsToWei(raw as string | number);
    return { valueWei: w, valuePlsDisplay: weiToPlsNumber(w) };
  } catch (err) {
    return {
      valueWei: 0n,
      valuePlsDisplay: 0,
      parseError:
        err instanceof Error ? err.message : "Invalid valuePls / valueWei",
    };
  }
}

function tokenNotionalView(
  inspection: ReturnType<typeof inspectTokenNotional>,
): TokenNotionalPolicyView {
  return {
    considered: inspection.considered,
    confidence: inspection.confidence,
    pattern: inspection.pattern,
    reliable: inspection.reliable,
    riskRelevant: inspection.riskRelevant,
    knownPulsexRouter: inspection.knownPulsexRouter,
    multicallExpanded: inspection.multicallExpanded === true,
    innerCallCount: inspection.innerCallCount,
    innerUnreliableCount: inspection.innerUnreliableCount,
    movements: inspection.movements.map((m) => ({
      token: m.token,
      amountRaw: m.amountRaw,
      role: m.role,
      recipient: m.recipient,
      spender: m.spender,
      from: m.from,
      path: m.path,
      fromMulticall: m.fromMulticall,
      multicallIndex: m.multicallIndex,
    })),
    notes: [
      ...inspection.notes,
      "Decode only — funding the agent is authorization; this inspection does not block sends.",
    ],
  };
}

/**
 * Send check for a proposed tx.
 * Does not throw — returns structured allow/deny with reasons.
 *
 * Deny only: kill switch, enabled=false, invalid address, unparseable value.
 */
export function evaluatePolicy(input: PolicyEvalInput): PolicyCheckResult {
  const now = input.now ?? new Date();
  const ledger = normalizeDailySpend(input.dailySpend, now);
  const reasons: string[] = [];
  const { valueWei, valuePlsDisplay, parseError } = resolveValueWei(input);
  const valuePls = valuePlsDisplay;
  const spentWei = getSpendWei(ledger);
  const projectedWei = spentWei + valueWei;
  const projected = weiToPlsNumber(projectedWei);

  const isContractInteraction =
    input.destinationIsContract || !isEmptyData(input.data);

  if (input.policy.killed) {
    reasons.push(
      "Wallet kill switch is active (killed=true). Signing disabled until cleared via set_agent_policy (killed=false + enabled=true).",
    );
  }
  if (!input.policy.enabled) {
    reasons.push("Wallet signing is disabled (enabled=false).");
  }

  if (parseError) {
    reasons.push(parseError);
  }

  let toNorm: string | undefined;
  try {
    toNorm = assertAddress(input.to).toLowerCase();
  } catch {
    reasons.push(`Invalid to address: ${input.to}`);
  }

  const inspection = inspectTokenNotional({
    to: toNorm ?? input.to,
    data: input.data,
    valueWei,
  });

  return {
    allowed: reasons.length === 0,
    reasons,
    isContractInteraction,
    destinationIsContract: input.destinationIsContract,
    valuePls,
    valueWei: valueWei.toString(),
    projectedDailySpend: projected,
    projectedDailySpendWei: projectedWei.toString(),
    tokenNotional: tokenNotionalView(inspection),
  };
}

/** Throw PolicyError if kill/disabled/invalid. */
export function assertPolicyAllows(check: PolicyCheckResult): void {
  if (!check.allowed) {
    throw new PolicyError(
      `Wallet write blocked: ${check.reasons.join("; ")}`,
    );
  }
}

export function mergePolicy(
  current: AgentWalletPolicy,
  patch: Partial<AgentWalletPolicy>,
): AgentWalletPolicy {
  const next: AgentWalletPolicy = {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    killed: patch.killed !== undefined ? patch.killed : current.killed,
  };

  // Clearing killed requires explicit enabled=true in same update
  if (current.killed && patch.killed === false) {
    if (patch.enabled !== true) {
      throw new PolicyError(
        "To clear kill switch, set killed=false and enabled=true together",
      );
    }
  }

  return next;
}

/**
 * Load on-disk policy. Older records may still contain unused cap/allowlist
 * fields — those are ignored.
 */
export function normalizePolicy(
  policy: Partial<AgentWalletPolicy> | Record<string, unknown> | undefined,
): AgentWalletPolicy {
  const p = policy ?? {};
  return {
    enabled: p.enabled !== false,
    killed: p.killed === true,
  };
}
