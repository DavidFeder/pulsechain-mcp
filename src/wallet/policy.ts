/**
 * Operator-trust wallet checks (v0.1.38+).
 *
 * Product model: if an operator enables wallets and funds an agent EOA, that is
 * authorization to sign. This module is NOT a custody-policy product.
 *
 * Hard blocks always (operator emergency / technical):
 * - kill switch (killed=true)
 * - soft disable (enabled=false)
 * - invalid destination address or unparseable value
 *
 * Historical fields (maxPlsPerTx/daily, allowlists, token-notional caps,
 * requireDecodableCalldata, allowNativeTransfers) are stored and reported for
 * compatibility. They are NOT hard gates unless PolicyEvalInput.enforceLegacyCaps
 * is true (threaded from AppConfig.agentWalletEnforceLegacyCaps / env
 * AGENT_WALLET_ENFORCE_LEGACY_CAPS). Do not read process.env here.
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
  capPlsToWei,
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

/** Normalize all per-token daily ledgers for the current UTC day. */
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

/**
 * True when allowlistExpiresAt is set and current time is at/after expiry.
 * Kept for status/display of legacy fields — not used as a hard deny.
 */
export function isAllowlistExpired(
  policy: AgentWalletPolicy,
  now = new Date(),
): boolean {
  const exp = policy.allowlistExpiresAt;
  if (exp === undefined || exp === null || exp === "") return false;
  const t = Date.parse(exp);
  if (!Number.isFinite(t)) return true;
  return now.getTime() >= t;
}

/** Effective contract allowlist (empty when expired). Legacy field accessor. */
export function effectiveContractAllowlist(
  policy: AgentWalletPolicy,
  now = new Date(),
): `0x${string}`[] {
  if (isAllowlistExpired(policy, now)) return [];
  return policy.contractAllowlist;
}

/** Effective token allowlist (empty when expired). Legacy field accessor. */
export function effectiveTokenAllowlist(
  policy: AgentWalletPolicy,
  now = new Date(),
): `0x${string}`[] {
  if (isAllowlistExpired(policy, now)) return [];
  return policy.tokenAllowlist;
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
  /**
   * When true, stored legacy fields become hard denies. Must be passed from
   * AppConfig — never read process.env in this module.
   */
  enforceLegacyCaps?: boolean;
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

/**
 * Operator-trust check for a proposed tx.
 * Does not throw — returns structured allow/deny with reasons.
 *
 * Always hard-deny: kill switch, enabled=false, invalid address, unparseable value.
 * Caps, allowlists, and token-notional rules are blocking only when
 * input.enforceLegacyCaps is true (AppConfig.agentWalletEnforceLegacyCaps).
 * Spend projections remain for operator visibility in both modes.
 */
export function evaluatePolicy(input: PolicyEvalInput): PolicyCheckResult {
  const now = input.now ?? new Date();
  const enforce = input.enforceLegacyCaps === true;
  const ledger = normalizeDailySpend(input.dailySpend, now);
  const reasons: string[] = [];
  const { valueWei, valuePlsDisplay, parseError } = resolveValueWei(input);
  const valuePls = valuePlsDisplay;
  const spentWei = getSpendWei(ledger);
  const projectedWei = spentWei + valueWei;
  // remainingDaily reports headroom vs stored maxPlsDaily (same wei math in both
  // modes). When enforce is off this is display-only; when on, over-cap denies.
  let remainingWei: bigint;
  let maxDailyWei: bigint | undefined;
  try {
    maxDailyWei = capPlsToWei(input.policy.maxPlsDaily);
    remainingWei =
      projectedWei >= maxDailyWei ? 0n : maxDailyWei - projectedWei;
  } catch {
    remainingWei = 0n;
  }
  const projected = weiToPlsNumber(projectedWei);
  const remaining = weiToPlsNumber(remainingWei);
  const allowlistExpired = isAllowlistExpired(input.policy, now);

  const isContractInteraction =
    input.destinationIsContract || !isEmptyData(input.data);

  // --- Always-on operator emergency / technical controls ---
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

  let capsApplied: TokenNotionalPolicyView["capsApplied"] = [];
  let requireDecodableDenied = false;

  if (enforce && !parseError) {
    applyLegacyCapDenies({
      policy: input.policy,
      toNorm,
      valueWei,
      projectedWei,
      maxDailyWei,
      isContractInteraction,
      allowlistExpired,
      tokenDailySpend: input.tokenDailySpend,
      now,
      reasons,
    });
    if (inspection.reliable) {
      const applied = applyErc20NotionalCaps(
        inspection,
        input.policy.erc20NotionalCaps ?? {},
      );
      capsApplied = applied.capsApplied;
      reasons.push(...applied.overReasons);
    }
    if (
      input.policy.requireDecodableCalldata === true &&
      !inspection.reliable
    ) {
      requireDecodableDenied = true;
      reasons.push(
        `requireDecodableCalldata is set and calldata is not reliably decodable (pattern=${inspection.pattern}).`,
      );
    }
  }

  const tokenNotional: TokenNotionalPolicyView = {
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
      enforce
        ? "This process is enforcing stored legacy caps/allowlists (opt-in AGENT_WALLET_ENFORCE_LEGACY_CAPS). Product default remains operator-trust / display-only when that env is unset."
        : "Operator-trust mode: allowlists, PLS caps, and token-notional rules are not hard gates. Funding the agent is authorization.",
    ],
    capsApplied,
    requireDecodableCalldata: requireDecodableDenied,
  };

  return {
    allowed: reasons.length === 0,
    reasons,
    isContractInteraction,
    destinationIsContract: input.destinationIsContract,
    valuePls,
    valueWei: valueWei.toString(),
    projectedDailySpend: projected,
    projectedDailySpendWei: projectedWei.toString(),
    remainingDaily: remaining,
    remainingDailyWei: remainingWei.toString(),
    legacyCapsDisplayOnly: !enforce,
    allowlistExpired,
    tokenNotional,
  };
}

