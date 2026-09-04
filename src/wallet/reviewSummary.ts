/**
 * Operator- and AI-readable transaction review summaries.
 *
 * Decode + destination + value + gas hints. Funding authorizes spend.
 * Hard blocks are kill/disabled/invalid input only.
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

/** Whether the wallet can sign this intent (kill/disabled/invalid only). */
export type AgentGuidance = "ready" | "blocked";

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
}

/** Structured deny reason with actionable category. */
export interface DecisionReason {
  category: "kill_switch" | "disabled" | "invalid_input" | "other";
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
  /** Native PLS already spent today plus this value (accounting, not a limit). */
  projectedDailySpendPls?: number;
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
  };
  decodeKnowledge: DecodeKnowledge;
  /** ready = wallet can sign; blocked = kill/disabled/invalid */
  agentGuidance: AgentGuidance;
  safetyHints: string[];
  /** Which real checks were applied */
  checksApplied: string[];
  reasons: string[];
  decisionTrace: DecisionReason[];
  nextStep: string;
  /** Funding this wallet authorizes the agent to spend it. */
  fundingAuthorizesSpend: true;
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
  chainId?: number;
  network?: "mainnet" | "testnet";
}

export const FUNDING_AUTHORIZES_NOTE =
  "Funding the agent is authorization. There are no spend caps or allowlists. " +
  "Use kill_switch to stop signing. Protect AGENT_WALLET_MASTER_KEY. " +
  "Do not share AGENT_WALLET_DIR across processes.";

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
 */
export const PLS_VALUE_VS_GAS_HINT =
  "Separate three numbers: (1) native value transferred, (2) estimated gas cost in PLS, " +
  "(3) total PLS that must be available in-wallet (value + gas headroom). " +
  "A tiny-value tx can still require substantial PLS for gas on PulseChain.";

/** Recommended order of operations once funded. */
export const WALLET_TX_ORDER_HINT =
  "Prefer native transfer first, then approve/token transfer, then swap-class.";
/** @deprecated Use WALLET_TX_ORDER_HINT — same product guidance. */
export const LAB_TX_ORDER_HINT = WALLET_TX_ORDER_HINT;

export const SAFE_USAGE_PATTERN =
  "inspect_tx_intent (when calldata unclear) → propose_agent_tx → read reviewSummary → execute_agent_tx";

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
  return `${d.slice(0, 10)}…(${Math.max(0, (d.length - 2) / 2)} bytes)`;
}

export function categorizeDenyReason(message: string): DecisionReason {
  const m = message;
  let category: DecisionReason["category"] = "other";
  if (/kill switch|killed=true/i.test(m)) category = "kill_switch";
  else if (/enabled=false/i.test(m)) category = "disabled";
  else if (/Invalid |parse|valuePls|valueWei/i.test(m))
    category = "invalid_input";
  return { category, message: m };
}

function listChecksApplied(): string[] {
  return ["kill_switch", "enabled", "valid_input"];
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
    };
  }
  if (!tn) {
    return {
      status: "not_applicable",
      confidence: "none",
      reliable: false,
      pattern: "none",
    };
  }
  const p = tn.pattern;
  if (p === "truncated" || p === "invalid") {
    return {
      status: "truncated_or_invalid",
      confidence: tn.confidence,
      reliable: false,
      pattern: p,
    };
  }
  if (p === "unknown") {
    return {
      status: "unknown",
      confidence: tn.confidence,
      reliable: false,
      pattern: p,
    };
  }
  if (p === "empty") {
    return {
      status: "empty",
      confidence: tn.confidence,
      reliable: tn.reliable,
      pattern: p,
    };
  }
  return {
    status: "known_priority",
    confidence: tn.confidence,
    reliable: tn.reliable,
    pattern: p,
  };
}

function pulsechainGasSafetyHints(nativeValuePls: number): string[] {
  return [
    PULSECHAIN_GAS_OPERATOR_NOTE,
    PLS_VALUE_VS_GAS_HINT,
    `Native value in this review: ${nativeValuePls} PLS (value only). ` +
      "Ensure wallet holds value + gas; simulation.gasEstimate is gas units when present, not PLS cost.",
    WALLET_TX_ORDER_HINT,
    FUNDING_AUTHORIZES_NOTE,
  ];
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
  /** Decode quality only — never blocks propose/execute. */
  decodeComplete: boolean;
  safetyHints: string[];
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
  };
  const movements = compactMovements(tnLike);
  const decodeKnowledge = buildDecodeKnowledge(tnLike, hasCalldata);
  const decodeComplete =
    decodeKnowledge.status === "empty" ||
    (decodeKnowledge.status === "known_priority" &&
      decodeKnowledge.reliable &&
      decodeKnowledge.confidence !== "low");
  const safetyHints: string[] = [
    "Local decode only — not full EVM simulation and not a send gate",
    FUNDING_AUTHORIZES_NOTE,
  ];
  if (decodeKnowledge.status === "truncated_or_invalid") {
    safetyHints.push("Calldata looks truncated/invalid — amounts may be wrong");
  } else if (decodeKnowledge.status === "unknown") {
    safetyHints.push("Unknown selector — amounts not fully decoded");
  } else if (!params.inspection.reliable && params.inspection.riskRelevant) {
    safetyHints.push("Risk-relevant but unreliable decode");
  } else if (params.inspection.confidence === "low") {
    safetyHints.push("Low confidence decode");
  }
  safetyHints.push(...params.inspection.notes.slice(0, 4));

  const residualUncertainty = [
    "No on-chain simulation in this tool (slippage, taxes, reverts unknown)",
    "Fee-on-transfer tokens may move less than decoded amountIn",
    "Unknown/custom routers and aggregators are not fully covered",
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
    decodeComplete,
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
  chainId?: number;
  network?: "mainnet" | "testnet";
  context?: "propose" | "check" | "execute" | "transfer";
}

