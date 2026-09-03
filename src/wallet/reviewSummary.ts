/**
 * Operator- and AI-readable transaction review summaries.
 *
 * Pure helpers: build from existing PolicyCheckResult + proposal fields.
 * Operator-trust (v0.1.38+): funding the agent is authorization; confirm is
 * host UX only. Hard blocks are kill/disabled/invalid input (see docs/SECURITY.md).
 */

import type {
  PolicyCheckResult,
  SimulationResult,
  TokenNotionalPolicyView,
  TxProposal,
} from "./types.js";
import type { TokenNotionalInspection } from "./tokenNotional.js";

/** Concise movement line for operators (no secrets). */
export interface ReviewTokenMovement {
  token: string;
  amountRaw: string;
  role: string;
  recipient?: string;
  spender?: string;
  /** Plain-language explanation for agents */
  explanation?: string;
}

/** How an agent should treat the action after reading the summary. */
export type AgentGuidance =
  | "proceed_with_confirm"
  | "review_carefully"
  | "refuse";

/** Calldata / decode knowledge for agents (honest about limits). */
export interface DecodeKnowledge {
  /** empty | known_priority | unknown | truncated_or_invalid | not_applicable */
  status:
    | "empty"
    | "known_priority"
    | "unknown"
    | "truncated_or_invalid"
    | "not_applicable";
  confidence: string;
  reliable: boolean;
  pattern: string;
  /** True when policy may still allow unknown calldata (unless requireDecodable) */
  unknownMayBypassNotionalCaps: boolean;
}

/** Structured deny reason with actionable category. */
export interface DecisionReason {
  /** Machine-friendly category for clients */
  category:
    | "kill_switch"
    | "disabled"
    | "max_pls_per_tx"
    | "max_pls_daily"
    | "contract_allowlist"
    | "token_allowlist"
    | "allowlist_expired"
    | "native_transfers_disabled"
    | "token_spend_cap"
    | "token_daily_cap"
    | "token_notional"
    | "erc20_notional_cap"
    | "require_decodable"
    | "invalid_input"
    | "other";
  /** Human-readable reason (same as policy reasons, actionable) */
  message: string;
}

/**
 * Concise review surface for propose / check / transfer / execute.
 * Never includes private keys, ciphertext, or master key material.
 */
export interface TxReviewSummary {
  /** One-line operator headline */
  headline: string;
  decision: "allow" | "deny";
  destination: string;
  destinationKind: "eoa" | "contract" | "unknown";
  isContractInteraction: boolean;
  hasCalldata: boolean;
  /** Short calldata prefix (selector + ellipsis); never full huge blobs */
  calldataPreview?: string;
  nativeValuePls: number;
  nativeValueWei: string;
  /**
   * Headroom vs stored legacy maxPlsDaily (display only under operator-trust).
   * 0 does NOT mean deny — caps are not hard gates.
   */
  remainingDailyPls?: number;
  projectedDailySpendPls?: number;
  /** Always true under OT: remainingDaily / maxPls* are non-blocking display fields. */
  remainingDailyIsDisplayOnly: true;
  /** Always true under OT: legacy maxPls* / allowlist fields are not hard gates. */
  legacyCapsDisplayOnly: true;
  /** Short note for agents reading remainingDaily / maxPls* fields. */
  legacyCapsNote: string;
  tokenMovements: ReviewTokenMovement[];
  /** How many decoded movements were omitted from tokenMovements (cap 12). */
  omittedMovementCount: number;
  /** Human-readable movement lines for agents */
  movementExplanations: string[];
  tokenNotional?: {
    pattern: string;
    confidence: string;
    reliable: boolean;
    knownPulsexRouter: boolean;
    multicallExpanded: boolean;
    capsApplied: TokenNotionalPolicyView["capsApplied"];
  };
  /** Known vs unknown decode posture */
  decodeKnowledge: DecodeKnowledge;
  /**
   * Agent posture hint (not a guarantee):
   * refuse = policy deny or low/unknown risk-relevant decode under fail-closed posture
   * review_carefully = allow but unknown/low-confidence or large surface
   * proceed_with_confirm = allow + high-confidence empty/known path
   */
  agentGuidance: AgentGuidance;
  /** Short reasons for agentGuidance */
  safetyHints: string[];
  /** Which policy checks were in scope for this decision */
  checksApplied: string[];
  /** Explicit allow/deny reasons (empty when allow with no notes) */
  reasons: string[];
  /** Categorized deny reasons (empty when allowed) */
  decisionTrace: DecisionReason[];
  /** Always true for broadcast paths — host must still honor confirm/MRTR */
  confirmRequiredForBroadcast: true;
  /** Why an extra confirm step exists (host-strength only) */
  confirmRationale: string;
  /** Safe usage next step */
  nextStep: string;
  /** Honest reminder: confirm is not the main security boundary */
  policyBackstop: string;
  simulation?: {
    attempted: boolean;
    ok: boolean;
    error?: string;
    gasEstimate?: string;
    estimatedFeePlsApprox?: number;
    estimatedFeeWeiApprox?: string;
    feeBasis?: "maxFeePerGas" | "gasPrice" | "none";
    feeEstimateNote?: string;
  };
  proposalId?: string;
  walletId?: string;
  /**
   * Chain sealed on the proposal at propose time (369 mainnet / 943 testnet).
   * Missing on legacy on-disk proposals — execute refuses those.
   */
  chainId?: number;
  /** Network name sealed at propose time when present. */
  network?: "mainnet" | "testnet";
}