function applyLegacyCapDenies(args: {
  policy: AgentWalletPolicy;
  toNorm: string | undefined;
  valueWei: bigint;
  projectedWei: bigint;
  maxDailyWei: bigint | undefined;
  isContractInteraction: boolean;
  allowlistExpired: boolean;
  tokenDailySpend: Record<string, DailySpendLedger> | undefined;
  now: Date;
  reasons: string[];
}): void {
  const {
    policy,
    toNorm,
    valueWei,
    projectedWei,
    maxDailyWei,
    isContractInteraction,
    allowlistExpired,
    tokenDailySpend,
    now,
    reasons,
  } = args;

  try {
    const maxTxWei = capPlsToWei(policy.maxPlsPerTx);
    if (valueWei > maxTxWei) {
      reasons.push(
        `Native value exceeds maxPlsPerTx (${policy.maxPlsPerTx} PLS).`,
      );
    }
  } catch {
    reasons.push("maxPlsPerTx is not a valid PLS cap (fail closed).");
  }

  if (maxDailyWei === undefined) {
    reasons.push("maxPlsDaily is not a valid PLS cap (fail closed).");
  } else if (projectedWei > maxDailyWei) {
    reasons.push(
      `Projected daily spend exceeds maxPlsDaily (${policy.maxPlsDaily} PLS).`,
    );
  }

  if (policy.allowNativeTransfers === false && !isContractInteraction) {
    reasons.push(
      "Native PLS transfers are disabled (allowNativeTransfers=false).",
    );
  }

  if (!toNorm) {
    return;
  }

  const contractList = effectiveContractAllowlist(policy, now);
  const tokenList = effectiveTokenAllowlist(policy, now);

  if (isContractInteraction) {
    const onList = contractList.some((a) => a.toLowerCase() === toNorm);
    if (!onList) {
      if (allowlistExpired) {
        reasons.push(
          "Allowlist expired (allowlistExpiresAt); destination is not on the effective contractAllowlist.",
        );
      }
      reasons.push(
        contractList.length === 0
          ? `Destination ${toNorm} is not on contractAllowlist (empty list).`
          : `Destination ${toNorm} is not on contractAllowlist.`,
      );
    }
  }

  if (policy.tokenAllowlist.length > 0) {
    const onList = tokenList.some((a) => a.toLowerCase() === toNorm);
    if (!onList) {
      if (allowlistExpired) {
        reasons.push(
          "Allowlist expired (allowlistExpiresAt); destination is not on tokenAllowlist.",
        );
      } else {
        reasons.push(`Destination ${toNorm} is not on tokenAllowlist.`);
      }
    }
  }

  const spendCap = policy.tokenSpendCaps[toNorm];
  if (spendCap !== undefined) {
    try {
      const capWei = capPlsToWei(spendCap);
      if (valueWei > capWei) {
        reasons.push(
          `Native value exceeds tokenSpendCaps[${toNorm}] (${spendCap} PLS).`,
        );
      }
    } catch {
      reasons.push(
        `tokenSpendCaps[${toNorm}] is not a valid PLS cap (fail closed).`,
      );
    }
  }

  const dailyCap = policy.tokenDailyCaps[toNorm];
  if (dailyCap !== undefined) {
    const destLedger = normalizeDailySpend(
      tokenDailySpend?.[toNorm] ?? {
        date: utcDateString(now),
        spentPls: 0,
      },
      now,
    );
    const destProjected = getSpendWei(destLedger) + valueWei;
    try {
      const capWei = capPlsToWei(dailyCap);
      if (destProjected > capWei) {
        reasons.push(
          `Projected destination daily spend exceeds tokenDailyCaps[${toNorm}] (${dailyCap} PLS).`,
        );
      }
    } catch {
      reasons.push(
        `tokenDailyCaps[${toNorm}] is not a valid PLS cap (fail closed).`,
      );
    }
  }
}

