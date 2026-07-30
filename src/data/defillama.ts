/**
 * DefiLlama open API client (no API key).
 * Docs: https://defillama.com/docs/api
 * Base: https://api.llama.fi
 *
 * PulseChain chain row name: "PulseChain" (v2/chains).
 * Protocol-level chain key: "Pulse" (protocols[].chains / chainTvls).
 * Fail-soft: network/HTTP errors return structured soft failures.
 */

import type { AppConfig } from "../types.js";

/** Official DefiLlama open API base (no key required). */
export const DEFILLAMA_API_BASE = "https://api.llama.fi" as const;

/** Chain name on `/v2/chains` (and historical TVL paths). */
export const DEFILLAMA_CHAIN_NAME = "PulseChain" as const;

/**
 * Protocol list uses short name "Pulse" for PulseChain (not "PulseChain").
 * Match case-insensitively against chains[] and chainTvls keys.
 */
export const DEFILLAMA_PROTOCOL_CHAIN = "Pulse" as const;

export interface DefiLlamaSoftFail {
  ok: false;
  source: "defillama";
  reason: string;
  status?: number;
  path?: string;
}

export interface DefiLlamaSuccess<T> {
  ok: true;
  source: "defillama";
  data: T;
  /** Always true — TVL figures are third-party advisory estimates. */
  advisory: true;
}

export type DefiLlamaResult<T> = DefiLlamaSuccess<T> | DefiLlamaSoftFail;

export interface PulseChainTvlSummary {
  name: string;
  gecko_id?: string | null;
  tokenSymbol?: string | null;
  cmcId?: string | null;
  tvl: number | null;
  chainId?: number | string | null;
  /** ISO timestamp of this snapshot (local clock). */
  asOf: string;
  note: string;
}

export interface PulseChainProtocolSummary {
  name: string;
  slug: string;
  category?: string | null;
  /** Protocol TVL attributed to Pulse (from chainTvls when available). */
  pulseTvl: number | null;
  /** Global protocol TVL (all chains) when reported. */
  totalTvl: number | null;
  url?: string | null;
  twitter?: string | null;
}

export interface PulseChainProtocolsPayload {
  chainFilter: string;
  protocolCount: number;
  protocols: PulseChainProtocolSummary[];
  asOf: string;
  note: string;
}

type DexFetch = typeof fetch;

export interface DefiLlamaFetchOptions {
  timeoutMs?: number;
  fetchImpl?: DexFetch;
}

// ---------------------------------------------------------------------------
// URL builders (pure / unit-testable)
// ---------------------------------------------------------------------------

export function buildDefiLlamaChainsUrl(
  base: string = DEFILLAMA_API_BASE,
): string {
  return `${base.replace(/\/$/, "")}/v2/chains`;
}

export function buildDefiLlamaProtocolsUrl(
  base: string = DEFILLAMA_API_BASE,
): string {
  return `${base.replace(/\/$/, "")}/protocols`;
}

export function buildDefiLlamaHistoricalChainTvlUrl(
  chain: string = DEFILLAMA_CHAIN_NAME,
  base: string = DEFILLAMA_API_BASE,
): string {
  const c = encodeURIComponent(chain.trim() || DEFILLAMA_CHAIN_NAME);
  return `${base.replace(/\/$/, "")}/v2/historicalChainTvl/${c}`;
}

// ---------------------------------------------------------------------------
// Normalization (pure / unit-testable)
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** True when a DefiLlama chain label refers to PulseChain. Pure. */
export function isPulseChainLabel(label: string): boolean {
  const n = label.trim().toLowerCase();
  return n === "pulse" || n === "pulsechain" || n.startsWith("pulse-");
}

/**
 * Extract Pulse-attributed TVL from a protocol's chainTvls map.
 * Prefers exact "Pulse", then any key matching isPulseChainLabel (not staking/borrowed double-count primary).
 * Pure.
 */
export function extractPulseChainTvlFromChainTvls(
  chainTvls: unknown,
): number | null {
  const rec = asRecord(chainTvls);
  if (!rec) return null;
  if (typeof rec.Pulse === "number" && Number.isFinite(rec.Pulse)) {
    return rec.Pulse;
  }
  // Prefer bare chain keys over Pulse-staking / Pulse-borrowed
  let best: number | null = null;
  for (const [k, v] of Object.entries(rec)) {
    if (!isPulseChainLabel(k)) continue;
    // Skip double-count / side buckets when bare Pulse missing
    if (/staking|borrowed|pool2|vesting/i.test(k)) continue;
    const n = numOrNull(v);
    if (n != null && (best == null || n > best)) best = n;
  }
  if (best != null) return best;
  // Fallback: sum non-negative Pulse-* keys excluding borrowed
  let sum = 0;
  let any = false;
  for (const [k, v] of Object.entries(rec)) {
    if (!isPulseChainLabel(k)) continue;
    if (/borrowed/i.test(k)) continue;
    const n = numOrNull(v);
    if (n != null && n >= 0) {
      sum += n;
      any = true;
    }
  }
  return any ? sum : null;
}

/** Find PulseChain row in /v2/chains array. Pure. */
export function findPulseChainRow(body: unknown): Record<string, unknown> | null {
  if (!Array.isArray(body)) return null;
  for (const item of body) {
    const rec = asRecord(item);
    if (!rec) continue;
    const name = strOrNull(rec.name);
    if (name && isPulseChainLabel(name) && name.toLowerCase() !== "pulsechain-testnet") {
      // Prefer exact PulseChain name
      if (name === DEFILLAMA_CHAIN_NAME || name.toLowerCase() === "pulsechain") {
        return rec;
      }
    }
  }
  // Second pass: any Pulse* chain that isn't a side product
  for (const item of body) {
    const rec = asRecord(item);
    if (!rec) continue;
    const name = strOrNull(rec.name);
    if (name && name.toLowerCase() === "pulsechain") return rec;
  }
  return null;
}

