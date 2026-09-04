/**
 * Switch.win DEX aggregator quote client (PulseChain).
 * Docs / SDK: https://github.com/BuildTheTech/Switch-SDK
 * Quote: GET https://quote.switch.win/swap/quote
 *
 * Authentication (operator-gated — not self-serve for agents):
 * - Every request requires an API key via `x-api-key` (or Authorization: Bearer).
 * - Public unauthenticated access returns HTTP 401.
 * - Keys are **not** available in-app; the **operator** must request access from
 *   Switch (https://docs.switch.win/aggregator/request-api-key) and set
 *   SWITCH_API_KEY in the local server environment. Agents cannot usefully
 *   "just get a key" without operator help. Prefer **piteas_quote** for keyless
 *   aggregator assists until the operator configures Switch.
 *
 * Aggregator assist — not a guaranteed best-price oracle.
 * Quote-only / advisory until wallet propose → review → execute.
 * Never invents routes or calldata; preserves exact upstream `tx.data`.
 * Never hardcodes SwitchRouter as send destination — always use `tx.to`.
 *
 * Native token: Switch sentinel 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
 * (aliases PLS / native / 0x0 map to that sentinel).
 */

import { formatEther } from "viem";
import type { AppConfig } from "../types.js";
import { isAddress } from "../utils/safety.js";
import {
  PULSECHAIN_CHAIN_ID,
  resolveCoreToken,
  USDC_FROM_ETH_ADDRESS,
  WPLS_ADDRESS,
} from "../constants.js";

/** Public Switch quote API base. */
export const SWITCH_API_BASE = "https://quote.switch.win" as const;

/** Switch native-currency sentinel (PLS on PulseChain). */
export const SWITCH_NATIVE_SENTINEL =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

/** Zero address often used elsewhere for native; maps to Switch sentinel. */
export const NATIVE_ZERO =
  "0x0000000000000000000000000000000000000000" as const;

/** Default network for this MCP (PulseChain only for quote tools). */
export const SWITCH_DEFAULT_NETWORK = "pulsechain" as const;

/** Slippage default: 0.5% → 50 bps (matches Switch SDK default). */
export const SWITCH_DEFAULT_SLIPPAGE_PERCENT = 0.5 as const;

/**
 * Official Switch docs for requesting API key access.
 * Access is operator-gated — not self-serve inside this MCP.
 */
export const SWITCH_API_KEY_REQUEST_URL =
  "https://docs.switch.win/aggregator/request-api-key" as const;

/**
 * Operator next-step when Switch auth is missing/rejected.
 * Agents should surface this to the human operator; they cannot mint a key themselves.
 */
export const SWITCH_AUTH_OPERATOR_NEXT_STEP =
  "Ask the operator to request a Switch API key at " +
  SWITCH_API_KEY_REQUEST_URL +
  " (not self-serve in this MCP), set SWITCH_API_KEY in the local server environment " +
  "(x-api-key header; never commit the key), then retry switch_quote. " +
  "Until then Switch is unavailable — prefer piteas_quote (keyless aggregator assist).";

/** Shared body for missing-key / 401 / 403 soft-fails (reason + agent guidance). */
export const SWITCH_AUTH_GUIDANCE = {
  missingKey:
    "SWITCH_API_KEY is not set. Switch quote API requires operator-configured authentication " +
    "(header x-api-key). Public unauthenticated access returns HTTP 401. " +
    "API key access is **operator-gated** (not available in-app for agents): the human operator " +
    "must request access from Switch at " +
    SWITCH_API_KEY_REQUEST_URL +
    " and place the key in local env only. " +
    "An agent cannot usefully obtain a key without operator help. " +
    "Prefer piteas_quote for keyless aggregator quotes until SWITCH_API_KEY is configured.",
  unauthorized:
    "Switch HTTP 401 Unauthorized — missing or rejected API key. " +
    "Public unauthenticated access is not available. " +
    "Switch remains unavailable until the operator configures a valid SWITCH_API_KEY " +
    "(request access: " +
    SWITCH_API_KEY_REQUEST_URL +
    "). Prefer piteas_quote for keyless aggregator quotes in the meantime.",
  forbidden:
    "Switch HTTP 403 Forbidden — invalid or unauthorized API key. " +
    "Operator should verify SWITCH_API_KEY (request/rotate via " +
    SWITCH_API_KEY_REQUEST_URL +
    "). Prefer piteas_quote for keyless aggregator quotes until resolved.",
} as const;