/** Honest label for remainingDaily / maxPls* under operator-trust. */
export const LEGACY_CAPS_DISPLAY_ONLY_NOTE =
  "Legacy maxPlsPerTx / maxPlsDaily / remainingDailyPls are display-only under " +
  "operator-trust (v0.1.38+). They do not hard-block sends. Funding the agent is authorization.";

export const POLICY_BACKSTOP_NOTE =
  "Operator-trust model (v0.1.38+): funding the agent is authorization. " +
  "There is no hard spend-cap / allowlist / token-notional policy backstop. " +
  "confirm=true / MRTR is host UX only (a careless host can rubber-stamp). " +
  "Real controls: keep wallets disabled until needed, protect MASTER_KEY, " +
  "fund only what you accept losing, use kill_switch in emergencies, " +
  "and do not share AGENT_WALLET_DIR across processes. " +
  LEGACY_CAPS_DISPLAY_ONLY_NOTE;

/**
 * PulseChain fee reality for operators and agents (not a live fee oracle).
 * Fees are PLS-denominated and often large in PLS terms even when USD is small.
 */
export const PULSECHAIN_GAS_OPERATOR_NOTE =
  "PulseChain uses EIP-1559; gas is priced in BEATS (1 PLS = 1e18 BEATS). " +
  "Base fees are often large in BEATS, so fee costs in PLS terms are commonly: " +
  "simple transfers tens of PLS; approvals/token transfers tens–low hundreds; " +
  "swaps often ~250+ PLS. Economically cheap in USD — do not treat PulseChain " +
  "like low-gwei Ethereum.";

/**
 * Value vs gas vs wallet total — agents must not assume tiny value ⇒ tiny balance.
 * MAX_PLS_* caps native value only; gas is paid on top.
 */
export const PLS_VALUE_VS_GAS_HINT =
  "Separate three numbers: (1) native value transferred, (2) estimated gas cost in PLS, " +
  "(3) total PLS that must be available in-wallet (value + gas headroom). " +
  "A tiny-value tx can still require substantial PLS for gas on PulseChain.";

/** Recommended order of operations once funded (operator-trust wallet mode). */
export const WALLET_TX_ORDER_HINT =
  "Prefer native transfer first, then approve/token transfer, then swap-class.";
/** @deprecated Use WALLET_TX_ORDER_HINT — same product guidance. */
export const LAB_TX_ORDER_HINT = WALLET_TX_ORDER_HINT;

/**
 * Recommended careful day-to-day flow (operator + agent).
 * inspect is optional but preferred when calldata is non-empty / unclear.
 */
