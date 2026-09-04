/**
 * Piteas DEX aggregator quote client (public SDK, no API key).
 * Docs: https://docs.piteas.io/piteas-sdk-api
 * Quote: GET https://sdk.piteas.io/quote
 *
 * Preferred aggregator assist for PulseChain — not a guaranteed best-price oracle.
 * Quote-only / advisory until wallet propose → review → execute.
 * Never invents routes or calldata; preserves upstream methodParameters exactly.
 *
 * Native token: use tokenInAddress / tokenOutAddress = **PLS** (Piteas convention).
 * Rate limit (upstream beta): ~10 req/min — soft-fail on 429.
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

/** Public Piteas SDK quote base. */
export const PITEAS_API_BASE = "https://sdk.piteas.io" as const;

/** Official PiteasRouter (docs.piteas.io) — destination for prepared swap txs. */
export const PITEAS_ROUTER =
  "0x6BF228eb7F8ad948d37deD07E595EfddfaAF88A6" as const;

/** Piteas native token token for query params. */
export const PITEAS_NATIVE_PLS = "PLS" as const;

/** Zero address often used elsewhere for native; maps to Piteas PLS. */
export const NATIVE_ZERO =
  "0x0000000000000000000000000000000000000000" as const;

const QUOTE_NOTE =
  "Piteas aggregator quote (advisory). Preferred assist for multi-hop routes on PulseChain — " +
  "not a guaranteed best-price oracle across all venues. " +
  "Does NOT broadcast. Use piteas_prepare_swap → propose_agent_tx → review → execute_agent_tx. " +
  "Calldata is exact upstream methodParameters; local wallet decode may show unknown selector. " +
  "Quotes expire; re-quote before send. Upstream beta rate limit ~10/min.";

const PREPARE_NOTE =
  "Agent-ready tx intent from a Piteas quote. Does NOT broadcast. " +
  "to = PiteasRouter; data = exact upstream calldata; valueWei from methodParameters when selling native PLS. " +
  "intent.valuePls is human PLS for propose_agent_tx (never pass valueWei as valuePls — 1e18× overshoot). " +
  "Local inspect_tx_intent may report unknown selector — verify review fields (tokenIn/out, amountIn, amountOutMin, recipient) before execute.";

export interface PiteasSoftFail {
  ok: false;
  source: "piteas";
  reason: string;
  status?: number;
  advisory: true;
}

export interface PiteasTokenMeta {
  address: string;
  symbol?: string;
  decimals?: number;
  chainId?: number;
}

export interface PiteasMethodParameters {
  /** Exact upstream hex calldata — never reinvented. */
  calldata: string;
  /** Hex or decimal wei string from upstream. */
  value: string;
}

export interface PiteasRouteSummary {
  pathCount?: number;
  swapCount?: number;
  protocols?: string[];
  pools?: string[];
  tokenPath?: string[];
  router?: string;
  allocations?: Array<Record<string, unknown>>;
  /** Canonical, non-calldata route signature for comparing quote continuity. */
  signature?: string;
  /** Truncated route detail for review (not full pathfinder dump). */
  note?: string;
}