const QUOTE_NOTE =
  "Switch.win aggregator quote (advisory). Multi-hop / split-route assist on PulseChain — " +
  "not a guaranteed best-price oracle across all venues. " +
  "Does NOT broadcast. Use switch_prepare_swap → propose_agent_tx → review → execute_agent_tx. " +
  "Calldata is exact upstream tx.data; local wallet decode may show unknown selector. " +
  "Quotes expire (~10s cache); re-quote before send. " +
  "Requires operator-configured SWITCH_API_KEY (x-api-key; not self-serve — " +
  SWITCH_API_KEY_REQUEST_URL +
  "). Prefer piteas_quote when no key is configured.";

const PREPARE_NOTE =
  "Agent-ready tx intent from a Switch quote. Does NOT broadcast. " +
  "to = upstream tx.to (never a hardcoded router); data = exact upstream tx.data; " +
  "valueWei from tx.value when selling native PLS. " +
  "intent.valuePls is human PLS for propose_agent_tx (never pass valueWei as valuePls — 1e18× overshoot). " +
  "Local inspect_tx_intent may report unknown selector — verify review fields before execute. " +
  "Requires a successful switch_quote (which needs operator SWITCH_API_KEY).";

export interface SwitchSoftFail {
  ok: false;
  source: "switch";
  reason: string;
  status?: number;
  advisory: true;
  /** Present when missing/invalid key is the blocker. */
  authRequired?: true;
  /** Key access is operator-only — agent cannot self-serve. */
  operatorGated?: true;
  /** Official request path for operators. */
  requestApiKeyUrl?: typeof SWITCH_API_KEY_REQUEST_URL;
  /** Concrete next step for the agent to tell the operator. */
  nextStep?: string;
  /** Keyless aggregator path while Switch is unavailable. */
  preferKeyless?: "piteas_quote";
}

export interface SwitchTxFields {
  /** Router / target from upstream — never invented. */
  to: string;
  /** Exact upstream hex calldata. */
  data: string;
  /** Native value hex or decimal string from upstream. */
  value: string;
}

export interface SwitchTokenTax {
  isTaxToken: boolean;
  buyTaxBps: number;
  sellTaxBps: number;
}

export interface SwitchQuoteData {
  fromToken: string;
  toToken: string;
  /** Request amount in (decimal wei string). */
  amountIn: string;
  /** Raw DEX total out (decimal wei) when present. */
  totalAmountOut?: string;
  /** Expected user out after fees/taxes (decimal wei) — display estimate. */
  amountOut: string;
  /**
   * Min out from upstream minAmountOut (preferred) or local slip math.
   * Decimal wei string. On-chain min is encoded in exact calldata.
   */
  amountOutMin?: string;
  /** Native PLS value to attach (decimal wei); "0" when not selling native. */
  valueWei: string;
  /**
   * Human PLS for propose_agent_tx `valuePls` (formatEther of valueWei).
   * Never pass valueWei into valuePls.
   */
  valuePls?: string;
  /** Exact upstream tx (required for prepare when quoteReady). */
  tx: SwitchTxFields;
  /** Optional fee-on-output variant when upstream provided it. */
  txFeeOnOutput?: SwitchTxFields | null;
  fromTokenTax?: SwitchTokenTax | null;
  toTokenTax?: SwitchTokenTax | null;
  effectiveSlippageBps?: number | null;
  effectiveSlippagePercent?: string | null;
  feeOnOutput: boolean;
  /** Normalized addresses as sent to API. */
  tokenInParam: string;
  tokenOutParam: string;
  /** Slippage in basis points sent to API. */
  slippageBps: number;
  /** Slippage percent equivalent (slippageBps / 100). */
  allowedSlippage: number;
  sender?: string;
  receiver?: string;
  network: typeof SWITCH_DEFAULT_NETWORK;
  chainId: number;
  /** True when amountOut usable and tx has to+data. */
  quoteReady: boolean;
  pathSummary?: string | null;
  note: string;
  decodeNote: string;
  apiKeyConfigured: boolean;
}

export interface SwitchQuoteSuccess {
  ok: true;
  source: "switch";
  advisory: true;
  data: SwitchQuoteData;
}

export type SwitchQuoteResult = SwitchQuoteSuccess | SwitchSoftFail;

export interface SwitchQuoteRequest {
  tokenIn: string;
  tokenOut: string;
  /** Amount in smallest units (integer decimal string / wei). */
  amount: string;
  /**
   * Slippage percent 0–50 (default 0.5). Converted to bps for Switch API.
   * Prefer this over slippageBps for Piteas-like ergonomics.
   */
  allowedSlippage?: number;
  /** Explicit bps 0–5000; when set, overrides allowedSlippage conversion. */
  slippageBps?: number;
  /** Sender wallet — required by Switch for `tx` calldata. */
  sender?: string;
  /** Alias for sender (account). */
  account?: string;
  /** Optional custom recipient (defaults to sender on upstream). */
  receiver?: string;
  /** feeOnOutput=true selects txFeeOnOutput for prepare when present. */
  feeOnOutput?: boolean;
}