export const SAFE_USAGE_PATTERN =
  "inspect_tx_intent (when calldata unclear) → propose_agent_tx → read reviewSummary + agentGuidance → execute_agent_tx with confirm=true (or MRTR)";

function shortAddr(addr: string): string {
  const a = addr.toLowerCase();
  if (a.length < 12) return a;
  return `${a.slice(0, 8)}…${a.slice(-4)}`;
}

function isEmptyData(data: string | undefined): boolean {
  return !data || data === "0x" || data === "0X";
}

function calldataPreview(data: string | undefined): string | undefined {
  if (isEmptyData(data)) return undefined;
  const d = data!;
  if (d.length <= 12) return d;
  // selector (10 chars) + note
  return `${d.slice(0, 10)}…(${Math.max(0, (d.length - 2) / 2)} bytes)`;
}

/**
 * Categorize a policy deny reason for decision traces.
 * Pure string heuristics over shipped reason text.
 */
export function categorizeDenyReason(message: string): DecisionReason {
  const m = message;
  let category: DecisionReason["category"] = "other";
  if (/kill switch|killed=true/i.test(m)) category = "kill_switch";
  else if (/enabled=false/i.test(m)) category = "disabled";
  else if (/maxPlsPerTx/i.test(m)) category = "max_pls_per_tx";
  else if (/maxPlsDaily|projected daily spend/i.test(m))
    category = "max_pls_daily";
  else if (/allowlist expired/i.test(m)) category = "allowlist_expired";
  else if (/contractAllowlist|not on contractAllowlist/i.test(m))
    category = "contract_allowlist";
  else if (/tokenAllowlist|not on tokenAllowlist/i.test(m))
    category = "token_allowlist";
  else if (/Native PLS transfers are disabled/i.test(m))
    category = "native_transfers_disabled";
  else if (/tokenSpendCaps/i.test(m)) category = "token_spend_cap";
  else if (/tokenDailyCaps/i.test(m)) category = "token_daily_cap";
  else if (/requireDecodableCalldata/i.test(m)) category = "require_decodable";
  else if (/erc20NotionalCaps/i.test(m)) category = "erc20_notional_cap";
  else if (/Token-notional|Token notional/i.test(m))
    category = "token_notional";
  else if (/Invalid |parse|valuePls|valueWei/i.test(m))
    category = "invalid_input";
  return { category, message: m };
}

function listChecksApplied(check: PolicyCheckResult): string[] {
  const checks: string[] = [
    "kill_switch",
    "enabled",
    "operator_trust (caps/allowlists not hard gates)",
  ];
  const tn = check.tokenNotional;
  if (tn?.considered) {
    checks.push(
      tn.riskRelevant
        ? `tokenNotional_advisory(${tn.pattern}, confidence=${tn.confidence})`
        : "tokenNotional_advisory(inspected)",
    );
  }
  return checks;
}

function explainMovement(m: {
  token: string;
  amountRaw: string;
  role: string;
  recipient?: string;
  spender?: string;
  path?: string[];
}): string {
  const tok =
    m.token === "native" ? "native PLS" : `token ${shortAddr(m.token)}`;
  switch (m.role) {
    case "transfer":
      return `Transfer ${m.amountRaw} raw of ${tok} to ${shortAddr(m.recipient ?? "?")}`;
    case "transferFrom":
      return `TransferFrom ${m.amountRaw} raw of ${tok} (spender pulls)`;
    case "approve":
      return `Approve spender ${shortAddr(m.spender ?? "?")} for ${m.amountRaw} raw of ${tok}`;
    case "deposit":
      return `Wrap/deposit ${m.amountRaw} wei native into WPLS-style token at destination`;
    case "withdraw":
      return `Unwrap/withdraw ${m.amountRaw} raw of ${tok} to native PLS`;
    case "swapExactIn":
      return `Swap exact-in ${m.amountRaw} raw of ${tok} (path start / native-in)`;
    case "swapExactOutMaxIn":
      return `Swap exact-out max-in ${m.amountRaw} raw of ${tok} (upper bound)`;
    case "addLiquidity":
      return `Add liquidity up to ${m.amountRaw} raw of ${tok} (desired amount)`;
    case "removeLiquidity":
      return m.amountRaw === "0"
        ? `Remove liquidity involving ${tok} (LP share amount not mapped to underlyings)`
        : `Remove liquidity ${m.amountRaw} involving ${tok}`;
    case "nativeValue":
      return `Outer native value ${m.amountRaw} wei attributed to this call`;
    default:
      return `${m.role}: ${m.amountRaw} raw of ${tok}`;
  }
}