export interface PiteasQuoteData {
  srcToken: PiteasTokenMeta;
  destToken: PiteasTokenMeta;
  /** Request amount in (decimal wei string). */
  amountIn: string;
  /** Expected amount out (decimal wei string, token smallest units). */
  amountOut: string;
  /**
   * Min out from slippage math when computable (decimal wei string).
   * Review aid — on-chain min is encoded in exact calldata.
   */
  amountOutMin?: string;
  /** Native PLS value to attach (decimal wei string); "0" when not selling native. */
  valueWei: string;
  /**
   * Human PLS amount for propose_agent_tx `valuePls` (formatEther of valueWei).
   * Never pass valueWei into valuePls — that overshoots by 1e18.
   */
  valuePls?: string;
  gasUseEstimate?: number | null;
  gasUseEstimateUSD?: number | null;
  /** Piteas-reported price impact percentage when upstream provides it. */
  priceImpactPercent?: number | null;
  /** Upstream quote block number when provided. */
  blockNumber?: string | null;
  /** Upstream quote timestamp when provided. */
  quoteTimestamp?: string | null;
  /** Upstream quote/request identifier when provided. */
  quoteIdentifier?: string | null;
  /** Upstream quote expiry/valid-until timestamp when provided. */
  expiresAt?: string | null;
  /** Cache-related response headers preserved from the quote request when available. */
  cacheHeaders?: Record<string, string> | null;
  /** Stable fingerprint of the normalized upstream JSON response body. */
  responseFingerprint?: string | null;
  /** Quote endpoint without query params. */
  endpoint?: string;
  /** Upstream/client retry count when reported. */
  retryCount?: number;
  methodParameters: PiteasMethodParameters;
  /** Always the documented PiteasRouter. */
  router: typeof PITEAS_ROUTER;
  route?: PiteasRouteSummary | null;
  /** Normalized request sides as sent to API (PLS or 0x…). */
  tokenInParam: string;
  tokenOutParam: string;
  allowedSlippage: number;
  account?: string;
  chainId: number;
  quoteReady: boolean;
  note: string;
  /** Agent/operator honesty: local MCP may not decode Piteas selectors. */
  decodeNote: string;
}

export interface PiteasQuoteSuccess {
  ok: true;
  source: "piteas";
  advisory: true;
  data: PiteasQuoteData;
}

export type PiteasQuoteResult = PiteasQuoteSuccess | PiteasSoftFail;

export interface PiteasQuoteRequest {
  tokenIn: string;
  tokenOut: string;
  /** Amount in smallest units (integer decimal string) or PLS whole units not accepted — always wei. */
  amount: string;
  /** 0–100; default 0.5 (matches upstream docs). */
  allowedSlippage?: number;
  /** Recipient / account when required by route construction. */
  account?: string;
}

export interface PiteasPrepareSwapResult {
  ok: true;
  source: "piteas";
  advisory: true;
  broadcast: false;
  intent: {
    to: typeof PITEAS_ROUTER;
    data: string;
    /** Decimal wei string for eth_call / low-level send. */
    valueWei: string;
    /**
     * Human PLS for propose_agent_tx({ valuePls }) — NOT wei.
     * Example: 1 PLS → valuePls "1", valueWei "1000000000000000000".
     */
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
    allowedSlippage: number;
    router: typeof PITEAS_ROUTER;
    sellingNativePls: boolean;
    localDecodeExpect: "unknown_selector_likely";
    gasUseEstimate?: number | null;
  };
  /** Exact methodParameters from quote (calldata never rewritten). */
  methodParameters: PiteasMethodParameters;
  nextStep: string;
  note: string;
}

export interface PiteasPrepareSoftFail {
  ok: false;
  source: "piteas";
  reason: string;
  advisory: true;
  broadcast: false;
}

export type PiteasPrepareResult = PiteasPrepareSwapResult | PiteasPrepareSoftFail;

type DexFetch = typeof fetch;

export interface PiteasFetchOptions {
  timeoutMs?: number;
  fetchImpl?: DexFetch;
  /** Override API base (tests). */
  apiBase?: string;
  /** Skip process-wide 10/min limiter (unit tests with mock fetch). */
  skipSpacing?: boolean;
  /** Abort in-flight limiter wait + HTTP (outer quote timeouts). */
  signal?: AbortSignal;
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

function firstTimestampString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = str(value).trim();
    if (text !== "") return text;
  }
  return null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function stableFingerprint(value: unknown): string {
  const text = stableJson(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function cacheHeadersFromResponse(res: Response): Record<string, string> {
  const headers = res.headers;
  if (!headers || typeof headers.get !== "function") return {};
  const names = [
    "age",
    "cache-control",
    "cf-cache-status",
    "etag",
    "expires",
    "last-modified",
    "x-cache",
    "x-cache-status",
    "x-served-by",
  ];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null && value !== "") out[name] = value;
  }
  return out;
}