export interface SwitchPrepareSwapResult {
  ok: true;
  source: "switch";
  advisory: true;
  broadcast: false;
  intent: {
    /** Always from upstream tx.to — never a hardcoded router constant. */
    to: string;
    data: string;
    valueWei: string;
    valuePls: string;
  };
  review: {
    tokenIn: string;
    tokenOut: string;
    tokenInParam: string;
    tokenOutParam: string;
    amountIn: string;
    amountOut: string;
    amountOutMin?: string;
    recipient?: string;
    sender?: string;
    allowedSlippage: number;
    slippageBps: number;
    feeOnOutput: boolean;
    sellingNativePls: boolean;
    routerFromUpstream: string;
    localDecodeExpect: "unknown_selector_likely";
    fromTokenTax?: SwitchTokenTax | null;
    toTokenTax?: SwitchTokenTax | null;
  };
  /** Exact upstream tx fields (calldata never rewritten). */
  tx: SwitchTxFields;
  nextStep: string;
  note: string;
}

export interface SwitchPrepareSoftFail {
  ok: false;
  source: "switch";
  reason: string;
  advisory: true;
  broadcast: false;
}

export type SwitchPrepareResult = SwitchPrepareSwapResult | SwitchPrepareSoftFail;

type DexFetch = typeof fetch;

export interface SwitchFetchOptions {
  timeoutMs?: number;
  fetchImpl?: DexFetch;
  /** Override API base (tests). */
  apiBase?: string;
  /** Override API key (tests); else process.env.SWITCH_API_KEY. */
  apiKey?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return fallback;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Convert hex or decimal integer string to decimal wei string. */
export function hexOrDecToDecimalWei(value: string): string {
  const s = String(value ?? "").trim();
  if (s === "") return "0";
  if (/^0x[0-9a-fA-F]+$/i.test(s)) {
    try {
      return BigInt(s).toString(10);
    } catch {
      return "0";
    }
  }
  if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, "") || "0";
  return "0";
}

/**
 * Convert decimal wei string to human PLS for propose_agent_tx `valuePls`.
 * Pure. "0" / empty → "0".
 */
export function weiToHumanPls(valueWei: string): string {
  const wei = hexOrDecToDecimalWei(valueWei);
  if (wei === "0") return "0";
  try {
    return formatEther(BigInt(wei));
  } catch {
    return "0";
  }
}

/** True if value is even-length 0x hex calldata (selector + args). */
export function isEvenHexData(data: string): boolean {
  const s = String(data ?? "").trim();
  if (!/^0x[0-9a-fA-F]*$/i.test(s)) return false;
  return s.length % 2 === 0 && s.length >= 10;
}

/**
 * Normalize a user token input for Switch query params.
 * - PLS / native / zero address / native sentinel → SWITCH_NATIVE_SENTINEL
 * - WPLS kept as wrapped address
 * - Catalogued symbols (eUSDC, USDC, …) → address
 * - 0x addresses validated
 * Pure.
 */
export function normalizeSwitchToken(
  input: string,
): { ok: true; param: string; isNativePls: boolean } | { ok: false; reason: string } {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return { ok: false, reason: "token is required" };
  }
  const upper = raw.toUpperCase();
  if (
    upper === "PLS" ||
    upper === "NATIVE" ||
    upper === "NATIVE_PLS" ||
    raw.toLowerCase() === NATIVE_ZERO.toLowerCase() ||
    raw.toLowerCase() === SWITCH_NATIVE_SENTINEL.toLowerCase()
  ) {
    return { ok: true, param: SWITCH_NATIVE_SENTINEL, isNativePls: true };
  }

  if (!raw.startsWith("0x") && !raw.startsWith("0X")) {
    if (upper === "EUSDC" || upper === "USDC") {
      return {
        ok: true,
        param: USDC_FROM_ETH_ADDRESS,
        isNativePls: false,
      };
    }
    if (upper === "WPLS") {
      return { ok: true, param: WPLS_ADDRESS, isNativePls: false };
    }
    const core = resolveCoreToken(raw);
    if (core?.address) {
      return { ok: true, param: core.address, isNativePls: false };
    }
    return {
      ok: false,
      reason: `Unknown token symbol '${raw}'. Use PLS for native, a catalogued symbol, or a 0x address.`,
    };
  }

  if (!isAddress(raw)) {
    return { ok: false, reason: `Invalid token address: ${raw}` };
  }
  if (raw.toLowerCase() === SWITCH_NATIVE_SENTINEL.toLowerCase()) {
    return { ok: true, param: SWITCH_NATIVE_SENTINEL, isNativePls: true };
  }
  return { ok: true, param: raw, isNativePls: false };
}