function compactMovements(
  tn: TokenNotionalPolicyView | undefined,
): ReviewTokenMovement[] {
  if (!tn?.movements?.length) return [];
  // Cap list for operator readability; callers should also surface omitted count.
  return tn.movements.slice(0, 12).map((m) => ({
    token: m.token,
    amountRaw: m.amountRaw,
    role: m.role,
    recipient: m.recipient,
    spender: m.spender,
    explanation: explainMovement(m),
  }));
}

export function omittedMovementCount(
  tn: TokenNotionalPolicyView | undefined,
  kept = 12,
): number {
  const n = tn?.movements?.length ?? 0;
  return n > kept ? n - kept : 0;
}

function buildDecodeKnowledge(
  tn: TokenNotionalPolicyView | undefined,
  hasCalldata: boolean,
): DecodeKnowledge {
  if (!hasCalldata) {
    return {
      status: "empty",
      confidence: "high",
      reliable: true,
      pattern: "empty",
      unknownMayBypassNotionalCaps: false,
    };
  }
  if (!tn) {
    return {
      status: "not_applicable",
      confidence: "none",
      reliable: false,
      pattern: "none",
      unknownMayBypassNotionalCaps: true,
    };
  }
  const p = tn.pattern;
  if (p === "truncated" || p === "invalid") {
    return {
      status: "truncated_or_invalid",
      confidence: tn.confidence,
      reliable: false,
      pattern: p,
      unknownMayBypassNotionalCaps: false,
    };
  }
  if (p === "unknown") {
    return {
      status: "unknown",
      confidence: tn.confidence,
      reliable: false,
      pattern: p,
      unknownMayBypassNotionalCaps: !tn.requireDecodableCalldata,
    };
  }
  if (p === "empty") {
    return {
      status: "empty",
      confidence: tn.confidence,
      reliable: tn.reliable,
      pattern: p,
      unknownMayBypassNotionalCaps: false,
    };
  }
  return {
    status: "known_priority",
    confidence: tn.confidence,
    reliable: tn.reliable,
    pattern: p,
    unknownMayBypassNotionalCaps: false,
  };
}

/** Always-on PulseChain gas / funding hints (not a fee oracle). */
function pulsechainGasSafetyHints(nativeValuePls: number): string[] {
  return [
    PULSECHAIN_GAS_OPERATOR_NOTE,
    PLS_VALUE_VS_GAS_HINT,
    `Native value in this review: ${nativeValuePls} PLS (policy value only). ` +
      "Ensure wallet holds value + gas; simulation.gasEstimate is gas units when present, not PLS cost.",
    WALLET_TX_ORDER_HINT,
  ];
}