function applyErc20NotionalCaps(
  inspection: ReturnType<typeof inspectTokenNotional>,
  caps: Record<string, string>,
): {
  capsApplied: TokenNotionalPolicyView["capsApplied"];
  overReasons: string[];
} {
  const sums = new Map<string, bigint>();
  for (const m of inspection.movements) {
    const key = m.token === "native" ? "native" : m.token.toLowerCase();
    let amt: bigint;
    try {
      amt = BigInt(m.amountRaw);
    } catch {
      continue;
    }
    if (amt < 0n) continue;
    sums.set(key, (sums.get(key) ?? 0n) + amt);
  }
  const capsApplied: TokenNotionalPolicyView["capsApplied"] = [];
  const overReasons: string[] = [];
  for (const [token, amount] of sums) {
    const capRaw = caps[token];
    if (capRaw === undefined) continue;
    let cap: bigint;
    try {
      cap = BigInt(capRaw);
    } catch {
      overReasons.push(
        `erc20NotionalCaps[${token}] is not a valid integer (fail closed).`,
      );
      continue;
    }
    const withinCap = amount <= cap;
    capsApplied.push({
      token,
      amountRaw: amount.toString(),
      capRaw,
      withinCap,
    });
    if (!withinCap) {
      overReasons.push(
        `Token notional ${amount.toString()} raw exceeds erc20NotionalCaps[${token}]=${capRaw}`,
      );
    }
  }
  return { capsApplied, overReasons };
}

/** Throw PolicyError if check fails (kill/disabled/invalid, or opt-in legacy caps). */
export function assertPolicyAllows(check: PolicyCheckResult): void {
  if (!check.allowed) {
    throw new PolicyError(
      `Wallet write blocked: ${check.reasons.join("; ")}`,
    );
  }
}

function normalizeCapMap(
  map: Record<string, number> | undefined,
): Record<string, number> {
  if (!map) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(map)) {
    if (!Number.isFinite(v) || v < 0) {
      throw new PolicyError(
        `Cap for ${k} must be a finite number >= 0`,
      );
    }
    out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Normalize erc20 notional cap map values to integer decimal strings.
 * Legacy setter validation only — not enforced at send time.
 */
export function normalizeErc20NotionalCapMap(
  map: Record<string, string> | undefined,
): Record<string, string> {
  if (!map) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    const key = k === "native" ? "native" : k.toLowerCase();
    const s = String(v).trim();
    if (!/^\d+$/.test(s)) {
      throw new PolicyError(
        `erc20NotionalCaps[${key}] must be a non-negative integer decimal string`,
      );
    }
    out[key] = s;
  }
  return out;
}