/**
 * Convert percent slippage (0–50) to Switch basis points (0–5000).
 * Pure. Returns undefined if invalid.
 */
export function percentToSlippageBps(percent: number): number | undefined {
  if (!Number.isFinite(percent) || percent < 0 || percent > 50) {
    return undefined;
  }
  const bps = Math.round(percent * 100);
  if (bps < 0 || bps > 5000) return undefined;
  return bps;
}

/**
 * Resolve API key from options or process.env.SWITCH_API_KEY. Pure-ish (env read).
 * Never logs the key value.
 */
export function resolveSwitchApiKey(options?: { apiKey?: string }): string | undefined {
  const fromOpt = options?.apiKey?.trim();
  if (fromOpt) return fromOpt;
  const fromEnv = process.env.SWITCH_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return undefined;
}

/**
 * Build GET URL for Switch quote. Pure.
 * Params: network, from, to, amount, sender?, receiver?, slippage (bps), feeOnOutput?
 */
export function buildSwitchQuoteUrl(
  req: {
    tokenInParam: string;
    tokenOutParam: string;
    amount: string;
    slippageBps: number;
    sender?: string;
    receiver?: string;
    feeOnOutput?: boolean;
  },
  base: string = SWITCH_API_BASE,
): string {
  const root = base.replace(/\/$/, "");
  const params = new URLSearchParams({
    network: SWITCH_DEFAULT_NETWORK,
    from: req.tokenInParam,
    to: req.tokenOutParam,
    amount: req.amount,
    slippage: String(req.slippageBps),
  });
  if (req.sender) params.set("sender", req.sender);
  if (req.receiver) params.set("receiver", req.receiver);
  if (req.feeOnOutput === true) params.set("feeOnOutput", "true");
  if (req.feeOnOutput === false) params.set("feeOnOutput", "false");
  return `${root}/swap/quote?${params.toString()}`;
}

/**
 * Validate + normalize a quote request before HTTP. Pure.
 */
export function buildSwitchQuoteRequest(
  req: SwitchQuoteRequest,
):
  | {
      ok: true;
      tokenInParam: string;
      tokenOutParam: string;
      amount: string;
      slippageBps: number;
      allowedSlippage: number;
      sender?: string;
      receiver?: string;
      feeOnOutput: boolean;
      sellingNativePls: boolean;
    }
  | { ok: false; reason: string } {
  const tokenIn = normalizeSwitchToken(req.tokenIn);
  if (!tokenIn.ok) {
    return { ok: false, reason: `tokenIn: ${tokenIn.reason}` };
  }
  const tokenOut = normalizeSwitchToken(req.tokenOut);
  if (!tokenOut.ok) {
    return { ok: false, reason: `tokenOut: ${tokenOut.reason}` };
  }
  if (tokenIn.param.toLowerCase() === tokenOut.param.toLowerCase()) {
    return { ok: false, reason: "tokenIn and tokenOut must differ" };
  }

  const amount = String(req.amount ?? "").trim();
  if (!/^\d+$/.test(amount) || amount === "") {
    return {
      ok: false,
      reason: "amount must be a non-negative integer string (wei / smallest units)",
    };
  }
  if (amount === "0" || /^0+$/.test(amount)) {
    return { ok: false, reason: "amount must be positive" };
  }

  let slippageBps: number;
  if (req.slippageBps !== undefined && req.slippageBps !== null) {
    const b = Number(req.slippageBps);
    if (!Number.isFinite(b) || b < 0 || b > 5000 || !Number.isInteger(b)) {
      return {
        ok: false,
        reason: `Invalid slippageBps ${req.slippageBps}. Expected integer 0–5000`,
      };
    }
    slippageBps = b;
  } else {
    const percent =
      req.allowedSlippage === undefined || req.allowedSlippage === null
        ? SWITCH_DEFAULT_SLIPPAGE_PERCENT
        : Number(req.allowedSlippage);
    const bps = percentToSlippageBps(percent);
    if (bps === undefined) {
      return {
        ok: false,
        reason: `Invalid allowedSlippage ${req.allowedSlippage}. Expected 0–50 (percent; Switch max 50%)`,
      };
    }
    slippageBps = bps;
  }

  const senderRaw =
    (req.sender != null && String(req.sender).trim() !== ""
      ? String(req.sender).trim()
      : undefined) ??
    (req.account != null && String(req.account).trim() !== ""
      ? String(req.account).trim()
      : undefined);

  let sender: string | undefined;
  if (senderRaw) {
    if (!isAddress(senderRaw)) {
      return { ok: false, reason: `Invalid sender/account address: ${senderRaw}` };
    }
    sender = senderRaw;
  }

  let receiver: string | undefined;
  if (req.receiver != null && String(req.receiver).trim() !== "") {
    const r = String(req.receiver).trim();
    if (!isAddress(r)) {
      return { ok: false, reason: `Invalid receiver address: ${req.receiver}` };
    }
    receiver = r;
  }

  return {
    ok: true,
    tokenInParam: tokenIn.param,
    tokenOutParam: tokenOut.param,
    amount,
    slippageBps,
    allowedSlippage: slippageBps / 100,
    sender,
    receiver,
    feeOnOutput: req.feeOnOutput === true,
    sellingNativePls: tokenIn.isNativePls,
  };
}