function buildAgentGuidance(params: {
  decision: "allow" | "deny";
  decode: DecodeKnowledge;
  hasCalldata: boolean;
  nativeValuePls: number;
}): { agentGuidance: AgentGuidance; safetyHints: string[] } {
  const hints: string[] = [];
  if (params.decision === "deny") {
    hints.push(
      "Write blocked (kill switch, disabled wallet, or invalid input) — do not broadcast",
    );
    hints.push(...pulsechainGasSafetyHints(params.nativeValuePls));
    return { agentGuidance: "refuse", safetyHints: hints };
  }
  // Decode quality is advisory only in operator-trust mode (not a hard refuse gate).
  if (params.decode.status === "truncated_or_invalid") {
    hints.push(
      "Calldata looks truncated/invalid — operator-trust still allows propose/execute; verify carefully",
    );
  } else if (params.decode.status === "unknown") {
    hints.push("Unknown selector — advisory only; no hard token-notional deny");
  } else if (params.decode.status === "known_priority" && !params.decode.reliable) {
    hints.push("Known pattern family but unreliable decode — amounts may be incomplete");
  } else if (
    params.decode.status === "known_priority" &&
    params.decode.confidence === "low"
  ) {
    hints.push("Low-confidence decode — do not assume amounts are complete");
  }
  if (!params.hasCalldata) {
    hints.push("Native transfer path — verify destination and PLS amount");
  } else {
    hints.push("Contract/calldata path — verify destination, value, and calldata intent");
  }
  hints.push(
    "Operator-trust: funding the agent is authorization; confirm=true is host UX only",
  );
  hints.push(...pulsechainGasSafetyHints(params.nativeValuePls));
  if (
    params.decode.status === "unknown" ||
    params.decode.status === "truncated_or_invalid" ||
    (params.decode.status === "known_priority" &&
      (params.decode.confidence === "low" || !params.decode.reliable))
  ) {
    return { agentGuidance: "review_carefully", safetyHints: hints };
  }
  return { agentGuidance: "proceed_with_confirm", safetyHints: hints };
}

/**
 * Agent-facing pure intent view from token-notional inspection alone
 * (no wallet policy). Used by inspect_tx_intent tool.
 */
export interface AgentIntentView {
  to: string;
  valueWei: string;
  hasCalldata: boolean;
  calldataPreview?: string;
  inspection: {
    pattern: string;
    confidence: string;
    reliable: boolean;
    riskRelevant: boolean;
    knownPulsexRouter: boolean;
    multicallExpanded: boolean;
    notes: string[];
  };
  movements: ReviewTokenMovement[];
  movementExplanations: string[];
  decodeKnowledge: DecodeKnowledge;
  agentGuidance: AgentGuidance;
  safetyHints: string[];
  /** What the agent still cannot know without simulation */
  residualUncertainty: string[];
}

export function buildAgentIntentView(params: {
  to: string;
  data?: string;
  valueWei?: string | bigint;
  inspection: TokenNotionalInspection;
}): AgentIntentView {
  const hasCalldata = !isEmptyData(params.data);
  const valueWei =
    params.valueWei === undefined || params.valueWei === ""
      ? "0"
      : String(params.valueWei);
  const tnLike: TokenNotionalPolicyView = {
    considered: params.inspection.considered,
    confidence: params.inspection.confidence,
    pattern: params.inspection.pattern,
    reliable: params.inspection.reliable,
    riskRelevant: params.inspection.riskRelevant,
    knownPulsexRouter: params.inspection.knownPulsexRouter,
    multicallExpanded: params.inspection.multicallExpanded,
    innerCallCount: params.inspection.innerCallCount,
    innerUnreliableCount: params.inspection.innerUnreliableCount,
    movements: params.inspection.movements,
    notes: params.inspection.notes,
    capsApplied: [],
    requireDecodableCalldata: false,
  };
  const movements = compactMovements(tnLike);
  const decodeKnowledge = buildDecodeKnowledge(tnLike, hasCalldata);
  // Operator-trust: inspect is advisory only — never hard-refuse ordinary sends.
  let agentGuidance: AgentGuidance = "proceed_with_confirm";
  const safetyHints: string[] = [
    "Local decode only — not full EVM simulation",
    "Operator-trust: inspect_tx_intent does not block propose/execute",
  ];
  if (decodeKnowledge.status === "truncated_or_invalid") {
    agentGuidance = "review_carefully";
    safetyHints.push("Calldata looks truncated/invalid — verify before confirm");
  } else if (decodeKnowledge.status === "unknown") {
    agentGuidance = "review_carefully";
    safetyHints.push("Unknown selector — amounts not fully decoded");
  } else if (!params.inspection.reliable && params.inspection.riskRelevant) {
    agentGuidance = "review_carefully";
    safetyHints.push("Risk-relevant but unreliable decode");
  } else if (params.inspection.confidence === "low") {
    agentGuidance = "review_carefully";
    safetyHints.push("Low confidence decode");
  }
  safetyHints.push(...params.inspection.notes.slice(0, 4));

  const residualUncertainty = [
    "No on-chain simulation in this tool (slippage, taxes, reverts unknown)",
    "Fee-on-transfer tokens may move less than decoded amountIn",
    "Unknown/custom routers and aggregators are not fully covered",
    "Operator-trust: no hard allowlist/cap gate on propose/execute",
    "PulseChain gas cost in PLS is not estimated here — fees can be large in PLS terms " +
      "(transfers tens, approvals tens–hundreds, swaps ~250+); fund value + gas",
  ];

  return {
    to: params.to.toLowerCase(),
    valueWei,
    hasCalldata,
    calldataPreview: calldataPreview(params.data),
    inspection: {
      pattern: params.inspection.pattern,
      confidence: params.inspection.confidence,
      reliable: params.inspection.reliable,
      riskRelevant: params.inspection.riskRelevant,
      knownPulsexRouter: params.inspection.knownPulsexRouter,
      multicallExpanded: params.inspection.multicallExpanded,
      notes: params.inspection.notes,
    },
    movements,
    movementExplanations: movements
      .map((m) => m.explanation)
      .filter((x): x is string => Boolean(x)),
    decodeKnowledge,
    agentGuidance,
    safetyHints,
    residualUncertainty,
  };
}