export function formatSealedChainLabel(
  chainId?: number,
  network?: string,
): string {
  if (typeof chainId === "number" && Number.isInteger(chainId)) {
    return network ? `${chainId} (${network})` : String(chainId);
  }
  return "unsealed — re-propose before execute";
}

export function buildTxReviewSummary(
  input: BuildTxReviewSummaryInput,
): TxReviewSummary {
  const check = input.policyCheck;
  const decision: "allow" | "deny" = check.allowed ? "allow" : "deny";
  const valueWei =
    input.valueWei ?? check.valueWei ?? String(Math.floor(check.valuePls * 1e18));
  const valuePls = input.valuePls ?? check.valuePls;
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
          check.reasons[0] ?? "wallet write blocked"
        }` +
        chainSuffix;

  const decisionTrace =
    decision === "deny" ? check.reasons.map(categorizeDenyReason) : [];

  const decodeKnowledge = buildDecodeKnowledge(check.tokenNotional, hasCalldata);
  const agentGuidance: AgentGuidance = decision === "deny" ? "blocked" : "ready";
  const safetyHints: string[] = [];
  if (decision === "deny") {
    safetyHints.push(
      "Write blocked (kill switch, disabled wallet, or invalid input) — do not broadcast",
    );
  } else {
    if (decodeKnowledge.status === "truncated_or_invalid") {
      safetyHints.push("Calldata looks truncated/invalid — amounts may be wrong");
    } else if (decodeKnowledge.status === "unknown") {
      safetyHints.push("Unknown selector — amounts not fully decoded");
    } else if (
      decodeKnowledge.status === "known_priority" &&
      !decodeKnowledge.reliable
    ) {
      safetyHints.push("Known pattern family but unreliable decode — amounts may be incomplete");
    } else if (
      decodeKnowledge.status === "known_priority" &&
      decodeKnowledge.confidence === "low"
    ) {
      safetyHints.push("Low-confidence decode — do not assume amounts are complete");
    }
    if (!hasCalldata) {
      safetyHints.push("Native transfer path — verify destination and PLS amount");
    } else {
      safetyHints.push("Contract/calldata path — verify destination, value, and calldata intent");
    }
  }
  safetyHints.push(...pulsechainGasSafetyHints(valuePls));
  if (omitted > 0) {
    safetyHints.push(
      `Review truncated: ${omitted} additional decoded movement(s) not shown`,
    );
  }

  const ctx = input.context ?? "propose";
  let nextStep: string;
  if (decision === "deny") {
    nextStep =
      "Do not execute. Clear kill switch / re-enable wallet, or fix invalid address/value.";
  } else if (ctx === "execute" || ctx === "transfer") {
    nextStep =
      "Broadcast path. Re-read headline + destination + value vs gas. Funding authorizes this spend.";
  } else if (ctx === "check") {
    nextStep =
      "propose_agent_tx → read reviewSummary → execute_agent_tx. Fund value + PulseChain gas.";
  } else {
    nextStep =
      "Read reviewSummary (destination, value, decode, gas hints), then execute_agent_tx.";
  }

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
    projectedDailySpendPls: check.projectedDailySpend,
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
        }
      : undefined,
    decodeKnowledge,
    agentGuidance,
    safetyHints,
    checksApplied: listChecksApplied(),
    reasons: check.reasons,
    decisionTrace,
    nextStep,
    fundingAuthorizesSpend: true,
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

/** Short operator/agent prompt (no secrets). */
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
    `Guidance: ${summary.agentGuidance}`,
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
  } else if (summary.omittedMovementCount > 0) {
    lines.push(`Moves: ${summary.omittedMovementCount} more not shown`);
  }
  if (summary.decision === "deny" && summary.reasons[0]) {
    lines.push(`Deny: ${summary.reasons[0]}`);
  }
  lines.push(FUNDING_AUTHORIZES_NOTE);
  return lines.join(" | ");
}