function collectRouteStrings(
  value: unknown,
  path: string[],
  out: {
    protocols: string[];
    pools: string[];
    tokenPath: string[];
    allocations: Array<Record<string, unknown>>;
  },
): void {
  if (Array.isArray(value)) {
    for (const [idx, child] of value.entries()) {
      collectRouteStrings(child, [...path, String(idx)], out);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;

  const allocation: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    const lowered = key.toLowerCase();
    if (
      lowered.includes("protocol") ||
      lowered === "dex" ||
      lowered === "exchange" ||
      lowered === "name"
    ) {
      const text = str(child);
      if (text) {
        out.protocols.push(text);
        allocation.protocol = text;
      }
    }
    if (
      lowered.includes("pool") ||
      lowered.includes("pair") ||
      lowered.includes("market")
    ) {
      const text = str(child);
      if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
        out.pools.push(text.toLowerCase());
        allocation.pool = text.toLowerCase();
      }
    }
    if (
      lowered.includes("token") ||
      lowered === "from" ||
      lowered === "to" ||
      lowered === "address"
    ) {
      const text = str(child);
      if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
        out.tokenPath.push(text.toLowerCase());
      }
    }
    if (
      lowered.includes("percent") ||
      lowered.includes("share") ||
      lowered.includes("weight") ||
      lowered.includes("allocation") ||
      lowered === "part" ||
      lowered === "bps"
    ) {
      const text = str(child);
      if (text) allocation[key] = text;
    }
  }
  if (Object.keys(allocation).length > 0) out.allocations.push(allocation);

  for (const [key, child] of Object.entries(record)) {
    collectRouteStrings(child, [...path, key], out);
  }
}