export interface BuildTxReviewSummaryInput {
  to: string;
  from?: string;
  valueWei?: string;
  valuePls?: number;
  data?: string;
  policyCheck: PolicyCheckResult;
  simulation?: SimulationResult;
  proposalId?: string;
  walletId?: string;
  /** Sealed chain at propose time (shown so operators can tell 369 vs 943). */
  chainId?: number;
  network?: "mainnet" | "testnet";
  /** Where this summary is attached (affects nextStep wording) */
  context?: "propose" | "check" | "execute" | "transfer";
}

/** Operator-visible sealed chain (369 vs 943) for headlines and confirm prompts. */
export function formatSealedChainLabel(
  chainId?: number,
  network?: string,
): string {
  if (typeof chainId === "number" && Number.isInteger(chainId)) {
    return network ? `${chainId} (${network})` : String(chainId);
  }
  return "unsealed — re-propose before execute";
}

/**
 * Build a concise operator-readable review summary from shipped policy output.
 * Pure — no I/O, no secrets.
 */
export function buildTxReviewSummary(
  input: BuildTxReviewSummaryInput,
): TxReviewSummary {
  const check = input.policyCheck;
  const decision: "allow" | "deny" = check.allowed ? "allow" : "deny";
  const valueWei =
    input.valueWei ?? check.valueWei ?? String(Math.floor(check.valuePls * 1e18));
  const valuePls = input.valuePls ?? check.valuePls;
  // Contract interaction (calldata or code at to) vs pure EOA native transfer
  const destinationKind: TxReviewSummary["destinationKind"] =
    check.isContractInteraction || check.destinationIsContract
      ? "contract"
      : "eoa";

  const hasCalldata = !isEmptyData(input.data);
  const movements = compactMovements(check.tokenNotional);
  const omitted = omittedMovementCount(check.tokenNotional);
  const movementExplanations = movements
    .map((m) => m.explanation)
    .filter((x): x is string => Boolean(x));
  const movementHint =
    movements.length === 0
      ? "no decoded token movements"
      : movements
          .slice(0, 3)
          .map((m) => `${m.role} ${m.amountRaw} raw @ ${shortAddr(m.token)}`)
          .join("; ") + (movements.length > 3 || omitted > 0 ? "…" : "");

  const chainLabel =
    typeof input.chainId === "number" && Number.isInteger(input.chainId)
      ? formatSealedChainLabel(input.chainId, input.network)
      : input.proposalId
        ? formatSealedChainLabel(undefined, input.network)
        : undefined;
  const chainSuffix = chainLabel ? ` · chain ${chainLabel}` : "";

  const headline =
    decision === "allow"
      ? `ALLOWED: ${valuePls} PLS → ${shortAddr(input.to)}` +
        (check.isContractInteraction
          ? ` (contract/calldata; ${check.tokenNotional?.pattern ?? "interaction"})`
          : " (native EOA transfer)") +
        (movements.length ? `; tokens: ${movementHint}` : "") +
        chainSuffix
      : `DENIED: ${valuePls} PLS → ${shortAddr(input.to)} — ${
          check.reasons[0] ?? "policy rejected"
        }` +
        chainSuffix;

  const decisionTrace =
    decision === "deny" ? check.reasons.map(categorizeDenyReason) : [];

  const decodeKnowledge = buildDecodeKnowledge(check.tokenNotional, hasCalldata);
  const { agentGuidance, safetyHints: baseHints } = buildAgentGuidance({
    decision,
    decode: decodeKnowledge,
    hasCalldata,
    nativeValuePls: valuePls,
  });
  const safetyHints =
    omitted > 0
      ? [
          ...baseHints,
          `Review truncated: ${omitted} additional decoded movement(s) not shown`,
        ]
      : baseHints;

  const ctx = input.context ?? "propose";
  let nextStep: string;
  if (decision === "deny" || agentGuidance === "refuse") {
    nextStep =
      "Do not execute. Clear kill switch / re-enable wallet, or fix invalid address/value. " +
      "Caps and allowlists are not hard gates in operator-trust mode.";
  } else if (agentGuidance === "review_carefully") {
    nextStep =
      "Optional careful review of destination/calldata, then execute_agent_tx with confirm=true. " +
      "Operator-trust: funding authorizes; still verify value + gas headroom.";
  } else if (ctx === "execute" || ctx === "transfer") {
    nextStep =
      "Broadcast path after confirm. Re-read headline + destination + value vs gas. " +
      "Operator-trust model — no hard policy cap backstop.";
  } else if (ctx === "check") {
    nextStep =
      "propose_agent_tx → read reviewSummary → execute_agent_tx with confirm=true / MRTR. " +
      "Fund value + PulseChain gas; operator-trust mode.";
  } else {
    nextStep =
      "Read reviewSummary (destination, value, gas hints), then execute_agent_tx with " +
      "proposalId + confirm=true (or MRTR). Operator-trust: funding the agent is authorization.";
  }

  const confirmRationale =
    "Broadcast requires confirm=true or modern MRTR InputRequiredResult (host UX only). " +
    "Operator-trust model: there is no hard spend-cap/allowlist policy backstop. " +
    "Always read destination, native PLS value, gas headroom, and decoded movements before confirming. " +
    PLS_VALUE_VS_GAS_HINT;
  const tn = check.tokenNotional;
  return {
    headline,
    decision,
    destination: input.to.toLowerCase(),
    destinationKind,
    isContractInteraction: check.isContractInteraction,
    hasCalldata,
    calldataPreview: calldataPreview(input.data),
    nativeValuePls: valuePls,
    nativeValueWei: valueWei,
    remainingDailyPls: check.remainingDaily,
    projectedDailySpendPls: check.projectedDailySpend,
    remainingDailyIsDisplayOnly: true,
    legacyCapsDisplayOnly: true,
    legacyCapsNote: LEGACY_CAPS_DISPLAY_ONLY_NOTE,
    tokenMovements: movements,
    omittedMovementCount: omitted,
    movementExplanations,
    tokenNotional: tn
      ? {
          pattern: tn.pattern,
          confidence: tn.confidence,
          reliable: tn.reliable,
          knownPulsexRouter: tn.knownPulsexRouter,
          multicallExpanded: tn.multicallExpanded,
          capsApplied: tn.capsApplied,
        }
      : undefined,
    decodeKnowledge,
    agentGuidance,
    safetyHints,
    checksApplied: listChecksApplied(check),
    reasons: check.reasons,
    decisionTrace,
    confirmRequiredForBroadcast: true,
    confirmRationale,
    nextStep,
    policyBackstop: POLICY_BACKSTOP_NOTE,
    simulation: input.simulation
      ? {
          attempted: input.simulation.attempted,
          ok: input.simulation.ok,
          error: input.simulation.error,
          gasEstimate: input.simulation.gasEstimate,
          estimatedFeePlsApprox: input.simulation.estimatedFeePlsApprox,
          estimatedFeeWeiApprox: input.simulation.estimatedFeeWeiApprox,
          feeBasis: input.simulation.feeBasis,
          feeEstimateNote: input.simulation.feeEstimateNote,
        }
      : undefined,
    proposalId: input.proposalId,
    walletId: input.walletId,
    chainId: input.chainId,
    network: input.network,
  };
}

