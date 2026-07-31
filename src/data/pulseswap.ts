/**
 * PulseSwap multi-DEX quote client (public, no API key).
 * Docs: https://docs.pulseswap.io/integrations/api-reference
 * Base: https://quotes.pulseswap.io/api/v2
 *
 * PulseChain chainId: 369 only.
 * Quote-only / advisory — does not broadcast or require wallets.
 * When userAddress is set, upstream may return `tx` calldata; we surface it
 * as opaque advisory fields and never execute.
 *
 * Rate limit (upstream): ~60 req/min/IP.
 */

import type { AppConfig } from "../types.js";
import { assertAddress, isAddress } from "../utils/safety.js";
import { PULSECHAIN_CHAIN_ID } from "../constants.js";

/** Official PulseSwap quotes API base. */
export const PULSESWAP_API_BASE =
  "https://quotes.pulseswap.io/api/v2" as const;

/** Supported platforms (case-sensitive per upstream). */
export const PULSESWAP_PLATFORMS = [
  "pulsex_v1",
  "pulsex_v2",
  "pulsex_stable",
  "9inch_v2",
  "9inch_v3",
  "9mm_v2",
  "9mm_v3",
  "phux_v2",
  "tide_v3",
  "mixed",
] as const;

export type PulseSwapPlatform = (typeof PULSESWAP_PLATFORMS)[number];

/** Native PLS sentinel for quotes (auto-wrapped to WPLS upstream). */
export const PULSESWAP_NATIVE_PLS =
  "0x0000000000000000000000000000000000000000" as const;

export interface PulseSwapSoftFail {
  ok: false;
  source: "pulseswap";
  reason: string;
  status?: number;
  path?: string;
  platform?: string;
}

export interface PulseSwapQuoteData {
  quoteId?: string | null;
  /**
   * Effective amountIn for agents: requested amount when upstream returns
   * "0"/empty; otherwise the upstream value. Prefer amountInRequested when
   * comparing to the caller's input.
   */
  amountIn: string;
  /** Exact amountIn from the request (wei string). Always present when known. */
  amountInRequested?: string;
  /** Raw amountIn from upstream body (may be "0" even when quote is usable). */
  amountInUpstream?: string;
  amountOut: string;
  amountOutUSD?: string | null;
  gasEstimate?: number | null;
  platform: string;
  chainId: number;
  fromToken: string;
  toToken: string;
  slippage: number;
  mode: "standard" | "advanced";
  /**
   * True when upstream success flags are set and amountOut is non-zero-ish.
   * Advisory amountOut only — never means execution-ready or USD-priced.
   * See priceUsdReady / executionReady.
   */
  quoteReady: boolean;
  /**
   * True only when amountOutUSD is a finite positive number string.
   * Zero/empty amountOutUSD → false (do not treat as USD quote).
   */
  priceUsdReady: boolean;
  /**
   * Always false for this MCP path. Quotes are advisory; this tool does not
   * broadcast. Partial upstream (e.g. amountIn "0") never implies execution readiness.
   */
  executionReady: false;
  /** True when upstream amountIn was empty/zero (amountIn field may still echo request). */
  amountInUpstreamZero: boolean;
  /** Upstream outer + inner success flags for debugging. */
  upstream: {
    outerSuccess: boolean;
    innerSuccess: boolean;
    message?: string | null;
    timestamp?: string | null;
  };
  /**
   * Opaque advisory calldata when userAddress was supplied.
   * Never execute via this MCP — quotes expire quickly; use wallet tools separately.
   */
  txAdvisory?: {
    from?: string;
    to?: string;
    data?: string;
    value?: string;
    warning: string;
  } | null;
  note: string;
}

export interface PulseSwapSuccess {
  ok: true;
  source: "pulseswap";
  advisory: true;
  data: PulseSwapQuoteData;
}

export type PulseSwapResult = PulseSwapSuccess | PulseSwapSoftFail;