function buildRouteSummary(
  routeRec: Record<string, unknown>,
  meta: {
    pathCount?: number;
    swapCount?: number;
    tokenInParam: string;
    tokenOutParam: string;
  },
): PiteasRouteSummary {
  const collected = {
    protocols: [] as string[],
    pools: [] as string[],
    tokenPath: [] as string[],
    allocations: [] as Array<Record<string, unknown>>,
  };
  collectRouteStrings(routeRec, [], collected);

  const tokenPath = uniqueStrings([
    meta.tokenInParam.toLowerCase(),
    ...collected.tokenPath,
    meta.tokenOutParam.toLowerCase(),
  ]);
  const protocols = uniqueStrings(collected.protocols);
  const pools = uniqueStrings(collected.pools);
  const allocations = collected.allocations.slice(0, 20);
  const signatureParts = {
    protocols,
    pools,
    tokenPath,
    router: PITEAS_ROUTER.toLowerCase(),
    allocations,
    fallbackStructure:
      protocols.length === 0 && pools.length === 0
        ? {
            pathCount: meta.pathCount ?? null,
            swapCount: meta.swapCount ?? null,
          }
        : undefined,
  };

  return {
    pathCount: meta.pathCount,
    swapCount: meta.swapCount,
    protocols,
    pools,
    tokenPath,
    router: PITEAS_ROUTER,
    allocations,
    signature: stableJson(signatureParts),
    note: "Route summary only — full pathfinder paths omitted; trust exact calldata",
  };
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
 * Uses viem formatEther — same unit convention as wallet parsePlsToWei inverse.
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
 * Normalize a user token input for Piteas query params.
 * - PLS / native / zero address → "PLS"
 * - WPLS address kept as 0x (wrapped path; not auto-unwrapped)
 * - Catalogued symbols (eUSDC, USDC, HEX, …) → address via resolveCoreToken
 * - 0x addresses validated
 * Pure — returns { ok, param } or { ok:false, reason }.
 */
export function normalizePiteasToken(
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
    raw.toLowerCase() === NATIVE_ZERO.toLowerCase()
  ) {
    return { ok: true, param: PITEAS_NATIVE_PLS, isNativePls: true };
  }

  // Catalogued symbols (not addresses)
  if (!raw.startsWith("0x") && !raw.startsWith("0X")) {
    // Common aliases not all in CORE_TOKENS keys
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
  return { ok: true, param: raw, isNativePls: false };
}

/**
 * Build GET query URL for Piteas quote. Pure.
 */
export function buildPiteasQuoteUrl(
  req: {
    tokenInParam: string;
    tokenOutParam: string;
    amount: string;
    allowedSlippage: number;
    account?: string;
  },
  base: string = PITEAS_API_BASE,
): string {
  const root = base.replace(/\/$/, "");
  const params = new URLSearchParams({
    tokenInAddress: req.tokenInParam,
    tokenOutAddress: req.tokenOutParam,
    amount: req.amount,
    allowedSlippage: String(req.allowedSlippage),
  });
  if (req.account) {
    params.set("account", req.account);
  }
  return `${root}/quote?${params.toString()}`;
}

/**
 * Validate + normalize a quote request before HTTP. Pure.
 */
export function buildPiteasQuoteRequest(
  req: PiteasQuoteRequest,
):
  | {
      ok: true;
      tokenInParam: string;
      tokenOutParam: string;
      amount: string;
      allowedSlippage: number;
      account?: string;
      sellingNativePls: boolean;
    }
  | { ok: false; reason: string } {
  const tokenIn = normalizePiteasToken(req.tokenIn);
  if (!tokenIn.ok) {
    return { ok: false, reason: `tokenIn: ${tokenIn.reason}` };
  }
  const tokenOut = normalizePiteasToken(req.tokenOut);
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

  const slip =
    req.allowedSlippage === undefined || req.allowedSlippage === null
      ? 0.5
      : Number(req.allowedSlippage);
  if (!Number.isFinite(slip) || slip < 0 || slip > 100) {
    return {
      ok: false,
      reason: `Invalid allowedSlippage ${req.allowedSlippage}. Expected 0–100`,
    };
  }

  let account: string | undefined;
  if (req.account != null && String(req.account).trim() !== "") {
    const a = String(req.account).trim();
    if (!isAddress(a)) {
      return { ok: false, reason: `Invalid account address: ${req.account}` };
    }
    account = a;
  }

  return {
    ok: true,
    tokenInParam: tokenIn.param,
    tokenOutParam: tokenOut.param,
    amount,
    allowedSlippage: slip,
    account,
    sellingNativePls: tokenIn.isNativePls,
  };
}

/**
 * Floor min-out from expected out and slippage percent.
 * amountOutMin = amountOut * (100 - slip) / 100 (integer floor).
 * Pure. Returns undefined if amountOut is not a positive integer string.
 */
export function computeAmountOutMin(
  amountOutDecimal: string,
  allowedSlippage: number,
): string | undefined {
  if (!/^\d+$/.test(amountOutDecimal) || amountOutDecimal === "0") {
    return undefined;
  }
  if (!Number.isFinite(allowedSlippage) || allowedSlippage < 0 || allowedSlippage > 100) {
    return undefined;
  }
  try {
    const out = BigInt(amountOutDecimal);
    // basis points: min = out * (10000 - slip*100) / 10000
    const bps = BigInt(Math.round((100 - allowedSlippage) * 100));
    const min = (out * bps) / 10000n;
    return min.toString(10);
  } catch {
    return undefined;
  }
}

/**
 * Normalize upstream Piteas JSON into agent-friendly quote data.
 * Pure. Never invents calldata — requires methodParameters.calldata.
 */
export function normalizePiteasQuote(
  body: unknown,
  meta: {
    tokenInParam: string;
    tokenOutParam: string;
    amount: string;
    allowedSlippage: number;
    account?: string;
    sellingNativePls: boolean;
  },
  transportMeta: {
    cacheHeaders?: Record<string, string> | null;
    responseFingerprint?: string | null;
  } = {},
): { ok: true; data: PiteasQuoteData } | { ok: false; reason: string } {
  const root = asRecord(body);
  if (!root) {
    return { ok: false, reason: "Piteas returned non-object JSON" };
  }

  const mp = asRecord(root.methodParameters);
  if (!mp) {
    return {
      ok: false,
      reason:
        "Piteas response missing methodParameters (no executable calldata). Re-quote or check pair liquidity.",
    };
  }
  const calldata = str(mp.calldata);
  if (!isEvenHexData(calldata)) {
    return {
      ok: false,
      reason:
        "Piteas methodParameters.calldata missing or not even-length hex — refusing to invent calldata",
    };
  }

  const valueRaw = str(mp.value, "0x0");
  const valueWei = hexOrDecToDecimalWei(valueRaw);

  const srcTok = asRecord(root.srcToken) ?? {};
  const destTok = asRecord(root.destToken) ?? {};
  const amountOut = hexOrDecToDecimalWei(str(root.destAmount, "0"));
  const amountInFromUp = hexOrDecToDecimalWei(str(root.srcAmount, "0"));
  const amountIn =
    amountInFromUp !== "0" ? amountInFromUp : meta.amount;

  const amountOutMin = computeAmountOutMin(amountOut, meta.allowedSlippage);

  // When selling native, value should match amountIn; if upstream zeros value incorrectly, fail closed
  if (meta.sellingNativePls && valueWei === "0") {
    return {
      ok: false,
      reason:
        "Selling native PLS but methodParameters.value is zero — refusing unsafe intent",
    };
  }

  let route: PiteasRouteSummary | null = null;
  const routeRec = asRecord(root.route);
  if (routeRec) {
    const paths = routeRec.paths;
    const swaps = routeRec.swaps;
    route = buildRouteSummary(routeRec, {
      pathCount: Array.isArray(paths) ? paths.length : undefined,
      swapCount: Array.isArray(swaps) ? swaps.length : undefined,
      tokenInParam: meta.tokenInParam,
      tokenOutParam: meta.tokenOutParam,
    });
  }

  const amountOutNonZero =
    amountOut !== "" && amountOut !== "0" && !/^0+$/.test(amountOut);

  const data: PiteasQuoteData = {
    srcToken: {
      address: str(srcTok.address) || meta.tokenInParam,
      symbol: str(srcTok.symbol) || undefined,
      decimals: numOrNull(srcTok.decimals) ?? undefined,
      chainId: numOrNull(srcTok.chainId) ?? PULSECHAIN_CHAIN_ID,
    },
    destToken: {
      address: str(destTok.address) || meta.tokenOutParam,
      symbol: str(destTok.symbol) || undefined,
      decimals: numOrNull(destTok.decimals) ?? undefined,
      chainId: numOrNull(destTok.chainId) ?? PULSECHAIN_CHAIN_ID,
    },
    amountIn,
    amountOut,
    amountOutMin,
    valueWei: meta.sellingNativePls ? valueWei : "0",
    valuePls: meta.sellingNativePls ? weiToHumanPls(valueWei) : "0",
    gasUseEstimate: numOrNull(root.gasUseEstimate),
    gasUseEstimateUSD: numOrNull(root.gasUseEstimateUSD),
    priceImpactPercent: numOrNull(
      root.priceImpactPercent ??
        root.priceImpactPercentage ??
        root.priceImpact ??
        root.price_impact,
    ),
    blockNumber: str(root.blockNumber ?? root.block_number ?? root.block, "") || null,
    quoteTimestamp: firstTimestampString(
      root.quoteTimestamp,
      root.quote_timestamp,
      root.timestamp,
      root.updatedAt,
      root.updated_at,
    ),
    quoteIdentifier:
      str(
        root.quoteIdentifier ??
          root.quoteId ??
          root.quote_id ??
          root.id ??
          root.requestId ??
          root.request_id ??
          root.uuid,
        "",
      ) || null,
    expiresAt: firstTimestampString(
      root.expiresAt,
      root.expires_at,
      root.expiry,
      root.expiration,
      root.validUntil,
      root.valid_until,
      root.deadline,
    ),
    cacheHeaders: transportMeta.cacheHeaders ?? null,
    responseFingerprint: transportMeta.responseFingerprint ?? stableFingerprint(body),
    retryCount: numOrNull(root.retryCount ?? root.retry_count) ?? 0,
    methodParameters: {
      calldata,
      value: valueRaw.startsWith("0x") ? valueRaw : `0x${BigInt(valueWei).toString(16)}`,
    },
    router: PITEAS_ROUTER,
    route,
    tokenInParam: meta.tokenInParam,
    tokenOutParam: meta.tokenOutParam,
    allowedSlippage: meta.allowedSlippage,
    account: meta.account,
    chainId: PULSECHAIN_CHAIN_ID,
    quoteReady: amountOutNonZero && isEvenHexData(calldata),
    note: QUOTE_NOTE,
    decodeNote:
      "Piteas router selectors are not in the local ERC-20/PulseX priority decode set. " +
      "inspect_tx_intent may return pattern=unknown / review_carefully — verify review fields and simulation before execute.",
  };

  return { ok: true, data };
}

/**
 * Map a successful quote into a non-broadcast agent-ready intent.
 * Preserves exact upstream calldata. Pure.
 */
export function preparePiteasSwap(
  quote: PiteasQuoteData,
  opts?: { account?: string },
): PiteasPrepareResult {
  if (!quote?.methodParameters?.calldata) {
    return {
      ok: false,
      source: "piteas",
      reason: "Quote missing methodParameters.calldata",
      advisory: true,
      broadcast: false,
    };
  }
  if (!isEvenHexData(quote.methodParameters.calldata)) {
    return {
      ok: false,
      source: "piteas",
      reason: "Quote calldata is not valid even-length hex",
      advisory: true,
      broadcast: false,
    };
  }
  if (!quote.quoteReady) {
    return {
      ok: false,
      source: "piteas",
      reason: "Quote is not ready (zero amountOut or unusable calldata)",
      advisory: true,
      broadcast: false,
    };
  }

  const sellingNativePls =
    quote.tokenInParam.toUpperCase() === PITEAS_NATIVE_PLS ||
    (quote.valueWei !== "0" && quote.valueWei !== "");

  const valueWei = sellingNativePls
    ? hexOrDecToDecimalWei(quote.methodParameters.value || quote.valueWei)
    : "0";
  const valuePls = weiToHumanPls(valueWei);

  const recipient = opts?.account ?? quote.account;

  return {
    ok: true,
    source: "piteas",
    advisory: true,
    broadcast: false,
    intent: {
      to: PITEAS_ROUTER,
      data: quote.methodParameters.calldata,
      valueWei,
      valuePls,
    },
    review: {
      tokenIn: quote.srcToken.address || quote.tokenInParam,
      tokenOut: quote.destToken.address || quote.tokenOutParam,
      tokenInParam: quote.tokenInParam,
      tokenOutParam: quote.tokenOutParam,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      amountOutMin: quote.amountOutMin,
      recipient,
      allowedSlippage: quote.allowedSlippage,
      router: PITEAS_ROUTER,
      sellingNativePls,
      localDecodeExpect: "unknown_selector_likely",
      gasUseEstimate: quote.gasUseEstimate,
    },
    methodParameters: {
      calldata: quote.methodParameters.calldata,
      value: quote.methodParameters.value,
    },
    nextStep:
      "propose_agent_tx({ walletId, to: intent.to, valuePls: intent.valuePls, data: intent.data }) — " +
      "valuePls is human PLS (e.g. \"1\" or \"100000\"), NOT wei. Do not pass valueWei as valuePls. " +
      "Then read reviewSummary (destination Piteas router, native value, gas) → execute_agent_tx. " +
      "Do not invent alternate calldata. Re-quote if the proposal ages or eth_call fails.",
    note: PREPARE_NOTE,
  };
}

/**
 * Prepare from a full quote result (success or soft-fail). Pure wrapper.
 */
export function preparePiteasSwapFromResult(
  result: PiteasQuoteResult,
  opts?: { account?: string },
): PiteasPrepareResult {
  if (!result.ok) {
    return {
      ok: false,
      source: "piteas",
      reason: `Cannot prepare from failed quote: ${result.reason}`,
      advisory: true,
      broadcast: false,
    };
  }
  return preparePiteasSwap(result.data, opts);
}

// ---------------------------------------------------------------------------
// HTTP (fail-soft)
// ---------------------------------------------------------------------------

function softFail(
  reason: string,
  extra: Partial<PiteasSoftFail> = {},
): PiteasSoftFail {
  return { ok: false, source: "piteas", advisory: true, reason, ...extra };
}

/** Upstream beta ~10 req/min; exceeding can block for ~1h. */
export const PITEAS_MAX_REQUESTS_PER_MINUTE = 10;
const PITEAS_WINDOW_MS = 60_000;

let piteasTimestamps: number[] = [];
let piteasChain: Promise<void> = Promise.resolve();

/** Test helper: reset process-wide Piteas limiter. */
export function resetPiteasRateLimit(): void {
  piteasTimestamps = [];
  piteasChain = Promise.resolve();
}

async function respectPiteasRateLimit(signal?: AbortSignal): Promise<void> {
  const run = async () => {
    if (signal?.aborted) {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
    const now = Date.now();
    piteasTimestamps = piteasTimestamps.filter((t) => now - t < PITEAS_WINDOW_MS);
    if (piteasTimestamps.length >= PITEAS_MAX_REQUESTS_PER_MINUTE) {
      const wait = PITEAS_WINDOW_MS - (now - piteasTimestamps[0]!) + 25;
      if (wait > 0) {
        await abortableDelay(wait, signal);
      }
      const later = Date.now();
      piteasTimestamps = piteasTimestamps.filter((t) => later - t < PITEAS_WINDOW_MS);
    }
    if (signal?.aborted) {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
    piteasTimestamps.push(Date.now());
  };
  const queued = piteasChain.then(run, run);
  // Swallow so one aborted/failed waiter cannot permanently jam the queue.
  piteasChain = queued.then(
    () => undefined,
    () => undefined,
  );
  await queued;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function piteasGetJson(
  url: string,
  config: Pick<AppConfig, "httpTimeoutMs">,
  options: PiteasFetchOptions = {},
): Promise<
  | {
      ok: true;
      status: number;
      body: unknown;
      url: string;
      cacheHeaders: Record<string, string>;
      responseFingerprint: string;
    }
  | { ok: false; reason: string; status?: number; url: string }
> {
  const timeoutMs = options.timeoutMs ?? config.httpTimeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    if (!options.skipSpacing) {
      await respectPiteasRateLimit(controller.signal);
    }
    const res = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    if (res.status === 429) {
      return {
        ok: false,
        reason:
          "Piteas rate limit (HTTP 429). Upstream beta ~10/min; blocked for ~1h if exceeded. Retry later.",
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
        reason: `Piteas returned invalid JSON (HTTP ${res.status})`,
        status: res.status,
        url,
      };
    }

    if (!res.ok) {
      const rec = asRecord(parsed);
      const msg =
        (rec && typeof rec.message === "string" && rec.message) ||
        (rec && typeof rec.error === "string" && rec.error) ||
        `Piteas HTTP ${res.status}`;
      return { ok: false, reason: msg, status: res.status, url };
    }

    return {
      ok: true,
      status: res.status,
      body: parsed,
      url,
      cacheHeaders: cacheHeadersFromResponse(res),
      responseFingerprint: stableFingerprint(parsed),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        reason: `Piteas request timed out after ${timeoutMs}ms`,
        url,
      };
    }
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `Piteas network error: ${err.message}`
          : "Piteas network error",
      url,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Request a Piteas aggregator quote. Fail-soft; never broadcasts; never invents calldata.
 */
export async function getPiteasQuote(
  config: Pick<AppConfig, "httpTimeoutMs">,
  req: PiteasQuoteRequest,
  options: PiteasFetchOptions = {},
): Promise<PiteasQuoteResult> {
  const built = buildPiteasQuoteRequest(req);
  if (!built.ok) {
    return softFail(built.reason);
  }

  const url = buildPiteasQuoteUrl(
    {
      tokenInParam: built.tokenInParam,
      tokenOutParam: built.tokenOutParam,
      amount: built.amount,
      allowedSlippage: built.allowedSlippage,
      account: built.account,
    },
    options.apiBase ?? PITEAS_API_BASE,
  );

  const res = await piteasGetJson(url, config, options);
  if (!res.ok) {
    return softFail(res.reason, { status: res.status });
  }

  const normalized = normalizePiteasQuote(res.body, {
    tokenInParam: built.tokenInParam,
    tokenOutParam: built.tokenOutParam,
    amount: built.amount,
    allowedSlippage: built.allowedSlippage,
    account: built.account,
    sellingNativePls: built.sellingNativePls,
  }, {
    cacheHeaders: res.cacheHeaders,
    responseFingerprint: res.responseFingerprint,
  });

  if (!normalized.ok) {
    return softFail(normalized.reason);
  }
  normalized.data.endpoint = `${options.apiBase ?? PITEAS_API_BASE}/quote`;
  normalized.data.retryCount ??= 0;

  return {
    ok: true,
    source: "piteas",
    advisory: true,
    data: normalized.data,
  };
}