export function mergePolicy(
  current: AgentWalletPolicy,
  patch: Partial<AgentWalletPolicy>,
): AgentWalletPolicy {
  const next: AgentWalletPolicy = {
    ...current,
    ...patch,
    contractAllowlist:
      patch.contractAllowlist !== undefined
        ? patch.contractAllowlist.map((a) => assertAddress(a))
        : current.contractAllowlist,
    tokenAllowlist:
      patch.tokenAllowlist !== undefined
        ? patch.tokenAllowlist.map((a) => assertAddress(a))
        : current.tokenAllowlist,
    tokenSpendCaps:
      patch.tokenSpendCaps !== undefined
        ? normalizeCapMap(patch.tokenSpendCaps)
        : { ...(current.tokenSpendCaps ?? {}) },
    tokenDailyCaps:
      patch.tokenDailyCaps !== undefined
        ? normalizeCapMap(patch.tokenDailyCaps)
        : { ...(current.tokenDailyCaps ?? {}) },
    erc20NotionalCaps:
      patch.erc20NotionalCaps !== undefined
        ? normalizeErc20NotionalCapMap(patch.erc20NotionalCaps)
        : { ...(current.erc20NotionalCaps ?? {}) },
    requireDecodableCalldata:
      patch.requireDecodableCalldata !== undefined
        ? patch.requireDecodableCalldata === true
        : current.requireDecodableCalldata === true,
    allowlistExpiresAt:
      patch.allowlistExpiresAt !== undefined
        ? patch.allowlistExpiresAt
        : current.allowlistExpiresAt ?? null,
  };

  if (
    patch.maxPlsPerTx !== undefined &&
    (!Number.isFinite(patch.maxPlsPerTx) || patch.maxPlsPerTx < 0)
  ) {
    throw new PolicyError("maxPlsPerTx must be a finite number >= 0");
  }
  if (
    patch.maxPlsDaily !== undefined &&
    (!Number.isFinite(patch.maxPlsDaily) || patch.maxPlsDaily < 0)
  ) {
    throw new PolicyError("maxPlsDaily must be a finite number >= 0");
  }
  // Soft consistency only — not an enforcement surface
  if (next.maxPlsPerTx > next.maxPlsDaily) {
    throw new PolicyError("maxPlsPerTx cannot exceed maxPlsDaily");
  }

  if (
    next.allowlistExpiresAt !== undefined &&
    next.allowlistExpiresAt !== null &&
    next.allowlistExpiresAt !== ""
  ) {
    const t = Date.parse(next.allowlistExpiresAt);
    if (!Number.isFinite(t)) {
      throw new PolicyError(
        "allowlistExpiresAt must be a valid ISO-8601 timestamp or null",
      );
    }
  }

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
 * Migrate older on-disk wallet records missing new policy fields.
 */
export function normalizePolicy(
  policy: Partial<AgentWalletPolicy> & {
    maxPlsPerTx: number;
    maxPlsDaily: number;
  },
): AgentWalletPolicy {
  return {
    enabled: policy.enabled !== false,
    killed: policy.killed === true,
    maxPlsPerTx: policy.maxPlsPerTx,
    maxPlsDaily: policy.maxPlsDaily,
    contractAllowlist: (policy.contractAllowlist ?? []).map((a) =>
      assertAddress(a),
    ),
    tokenAllowlist: (policy.tokenAllowlist ?? []).map((a) => assertAddress(a)),
    allowlistExpiresAt: policy.allowlistExpiresAt ?? null,
    tokenSpendCaps: policy.tokenSpendCaps
      ? normalizeCapMap(policy.tokenSpendCaps)
      : {},
    tokenDailyCaps: policy.tokenDailyCaps
      ? normalizeCapMap(policy.tokenDailyCaps)
      : {},
    erc20NotionalCaps: policy.erc20NotionalCaps
      ? normalizeErc20NotionalCapMap(policy.erc20NotionalCaps)
      : {},
    requireDecodableCalldata: policy.requireDecodableCalldata === true,
    allowNativeTransfers: policy.allowNativeTransfers !== false,
  };
}