/** Normalize chain TVL snapshot. Pure. */
export function normalizePulseChainTvl(
  body: unknown,
  asOf: string = new Date().toISOString(),
): PulseChainTvlSummary | null {
  const rec = findPulseChainRow(body);
  if (!rec) return null;
  return {
    name: strOrNull(rec.name) ?? DEFILLAMA_CHAIN_NAME,
    gecko_id: strOrNull(rec.gecko_id),
    tokenSymbol: strOrNull(rec.tokenSymbol),
    cmcId: strOrNull(rec.cmcId) ?? (rec.cmcId != null ? String(rec.cmcId) : null),
    tvl: numOrNull(rec.tvl),
    chainId: rec.chainId as number | string | null | undefined ?? null,
    asOf,
    note:
      "DefiLlama chain TVL is a third-party estimate (advisory). " +
      "Not on-chain consensus; lags and methodology differ from explorer/subgraph figures.",
  };
}

/**
 * Filter + rank protocols with Pulse exposure.
 * Pure. Sorts by pulseTvl desc.
 */
export function normalizePulseChainProtocols(
  body: unknown,
  options: { limit?: number; category?: string } = {},
  asOf: string = new Date().toISOString(),
): PulseChainProtocolsPayload {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const catFilter = options.category?.trim().toLowerCase();
  const out: PulseChainProtocolSummary[] = [];

  if (Array.isArray(body)) {
    for (const item of body) {
      const rec = asRecord(item);
      if (!rec) continue;
      const chains = Array.isArray(rec.chains)
        ? rec.chains.filter((c): c is string => typeof c === "string")
        : [];
      const onPulse =
        chains.some((c) => isPulseChainLabel(c)) ||
        extractPulseChainTvlFromChainTvls(rec.chainTvls) != null;
      if (!onPulse) continue;

      const category = strOrNull(rec.category);
      if (catFilter && (category ?? "").toLowerCase() !== catFilter) continue;

      const pulseTvl = extractPulseChainTvlFromChainTvls(rec.chainTvls);
      out.push({
        name: strOrNull(rec.name) ?? "unknown",
        slug: strOrNull(rec.slug) ?? "",
        category,
        pulseTvl,
        totalTvl: numOrNull(rec.tvl),
        url: strOrNull(rec.url),
        twitter: strOrNull(rec.twitter),
      });
    }
  }

  out.sort((a, b) => (b.pulseTvl ?? -1) - (a.pulseTvl ?? -1));
  const sliced = out.slice(0, limit);

  return {
    chainFilter: DEFILLAMA_PROTOCOL_CHAIN,
    protocolCount: sliced.length,
    protocols: sliced,
    asOf,
    note:
      "DefiLlama protocol TVLs are third-party estimates (advisory). " +
      "Pulse chain key is typically \"Pulse\" (not \"PulseChain\"). " +
      "DEX category filter helps surface DEX-oriented rows; not exhaustive market data.",
  };
}

// ---------------------------------------------------------------------------
// HTTP (fail-soft)
// ---------------------------------------------------------------------------

function softFail(
  reason: string,
  extra: Partial<DefiLlamaSoftFail> = {},
): DefiLlamaSoftFail {
  return { ok: false, source: "defillama", reason, ...extra };
}

export async function defillamaGetJson(
  pathOrUrl: string,
  config: Pick<AppConfig, "httpTimeoutMs">,
  options: DefiLlamaFetchOptions = {},
): Promise<
  | { ok: true; status: number; body: unknown; url: string }
  | { ok: false; reason: string; status?: number; url: string }
> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${DEFILLAMA_API_BASE.replace(/\/$/, "")}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

  const timeoutMs = options.timeoutMs ?? config.httpTimeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `DefiLlama HTTP ${res.status}`,
        status: res.status,
        url,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        reason: "DefiLlama returned invalid JSON",
        status: res.status,
        url,
      };
    }
    return { ok: true, status: res.status, body, url };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        reason: `DefiLlama request timed out after ${timeoutMs}ms`,
        url,
      };
    }
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `DefiLlama network error: ${err.message}`
          : "DefiLlama network error",
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function getPulseChainTvl(
  config: Pick<AppConfig, "httpTimeoutMs">,
  options: DefiLlamaFetchOptions = {},
): Promise<DefiLlamaResult<PulseChainTvlSummary>> {
  const url = buildDefiLlamaChainsUrl();
  const res = await defillamaGetJson(url, config, options);
  if (!res.ok) {
    return softFail(res.reason, { status: res.status, path: "/v2/chains" });
  }
  const data = normalizePulseChainTvl(res.body);
  if (!data) {
    return softFail("PulseChain row not found in DefiLlama /v2/chains", {
      path: "/v2/chains",
    });
  }
  return { ok: true, source: "defillama", advisory: true, data };
}

export async function getPulseChainProtocols(
  config: Pick<AppConfig, "httpTimeoutMs">,
  options: {
    limit?: number;
    category?: string;
    fetchImpl?: DexFetch;
    timeoutMs?: number;
  } = {},
): Promise<DefiLlamaResult<PulseChainProtocolsPayload>> {
  const url = buildDefiLlamaProtocolsUrl();
  const res = await defillamaGetJson(url, config, options);
  if (!res.ok) {
    return softFail(res.reason, { status: res.status, path: "/protocols" });
  }
  const data = normalizePulseChainProtocols(res.body, {
    limit: options.limit,
    category: options.category,
  });
  return { ok: true, source: "defillama", advisory: true, data };
}