function parseTokenTax(v: unknown): SwitchTokenTax | null {
  const r = asRecord(v);
  if (!r) return null;
  return {
    isTaxToken: Boolean(r.isTaxToken),
    buyTaxBps: numOrNull(r.buyTaxBps) ?? 0,
    sellTaxBps: numOrNull(r.sellTaxBps) ?? 0,
  };
}

/**
 * Parse upstream tx object. Requires to + even-length data. Pure.
 * Returns null if unusable (never invents).
 */
export function parseSwitchTx(v: unknown): SwitchTxFields | null {
  const r = asRecord(v);
  if (!r) return null;
  const to = str(r.to).trim();
  const data = str(r.data).trim();
  const value = str(r.value, "0").trim() || "0";
  if (!isAddress(to)) return null;
  if (!isEvenHexData(data)) return null;
  return { to, data, value };
}

/**
 * Floor min-out from expected out and slippage percent (fallback only).
 * Prefer upstream minAmountOut when present.
 */
export function computeAmountOutMin(
  amountOutDecimal: string,
  allowedSlippagePercent: number,
): string | undefined {
  if (!/^\d+$/.test(amountOutDecimal) || amountOutDecimal === "0") {
    return undefined;
  }
  if (
    !Number.isFinite(allowedSlippagePercent) ||
    allowedSlippagePercent < 0 ||
    allowedSlippagePercent > 100
  ) {
    return undefined;
  }
  try {
    const out = BigInt(amountOutDecimal);
    const bps = BigInt(Math.round((100 - allowedSlippagePercent) * 100));
    const min = (out * bps) / 10000n;
    return min.toString(10);
  } catch {
    return undefined;
  }
}

/**
 * Normalize upstream Switch JSON into agent-friendly quote data.
 * Pure. Never invents calldata — requires tx.to + tx.data when prepare-ready.
 * Without sender, upstream may omit `tx`; then quoteReady is false but amounts
 * may still be present for display (amount-only advisory).
 */