export interface PulseSwapQuoteRequest {
  fromToken: string;
  toToken: string;
  amountIn: string;
  /** 0–100; default 0.5 */
  slippage?: number;
  platform?: PulseSwapPlatform | string;
  chainId?: number;
  /** When set, upstream may attach tx calldata (advisory only). */
  userAddress?: string;
  amountUSD?: number;
  mode?: "standard" | "advanced";
  extra?: {
    tokenInPrice?: number;
    tokenOutPrice?: number;
    gasPrice?: string;
    gasTokenPrice?: number;
  };
}

type DexFetch = typeof fetch;

export interface PulseSwapFetchOptions {
  timeoutMs?: number;
  fetchImpl?: DexFetch;
}

const TX_ADVISORY_WARNING =
  "tx is opaque advisory calldata from PulseSwap when userAddress is set. " +
  "Quotes expire quickly; this MCP does not broadcast. " +
  "Do not treat as execution-ready without independent simulation and wallet policy.";

const QUOTE_NOTE =
  "PulseSwap multi-DEX quote (advisory). Not a swap execution path. " +
  "amountIn/amountOut are wei strings. gasEstimate is approximate. " +
  "Upstream may return amountIn as \"0\"; amountIn then echoes amountInRequested " +
  "while amountInUpstream preserves the raw upstream value. " +
  "quoteReady means advisory amountOut is non-zero only — never execution-ready " +
  "(executionReady is always false). priceUsdReady is true only when amountOutUSD " +
  "is a positive number; zero/empty USD is not a priced quote. " +
  "Prefer pulsex_v2 / mixed for liquid pairs; rate limit ~60/min.";

/** True when upstream amountIn is missing or a zero-ish wei string. */
export function isEmptyOrZeroAmountIn(value: string | undefined | null): boolean {
  const s = String(value ?? "").trim();
  return s === "" || s === "0" || /^0+$/.test(s);
}

// ---------------------------------------------------------------------------
// Pure builders / validators
// ---------------------------------------------------------------------------