/** Build review summary from a stored/returned proposal. */
export function buildProposalReviewSummary(
  proposal: TxProposal,
  context: BuildTxReviewSummaryInput["context"] = "propose",
): TxReviewSummary {
  return buildTxReviewSummary({
    to: proposal.to,
    from: proposal.from,
    valueWei: proposal.valueWei,
    valuePls: proposal.valuePls,
    data: proposal.data,
    policyCheck: proposal.policyCheck,
    simulation: proposal.simulation,
    proposalId: proposal.id,
    walletId: proposal.walletId,
    chainId: proposal.chainId,
    network: proposal.network,
    context,
  });
}

/**
 * Short confirm prompt for MRTR / tool message (no secrets).
 * Prefer attaching full reviewSummary in the tool result after confirm.
 */
export function formatConfirmPrompt(summary: TxReviewSummary): string {
  const chainLabel =
    typeof summary.chainId === "number" && Number.isInteger(summary.chainId)
      ? formatSealedChainLabel(summary.chainId, summary.network)
      : summary.proposalId
        ? formatSealedChainLabel(undefined, summary.network)
        : undefined;
  const lines = [
    summary.headline,
    `Decision: ${summary.decision.toUpperCase()}`,
    `AgentGuidance: ${summary.agentGuidance}`,
    `To: ${summary.destination} (${summary.destinationKind})`,
    ...(chainLabel ? [`Chain: ${chainLabel}`] : []),
    `Native value: ${summary.nativeValuePls} PLS (${summary.nativeValueWei} wei) — value only, not gas`,
    `Decode: ${summary.decodeKnowledge.status}/${summary.decodeKnowledge.pattern}`,
  ];
  if (summary.simulation?.gasEstimate) {
    const feeApprox = summary.simulation.estimatedFeePlsApprox;
    lines.push(
      feeApprox !== undefined
        ? `Gas estimate (units): ${summary.simulation.gasEstimate}; approx fee ~${feeApprox} PLS ` +
            `(${summary.simulation.feeBasis ?? "fee market"}; approximate, fee-market dependent)`
        : `Gas estimate (units): ${summary.simulation.gasEstimate} — convert via fee market; ` +
            "PulseChain gas often costs tens–hundreds+ PLS",
    );
  } else {
    lines.push(
      "Gas: ensure wallet has value + gas headroom (PulseChain fees large in PLS terms)",
    );
  }
  if (summary.movementExplanations.length) {
    const shown = summary.movementExplanations.slice(0, 3);
    const extra =
      summary.omittedMovementCount > 0 || summary.movementExplanations.length > 3
        ? ` (+${summary.omittedMovementCount + Math.max(0, summary.movementExplanations.length - 3)} more not shown)`
        : "";
    lines.push(`Moves: ${shown.join("; ")}${extra}`);
  } else if (summary.tokenMovements.length) {
    lines.push(
      `Tokens: ${summary.tokenMovements
        .slice(0, 4)
        .map((m) => `${m.role} ${m.amountRaw}@${shortAddr(m.token)}`)
        .join("; ")}` +
        (summary.omittedMovementCount > 0
          ? ` (+${summary.omittedMovementCount} more not shown)`
          : ""),
    );
  }
  if (summary.decision === "deny" && summary.reasons[0]) {
    lines.push(`Deny: ${summary.reasons[0]}`);
  }
  lines.push(
    "Confirm only after reviewing value + gas + destination. Operator-trust: funding authorizes; confirm is host UX only.",
  );
  return lines.join(" | ");
}