export function normalizeSwitchQuote(
  body: unknown,
  meta: {
    tokenInParam: string;
    tokenOutParam: string;
    amount: string;
    slippageBps: number;
    allowedSlippage: number;
    sender?: string;
    receiver?: string;
    feeOnOutput: boolean;
    sellingNativePls: boolean;
    apiKeyConfigured: boolean;
  },
): { ok: true; data: SwitchQuoteData } | { ok: false; reason: string } {
  const root = asRecord(body);
  if (!root) {
    return { ok: false, reason: "Switch returned non-object JSON" };
  }

  // Upstream error envelope
  if (typeof root.error === "string" && root.error.trim()) {
    return { ok: false, reason: `Switch error: ${root.error}` };
  }

  const amountOutRaw =
    str(root.expectedOutputAmount) ||
    str(root.totalAmountOut) ||
    str(root.amountOut) ||
    "0";
  const amountOut = hexOrDecToDecimalWei(amountOutRaw);
  const totalAmountOut = str(root.totalAmountOut)
    ? hexOrDecToDecimalWei(str(root.totalAmountOut))
    : undefined;
  const amountInFromUp = hexOrDecToDecimalWei(str(root.totalAmountIn, "0"));
  const amountIn = amountInFromUp !== "0" ? amountInFromUp : meta.amount;

  const minFromUp = str(root.minAmountOut)
    ? hexOrDecToDecimalWei(str(root.minAmountOut))
    : undefined;
  const amountOutMin =
    minFromUp && minFromUp !== "0"
      ? minFromUp
      : computeAmountOutMin(amountOut, meta.allowedSlippage);

  // Prefer fee-on-output tx when requested and present
  const primaryTx =
    meta.feeOnOutput && root.txFeeOnOutput
      ? parseSwitchTx(root.txFeeOnOutput)
      : parseSwitchTx(root.tx);
  const fallbackTx = parseSwitchTx(root.tx);
  const txParsed = primaryTx ?? fallbackTx;

  // Amount-only quotes (no sender) are allowed as soft success with quoteReady=false
  // when we have positive amountOut; prepare will refuse without tx.
  const amountOutNonZero =
    amountOut !== "" && amountOut !== "0" && !/^0+$/.test(amountOut);

  if (!txParsed) {
    if (!amountOutNonZero) {
      return {
        ok: false,
        reason:
          "Switch response missing usable tx (to/data) and amountOut — " +
          (meta.sender
            ? "re-quote or check pair liquidity"
            : "provide sender/account for executable calldata, or check pair"),
      };
    }
    // Display-only path: no executable calldata
    const data: SwitchQuoteData = {
      fromToken: str(root.fromToken) || meta.tokenInParam,
      toToken: str(root.toToken) || meta.tokenOutParam,
      amountIn,
      totalAmountOut,
      amountOut,
      amountOutMin,
      valueWei: "0",
      valuePls: "0",
      tx: { to: NATIVE_ZERO, data: "0x", value: "0" },
      txFeeOnOutput: null,
      fromTokenTax: parseTokenTax(root.fromTokenTax),
      toTokenTax: parseTokenTax(root.toTokenTax),
      effectiveSlippageBps: numOrNull(root.effectiveSlippageBps),
      effectiveSlippagePercent: str(root.effectiveSlippagePercent) || null,
      feeOnOutput: meta.feeOnOutput,
      tokenInParam: meta.tokenInParam,
      tokenOutParam: meta.tokenOutParam,
      slippageBps: meta.slippageBps,
      allowedSlippage: meta.allowedSlippage,
      sender: meta.sender,
      receiver: meta.receiver ?? (str(root.receiver) || undefined),
      network: SWITCH_DEFAULT_NETWORK,
      chainId: PULSECHAIN_CHAIN_ID,
      quoteReady: false,
      pathSummary:
        "Amount-only quote (no tx). Re-quote with sender/account for prepare-ready calldata.",
      note: QUOTE_NOTE + " This response has no executable tx — quoteReady=false.",
      decodeNote:
        "No calldata yet. Pass sender to switch_quote for tx.to/data/value.",
      apiKeyConfigured: meta.apiKeyConfigured,
    };
    // Use a sentinel empty tx but mark not ready — prepare fails closed
    return { ok: true, data };
  }

  const valueWei = hexOrDecToDecimalWei(txParsed.value);
  if (meta.sellingNativePls && valueWei === "0") {
    return {
      ok: false,
      reason:
        "Selling native PLS but upstream tx.value is zero — refusing unsafe intent",
    };
  }

  let pathSummary: string | null = null;
  const paths = root.paths;
  if (Array.isArray(paths) && paths.length > 0) {
    const names = paths
      .map((p) => {
        const rec = asRecord(p);
        return rec ? str(rec.adapter) : "";
      })
      .filter(Boolean);
    if (names.length) {
      pathSummary = `${paths.length} path(s): ${names.slice(0, 6).join(", ")}`;
    } else {
      pathSummary = `${paths.length} path(s) — full pathfinder omitted; trust exact calldata`;
    }
  }

  const feeTx = parseSwitchTx(root.txFeeOnOutput);

  const data: SwitchQuoteData = {
    fromToken: str(root.fromToken) || meta.tokenInParam,
    toToken: str(root.toToken) || meta.tokenOutParam,
    amountIn,
    totalAmountOut,
    amountOut,
    amountOutMin,
    valueWei: meta.sellingNativePls ? valueWei : "0",
    valuePls: meta.sellingNativePls ? weiToHumanPls(valueWei) : "0",
    tx: txParsed,
    txFeeOnOutput: feeTx,
    fromTokenTax: parseTokenTax(root.fromTokenTax),
    toTokenTax: parseTokenTax(root.toTokenTax),
    effectiveSlippageBps: numOrNull(root.effectiveSlippageBps),
    effectiveSlippagePercent: str(root.effectiveSlippagePercent) || null,
    feeOnOutput: meta.feeOnOutput,
    tokenInParam: meta.tokenInParam,
    tokenOutParam: meta.tokenOutParam,
    slippageBps: meta.slippageBps,
    allowedSlippage: meta.allowedSlippage,
    sender: meta.sender,
    receiver: meta.receiver ?? (str(root.receiver) || undefined),
    network: SWITCH_DEFAULT_NETWORK,
    chainId: PULSECHAIN_CHAIN_ID,
    quoteReady: amountOutNonZero && isEvenHexData(txParsed.data) && isAddress(txParsed.to),
    pathSummary,
    note: QUOTE_NOTE,
    decodeNote:
      "Switch router selectors (e.g. goSwitch) are not in the local ERC-20/PulseX priority decode set. " +
      "inspect_tx_intent may return pattern=unknown / review_carefully — verify review fields and simulation before execute.",
    apiKeyConfigured: meta.apiKeyConfigured,
  };

  return { ok: true, data };
}