export function isPulseSwapPlatform(value: string): value is PulseSwapPlatform {
  return (PULSESWAP_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Normalize token address for PulseSwap (accepts native PLS zero address).
 * Pure validation — throws PolicyError via assertAddress for non-zero invalid.
 */
export function normalizePulseSwapToken(token: string): string {
  const t = token.trim();
  if (t.toLowerCase() === PULSESWAP_NATIVE_PLS.toLowerCase()) {
    return PULSESWAP_NATIVE_PLS;
  }
  return assertAddress(t);
}

/** Build absolute quote URL. Pure. */
export function buildPulseSwapQuoteUrl(
  mode: "standard" | "advanced" = "standard",
  base: string = PULSESWAP_API_BASE,
): string {
  const root = base.replace(/\/$/, "");
  return mode === "advanced" ? `${root}/quotes/advanced` : `${root}/quotes`;
}

/**
 * Build request body for PulseSwap POST /quotes.
 * Forces chainId 369 by default; validates platform + slippage.
 * Pure (aside from assertAddress throws on bad tokens).
 */
export function buildPulseSwapQuoteBody(
  req: PulseSwapQuoteRequest,
): {
  body: Record<string, unknown>;
  path: string;
  mode: "standard" | "advanced";
  error?: string;
} {
  const mode = req.mode === "advanced" ? "advanced" : "standard";
  const path = mode === "advanced" ? "/quotes/advanced" : "/quotes";
  const platform = (req.platform ?? "mixed").trim();
  if (!isPulseSwapPlatform(platform)) {
    return {
      body: {},
      path,
      mode,
      error: `Invalid platform '${platform}'. Expected one of: ${PULSESWAP_PLATFORMS.join(", ")}`,
    };
  }

  const chainId = req.chainId ?? PULSECHAIN_CHAIN_ID;
  if (chainId !== PULSECHAIN_CHAIN_ID) {
    return {
      body: {},
      path,
      mode,
      error: `Unsupported chainId ${chainId}. Only PulseChain (${PULSECHAIN_CHAIN_ID}) is supported.`,
    };
  }

  const slippage =
    req.slippage === undefined || req.slippage === null ? 0.5 : Number(req.slippage);
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > 100) {
    return {
      body: {},
      path,
      mode,
      error: `Invalid slippage ${req.slippage}. Expected 0.0–100.0`,
    };
  }

  const amountIn = String(req.amountIn ?? "").trim();
  if (!/^[1-9]\d*$/.test(amountIn) && amountIn !== "0") {
    // allow 0 for soft probe; reject non-integer strings
    if (!/^\d+$/.test(amountIn) || amountIn === "") {
      return {
        body: {},
        path,
        mode,
        error: "amountIn must be a non-negative integer string (wei)",
      };
    }
  }

  let fromToken: string;
  let toToken: string;
  try {
    fromToken = normalizePulseSwapToken(req.fromToken);
    toToken = normalizePulseSwapToken(req.toToken);
  } catch (err) {
    return {
      body: {},
      path,
      mode,
      error: err instanceof Error ? err.message : "Invalid token address",
    };
  }

  if (fromToken.toLowerCase() === toToken.toLowerCase()) {
    return {
      body: {},
      path,
      mode,
      error: "fromToken and toToken must differ",
    };
  }

  const body: Record<string, unknown> = {
    chainId: PULSECHAIN_CHAIN_ID,
    platform,
    fromToken,
    toToken,
    amountIn,
    slippage,
  };

  if (req.userAddress) {
    const ua = req.userAddress.trim();
    if (!isAddress(ua)) {
      return {
        body: {},
        path,
        mode,
        error: `Invalid userAddress: ${req.userAddress}`,
      };
    }
    body.userAddress = ua;
  }
  if (req.amountUSD != null && Number.isFinite(req.amountUSD)) {
    body.amountUSD = req.amountUSD;
  }
  if (req.extra && typeof req.extra === "object") {
    body.extra = req.extra;
  }

  return { body, path, mode };
}

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

/**
 * Normalize PulseSwap JSON response into agent-friendly quote data.
 * Pure. Does not claim execution readiness.
 *
 * When upstream amountIn is "0"/empty and meta.requestAmountIn is set, amountIn
 * echoes the request so agents are not misled; amountInUpstream still exposes
 * the raw upstream value.
 */
export function normalizePulseSwapQuote(
  body: unknown,
  meta: {
    platform: string;
    chainId: number;
    fromToken: string;
    toToken: string;
    slippage: number;
    mode: "standard" | "advanced";
    /** Request amountIn (wei) for echo when upstream zeros it. */
    requestAmountIn?: string;
  },
): PulseSwapQuoteData {
  const root = asRecord(body) ?? {};
  const outerSuccess = root.success === true;
  const dataRec = asRecord(root.data) ?? {};
  const innerSuccess = dataRec.success === true;
  const amountInUpstream = str(dataRec.amountIn, "0");
  const amountOut = str(dataRec.amountOut, "0");
  const requestAmountIn =
    meta.requestAmountIn != null && String(meta.requestAmountIn).trim() !== ""
      ? String(meta.requestAmountIn).trim()
      : undefined;
  // Upstream may echo amountIn as "0"; prefer request amountIn for amountIn field.
  const amountIn =
    isEmptyOrZeroAmountIn(amountInUpstream) && requestAmountIn
      ? requestAmountIn
      : amountInUpstream || requestAmountIn || "0";
  // Non-zero amountOut + success flags drive advisory quoteReady only.
  const amountOutNonZero =
    amountOut !== "" && amountOut !== "0" && !/^0+$/.test(amountOut);
  const amountOutUsdRaw = str(dataRec.amountOutUSD);
  const amountOutUsdNum =
    amountOutUsdRaw !== "" && Number.isFinite(Number(amountOutUsdRaw))
      ? Number(amountOutUsdRaw)
      : NaN;
  // USD price ready only with a finite positive amountOutUSD (0/empty → false).
  const priceUsdReady =
    Number.isFinite(amountOutUsdNum) && amountOutUsdNum > 0;
  const amountInUpstreamZero = isEmptyOrZeroAmountIn(amountInUpstream);

  let txAdvisory: PulseSwapQuoteData["txAdvisory"] = null;
  const tx = asRecord(dataRec.tx);
  // Only surface when upstream attaches real calldata (typically with userAddress)
  if (tx && (str(tx.to) || str(tx.data))) {
    txAdvisory = {
      from: str(tx.from) || undefined,
      to: str(tx.to) || undefined,
      data: str(tx.data) || undefined,
      value: str(tx.value) || undefined,
      warning: TX_ADVISORY_WARNING,
    };
  }

  return {
    quoteId: str(dataRec.quoteId) || null,
    amountIn,
    amountInRequested: requestAmountIn,
    amountInUpstream,
    amountOut,
    amountOutUSD: amountOutUsdRaw || null,
    gasEstimate: numOrNull(dataRec.gasEstimate),
    platform: meta.platform,
    chainId: meta.chainId,
    fromToken: meta.fromToken,
    toToken: meta.toToken,
    slippage: meta.slippage,
    mode: meta.mode,
    // Advisory amountOut usable — not USD-priced, not execution-ready
    quoteReady: outerSuccess && innerSuccess && amountOutNonZero,
    priceUsdReady,
    executionReady: false,
    amountInUpstreamZero,
    upstream: {
      outerSuccess,
      innerSuccess,
      message: str(root.message) || null,
      timestamp: str(root.timestamp) || null,
    },
    txAdvisory,
    note: QUOTE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// HTTP (fail-soft)
// ---------------------------------------------------------------------------

function softFail(
  reason: string,
  extra: Partial<PulseSwapSoftFail> = {},
): PulseSwapSoftFail {
  return { ok: false, source: "pulseswap", reason, ...extra };
}

export async function pulseswapPostJson(
  url: string,
  body: unknown,
  config: Pick<AppConfig, "httpTimeoutMs">,
  options: PulseSwapFetchOptions = {},
): Promise<
  | { ok: true; status: number; body: unknown; url: string }
  | { ok: false; reason: string; status?: number; url: string }
> {
  const timeoutMs = options.timeoutMs ?? config.httpTimeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      return {
        ok: false,
        reason: "PulseSwap rate limit (HTTP 429). Retry shortly (~60/min).",
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
        reason: `PulseSwap returned invalid JSON (HTTP ${res.status})`,
        status: res.status,
        url,
      };
    }

    // Upstream returns 422 with message body for validation — treat as soft fail
    if (!res.ok) {
      const rec = asRecord(parsed);
      const msg =
        (rec && typeof rec.message === "string" && rec.message) ||
        `PulseSwap HTTP ${res.status}`;
      return { ok: false, reason: msg, status: res.status, url };
    }

    return { ok: true, status: res.status, body: parsed, url };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        reason: `PulseSwap request timed out after ${timeoutMs}ms`,
        url,
      };
    }
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `PulseSwap network error: ${err.message}`
          : "PulseSwap network error",
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Request a multi-DEX quote. Fail-soft; never broadcasts.
 */
export async function getPulseSwapQuote(
  config: Pick<AppConfig, "httpTimeoutMs">,
  req: PulseSwapQuoteRequest,
  options: PulseSwapFetchOptions = {},
): Promise<PulseSwapResult> {
  const built = buildPulseSwapQuoteBody(req);
  if (built.error) {
    return softFail(built.error, {
      path: built.path,
      platform: String(req.platform ?? "mixed"),
    });
  }

  const url = buildPulseSwapQuoteUrl(built.mode);
  const res = await pulseswapPostJson(url, built.body, config, options);
  if (!res.ok) {
    return softFail(res.reason, {
      status: res.status,
      path: built.path,
      platform: String(built.body.platform ?? req.platform ?? "mixed"),
    });
  }

  const root = asRecord(res.body);
  // Outer success:false with message → soft fail
  if (root && root.success === false) {
    return softFail(
      typeof root.message === "string"
        ? root.message
        : "PulseSwap quote unsuccessful",
      {
        path: built.path,
        platform: String(built.body.platform),
      },
    );
  }

  const data = normalizePulseSwapQuote(res.body, {
    platform: String(built.body.platform),
    chainId: PULSECHAIN_CHAIN_ID,
    fromToken: String(built.body.fromToken),
    toToken: String(built.body.toToken),
    slippage: Number(built.body.slippage),
    mode: built.mode,
    requestAmountIn: String(built.body.amountIn ?? req.amountIn ?? ""),
  });

  return {
    ok: true,
    source: "pulseswap",
    advisory: true,
    data,
  };
}