/**
 * Map a successful quote into a non-broadcast agent-ready intent.
 * to/data/value from upstream tx only. Pure.
 */
export function prepareSwitchSwap(
  quote: SwitchQuoteData,
  opts?: { account?: string; feeOnOutput?: boolean },
): SwitchPrepareResult {
  const useFeeOnOutput =
    opts?.feeOnOutput === true ||
    (opts?.feeOnOutput === undefined && quote.feeOnOutput === true);

  const txCandidate =
    useFeeOnOutput && quote.txFeeOnOutput && isEvenHexData(quote.txFeeOnOutput.data)
      ? quote.txFeeOnOutput
      : quote.tx;

  if (!txCandidate?.to || !txCandidate?.data) {
    return {
      ok: false,
      source: "switch",
      reason:
        "Quote missing upstream tx.to/tx.data — re-quote with sender/account; never invents calldata",
      advisory: true,
      broadcast: false,
    };
  }
  if (!isAddress(txCandidate.to)) {
    return {
      ok: false,
      source: "switch",
      reason: "Quote tx.to is not a valid address",
      advisory: true,
      broadcast: false,
    };
  }
  if (!isEvenHexData(txCandidate.data)) {
    return {
      ok: false,
      source: "switch",
      reason: "Quote tx.data is not valid even-length hex",
      advisory: true,
      broadcast: false,
    };
  }
  // Refuse placeholder amount-only quotes
  if (
    !quote.quoteReady ||
    txCandidate.data === "0x" ||
    txCandidate.to.toLowerCase() === NATIVE_ZERO.toLowerCase()
  ) {
    return {
      ok: false,
      source: "switch",
      reason:
        "Quote is not prepare-ready (quoteReady=false or empty tx). " +
        "Re-run switch_quote with sender/account for executable calldata.",
      advisory: true,
      broadcast: false,
    };
  }

  const sellingNativePls =
    quote.tokenInParam.toLowerCase() === SWITCH_NATIVE_SENTINEL.toLowerCase() ||
    (quote.valueWei !== "0" && quote.valueWei !== "");

  const valueWei = sellingNativePls
    ? hexOrDecToDecimalWei(txCandidate.value || quote.valueWei)
    : "0";
  const valuePls = weiToHumanPls(valueWei);

  const recipient =
    opts?.account ?? quote.receiver ?? quote.sender;

  return {
    ok: true,
    source: "switch",
    advisory: true,
    broadcast: false,
    intent: {
      to: txCandidate.to,
      data: txCandidate.data,
      valueWei,
      valuePls,
    },
    review: {
      tokenIn: quote.fromToken || quote.tokenInParam,
      tokenOut: quote.toToken || quote.tokenOutParam,
      tokenInParam: quote.tokenInParam,
      tokenOutParam: quote.tokenOutParam,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      amountOutMin: quote.amountOutMin,
      recipient,
      sender: quote.sender,
      allowedSlippage: quote.allowedSlippage,
      slippageBps: quote.slippageBps,
      feeOnOutput: useFeeOnOutput,
      sellingNativePls,
      routerFromUpstream: txCandidate.to,
      localDecodeExpect: "unknown_selector_likely",
      fromTokenTax: quote.fromTokenTax,
      toTokenTax: quote.toTokenTax,
    },
    tx: {
      to: txCandidate.to,
      data: txCandidate.data,
      value: txCandidate.value,
    },
    nextStep:
      "propose_agent_tx({ walletId, to: intent.to, valuePls: intent.valuePls, data: intent.data }) — " +
      "valuePls is human PLS (e.g. \"1\" or \"100000\"), NOT wei. Do not pass valueWei as valuePls. " +
      "to MUST be intent.to from upstream (never hardcode SwitchRouter). " +
      "Then read reviewSummary → execute_agent_tx. Re-quote if aged or eth_call fails.",
    note: PREPARE_NOTE,
  };
}

/**
 * Prepare from a full quote result (success or soft-fail). Pure wrapper.
 */
export function prepareSwitchSwapFromResult(
  result: SwitchQuoteResult,
  opts?: { account?: string; feeOnOutput?: boolean },
): SwitchPrepareResult {
  if (!result.ok) {
    return {
      ok: false,
      source: "switch",
      reason: `Cannot prepare from failed quote: ${result.reason}`,
      advisory: true,
      broadcast: false,
    };
  }
  return prepareSwitchSwap(result.data, opts);
}

// ---------------------------------------------------------------------------
// HTTP (fail-soft)
// ---------------------------------------------------------------------------

function softFail(
  reason: string,
  extra: Partial<SwitchSoftFail> = {},
): SwitchSoftFail {
  return { ok: false, source: "switch", advisory: true, reason, ...extra };
}

/** Auth soft-fail fields shared by missing key / 401 / 403. Pure. */
export function switchAuthSoftFailFields(): Pick<
  SwitchSoftFail,
  "authRequired" | "operatorGated" | "requestApiKeyUrl" | "nextStep" | "preferKeyless"
> {
  return {
    authRequired: true,
    operatorGated: true,
    requestApiKeyUrl: SWITCH_API_KEY_REQUEST_URL,
    nextStep: SWITCH_AUTH_OPERATOR_NEXT_STEP,
    preferKeyless: "piteas_quote",
  };
}

export async function switchGetJson(
  url: string,
  config: Pick<AppConfig, "httpTimeoutMs">,
  options: SwitchFetchOptions = {},
): Promise<
  | { ok: true; status: number; body: unknown; url: string }
  | {
      ok: false;
      reason: string;
      status?: number;
      url: string;
      authRequired?: true;
      operatorGated?: true;
      requestApiKeyUrl?: typeof SWITCH_API_KEY_REQUEST_URL;
      nextStep?: string;
      preferKeyless?: "piteas_quote";
    }
> {
  const timeoutMs = options.timeoutMs ?? config.httpTimeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = resolveSwitchApiKey(options);

  if (!apiKey) {
    return {
      ok: false,
      reason: SWITCH_AUTH_GUIDANCE.missingKey,
      status: 401,
      url,
      ...switchAuthSoftFailFields(),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "x-api-key": apiKey,
      },
    });

    if (res.status === 401) {
      return {
        ok: false,
        reason: SWITCH_AUTH_GUIDANCE.unauthorized,
        status: 401,
        url,
        ...switchAuthSoftFailFields(),
      };
    }
    if (res.status === 403) {
      return {
        ok: false,
        reason: SWITCH_AUTH_GUIDANCE.forbidden,
        status: 403,
        url,
        ...switchAuthSoftFailFields(),
      };
    }
    if (res.status === 429) {
      return {
        ok: false,
        reason:
          "Switch rate limit (HTTP 429). Per-key and per-IP limits apply; back off and retry.",
        status: 429,
        url,
      };
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return {
        ok: false,
        reason: `Switch returned invalid JSON (HTTP ${res.status})`,
        status: res.status,
        url,
      };
    }

    if (!res.ok) {
      const rec = asRecord(parsed);
      const msg =
        (rec && typeof rec.error === "string" && rec.error) ||
        (rec && typeof rec.message === "string" && rec.message) ||
        `Switch HTTP ${res.status}`;
      return { ok: false, reason: msg, status: res.status, url };
    }

    return { ok: true, status: res.status, body: parsed, url };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        reason: `Switch request timed out after ${timeoutMs}ms`,
        url,
      };
    }
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `Switch network error: ${err.message}`
          : "Switch network error",
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Request a Switch aggregator quote. Fail-soft; never broadcasts; never invents calldata.
 */
export async function getSwitchQuote(
  config: Pick<AppConfig, "httpTimeoutMs">,
  req: SwitchQuoteRequest,
  options: SwitchFetchOptions = {},
): Promise<SwitchQuoteResult> {
  const built = buildSwitchQuoteRequest(req);
  if (!built.ok) {
    return softFail(built.reason);
  }

  const apiKey = resolveSwitchApiKey(options);
  const apiKeyConfigured = Boolean(apiKey);

  const url = buildSwitchQuoteUrl(
    {
      tokenInParam: built.tokenInParam,
      tokenOutParam: built.tokenOutParam,
      amount: built.amount,
      slippageBps: built.slippageBps,
      sender: built.sender,
      receiver: built.receiver,
      feeOnOutput: built.feeOnOutput,
    },
    options.apiBase ?? SWITCH_API_BASE,
  );

  const res = await switchGetJson(url, config, options);
  if (!res.ok) {
    return softFail(res.reason, {
      status: res.status,
      authRequired: res.authRequired,
      operatorGated: res.operatorGated,
      requestApiKeyUrl: res.requestApiKeyUrl,
      nextStep: res.nextStep,
      preferKeyless: res.preferKeyless,
    });
  }

  const normalized = normalizeSwitchQuote(res.body, {
    tokenInParam: built.tokenInParam,
    tokenOutParam: built.tokenOutParam,
    amount: built.amount,
    slippageBps: built.slippageBps,
    allowedSlippage: built.allowedSlippage,
    sender: built.sender,
    receiver: built.receiver,
    feeOnOutput: built.feeOnOutput,
    sellingNativePls: built.sellingNativePls,
    apiKeyConfigured,
  });

  if (!normalized.ok) {
    return softFail(normalized.reason);
  }

  return {
    ok: true,
    source: "switch",
    advisory: true,
    data: normalized.data,
  };
}
