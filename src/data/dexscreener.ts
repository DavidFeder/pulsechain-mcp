/**
 * DexScreener public API client (no API key).
 * Docs: https://docs.dexscreener.com/api/reference
 * Base: https://api.dexscreener.com
 *
 * PulseChain chain id string: "pulsechain"
 * Fail-soft: network/HTTP/rate-limit errors return structured soft failures
 * rather than throwing hard crashes into tool handlers.
 */

import type { AppConfig } from "../types.js";
import {
  BRIDGED_DAI_ADDRESS,
  BRIDGED_WETH_ADDRESS,
  EHEX_ADDRESS,
  EHEX_MAJOR_PAIR_ADDRESS,
  EUSDC_MAJOR_PAIR_ADDRESS,
  EUSDT_MAJOR_PAIR_ADDRESS,
  EWBTC_ADDRESS,
  FORK_DAI_ADDRESS,
  FORK_USDT_ADDRESS,
  FORK_WETH_ADDRESS,
  HEX_ADDRESS,
  PWBTC_ADDRESS,
  USDC_FROM_ETH_ADDRESS,
  USDT_FROM_ETH_ADDRESS,
  tokenLabelFields,
} from "../constants.js";

/** Official DexScreener API base (no key required). */
export const DEXSCREENER_API_BASE = "https://api.dexscreener.com" as const;

/** PulseChain chain id used by DexScreener. */
export const DEXSCREENER_PULSECHAIN_ID = "pulsechain" as const;

/** Default chain when tools omit chainId. */
export const DEFAULT_DEXSCREENER_CHAIN = DEXSCREENER_PULSECHAIN_ID;

/** Minimum spacing between outbound requests (rate-limit friendliness). */
export const DEXSCREENER_MIN_INTERVAL_MS = 200;

/** Soft-fail envelope when upstream is unavailable. */
export interface DexScreenerSoftFail {
  ok: false;
  source: "dexscreener";
  reason: string;
  status?: number;
  path?: string;
  chainId?: string;
  pairs?: never;
  profiles?: never;
  boosts?: never;
}

export interface DexScreenerSuccess<T> {
  ok: true;
  source: "dexscreener";
  chainId?: string;
  data: T;
  /** When results were filtered to PulseChain only */
  pulsechainOnly?: boolean;
  pairCount?: number;
}

export type DexScreenerResult<T> = DexScreenerSuccess<T> | DexScreenerSoftFail;

/**
 * Search-only annotation for same-ticker collisions / likely impostors.
 * Never invents `token_origin` — address tools + catalog remain identity truth.
 */
export interface DexScreenerSearchFlags {
  /** True when base or quote ticker collides with another address in this result set */
  symbol_collision: boolean;
  /** Unknown-origin address sharing a ticker with a catalogued or other address */
  ticker_spoof_risk?: "high" | "medium" | "low";
  /** Pair was sorted below catalogued / higher-confidence rows */
  demoted?: boolean;
  /** Human-readable caution for agents/operators */
  reason?: string;
  /** Tickers that collide in this result set involving this pair */
  colliding_symbols?: string[];
  /** Always true when spoof risk is set — prefer address-keyed tools */
  prefer_address_tools?: true;
}

/** Minimal pair shape we surface to agents (subset of DexScreener pair). */
export interface DexScreenerPairSummary {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: {
    address: string;
    name: string;
    symbol: string;
    /** Origin labels when address is in our known catalog */
    origin?: Record<string, unknown>;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
    origin?: Record<string, unknown>;
  };
  priceNative?: string;
  priceUsd?: string | null;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number> | null;
  liquidity?: { usd?: number | null; base?: number; quote?: number } | null;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
  /**
   * Present only on search results after spoof-aware rank/annotate.
   * Address-keyed tools never set this.
   */
  search_flags?: DexScreenerSearchFlags;
}

/** Search response extras (discovery-only guidance; not used by address tools). */
export interface DexScreenerSearchMeta {
  /** Symbol search is discovery; addresses are identity */
  discovery_only: true;
  guidance: string;
  /** Symbols that appeared on 2+ distinct token addresses in this result set */
  symbol_collisions: Array<{
    symbol: string;
    addresses: string[];
    known_catalog_addresses: string[];
    unknown_addresses: string[];
  }>;
  /**
   * When the query matches a known dual-asset catalog family and upstream
   * omits or spoof-dominates the canonical address(es). Never invents pairs.
   */
  catalog_coverage?: CatalogSearchCoverage;
  /** Recommended address-keyed tool calls (no fabricated pair rows). */
  recommended_address_followups?: RecommendedAddressFollowUp[];
}

/** Known major pair (catalog guidance only — never invent as a live pair row). */
export interface SearchCatalogKnownPair {
  address: string;
  display_name: string;
}

/** Known catalog entry for search-query matching (pure; no network). */
export interface SearchCatalogEntry {
  family: string;
  address: string;
  display_name: string;
  role: string;
  /** Symbols that select this entry as primary for the query */
  primary_symbols: string[];
  /** Sibling symbols in the same dual-asset family (secondary follow-up) */
  sibling_symbols?: string[];
  /**
   * Optional curated major pair addresses for address-keyed follow-up.
   * Recommended via dexscreener_pair — never emitted as fabricated search rows.
   */
  known_major_pairs?: readonly SearchCatalogKnownPair[];
}

/**
 * Coverage of known catalog addresses in a symbol-search result set.
 * Pure analysis — never invents DexScreener pairs.
 */
export interface CatalogSearchCoverage {
  query_matched_catalog: boolean;
  matched_symbols: string[];
  present_catalog_addresses: string[];
  missing_catalog_entries: Array<{
    address: string;
    display_name: string;
    role: string;
    family: string;
    is_primary_for_query: boolean;
  }>;
  /** True when the primary catalog address for the query is absent upstream */
  canonical_missing_from_upstream: boolean;
  /**
   * True when primary is missing and results are empty or dominated by
   * uncatalogued / spoof-annotated same-ticker rows.
   */
  spoof_dominated: boolean;
  note: string;
}

/** Address-based follow-up (identity tools — not invented pair rows). */
export interface RecommendedAddressFollowUp {
  address: string;
  display_name: string;
  role: string;
  family: string;
  /** Token identity → token_pairs; curated major pool → pair (still address-keyed). */
  preferred_tool: "dexscreener_token_pairs" | "dexscreener_pair";
  reason: string;
}

/**
 * Catalog assets used for search missing-canonical guidance.
 * e* = bridged (legitimate); p* = state-fork (typically useless); pHEX preferred exception.
 * known_major_pairs are guidance-only — never invent live DexScreener rows.
 */
export const SEARCH_CATALOG_ENTRIES: readonly SearchCatalogEntry[] = [
  {
    family: "dai",
    address: BRIDGED_DAI_ADDRESS,
    display_name: "bridged DAI (real stable)",
    role: "bridged_stable",
    primary_symbols: ["DAI"],
    sibling_symbols: ["PDAI", "FORK_DAI", "FORKED_DAI", "P_DAI"],
  },
  {
    family: "dai",
    address: FORK_DAI_ADDRESS,
    display_name: "pDAI / forked DAI (not $1; p* typically useless)",
    role: "state_fork",
    primary_symbols: ["PDAI", "FORK_DAI", "FORKED_DAI", "P_DAI"],
    sibling_symbols: ["DAI"],
  },
  {
    family: "hex",
    address: HEX_ADDRESS,
    display_name: "pHEX / HEX (preferred state-fork exception)",
    role: "preferred_state_fork",
    primary_symbols: ["HEX", "PHEX", "P_HEX"],
    sibling_symbols: ["EHEX", "E_HEX", "BRIDGED_HEX", "HEX_ETH"],
  },
  {
    family: "hex",
    address: EHEX_ADDRESS,
    display_name: "eHEX (bridged; e* = legitimate)",
    role: "bridged",
    primary_symbols: ["EHEX", "E_HEX", "BRIDGED_HEX", "HEX_ETH"],
    sibling_symbols: ["HEX", "PHEX", "P_HEX"],
    known_major_pairs: [
      {
        address: EHEX_MAJOR_PAIR_ADDRESS,
        display_name: "eHEX major pair (catalog guidance)",
      },
    ],
  },
  {
    family: "usdc",
    address: USDC_FROM_ETH_ADDRESS,
    display_name: "eUSDC / bridged USDC (real stable; e* = legitimate)",
    role: "bridged_stable",
    primary_symbols: ["USDC", "EUSDC", "E_USDC", "BRIDGED_USDC", "USDC_ETH"],
    known_major_pairs: [
      {
        address: EUSDC_MAJOR_PAIR_ADDRESS,
        display_name: "eUSDC / bridged DAI major pair (catalog guidance)",
      },
    ],
  },
  {
    family: "usdt",
    address: USDT_FROM_ETH_ADDRESS,
    display_name: "eUSDT / bridged USDT (real Tether; e* = legitimate)",
    role: "bridged_stable",
    primary_symbols: ["USDT", "EUSDT", "E_USDT", "BRIDGED_USDT", "USDT_ETH"],
    sibling_symbols: ["FUSDT", "FORK_USDT", "FORKED_USDT", "P_USDT"],
    known_major_pairs: [
      {
        address: EUSDT_MAJOR_PAIR_ADDRESS,
        display_name: "eUSDT major pair (catalog guidance)",
      },
    ],
  },
  {
    family: "usdt",
    address: FORK_USDT_ADDRESS,
    display_name: "fUSDT / forked USDT (not $1)",
    role: "state_fork",
    primary_symbols: ["FUSDT", "FORK_USDT", "FORKED_USDT", "P_USDT"],
    sibling_symbols: ["USDT", "EUSDT"],
  },
  {
    family: "wbtc",
    address: EWBTC_ADDRESS,
    display_name: "eWBTC / bridged WBTC (e* = legitimate)",
    role: "bridged",
    primary_symbols: ["WBTC", "EWBTC", "E_WBTC", "BRIDGED_WBTC", "WBTC_ETH"],
    sibling_symbols: ["PWBTC", "P_WBTC", "FORK_WBTC", "FORKED_WBTC"],
  },
  {
    family: "wbtc",
    address: PWBTC_ADDRESS,
    display_name: "pWBTC / forked WBTC (typically useless; p* = state fork)",
    role: "state_fork_typically_useless",
    primary_symbols: ["PWBTC", "P_WBTC", "FORK_WBTC", "FORKED_WBTC"],
    sibling_symbols: ["WBTC", "EWBTC"],
  },
  {
    family: "weth",
    address: BRIDGED_WETH_ADDRESS,
    display_name: "bridged WETH",
    role: "bridged",
    primary_symbols: ["WETH"],
    sibling_symbols: ["FWETH", "FORK_WETH", "FORKED_WETH", "P_WETH"],
  },
  {
    family: "weth",
    address: FORK_WETH_ADDRESS,
    display_name: "fWETH / forked WETH",
    role: "state_fork",
    primary_symbols: ["FWETH", "FORK_WETH", "FORKED_WETH", "P_WETH"],
    sibling_symbols: ["WETH"],
  },
] as const;

export const DEXSCREENER_SEARCH_GUIDANCE =
  "Symbol search is discovery-only and may include ticker-spoof contracts. " +
  "For identity-sensitive work prefer dexscreener_token_pairs / dexscreener_tokens / dexscreener_pair with a verified 0x address. " +
  "Known fork/bridged labels attach only when the address is in the MCP catalog — never trust symbol alone. " +
  "e* = bridged from Ethereum (legitimate); p* = state-fork (typically useless); exception: pHEX is preferred HEX. " +
  "When upstream omits a catalogued asset, use recommended_address_followups (token and/or known major pair addresses) — never invent pairs from guidance.";

/** Liquidity (USD) below this makes unknown same-symbol hits more suspicious. */
export const SEARCH_SPOOF_LOW_LIQ_USD = 50_000;

// ---------------------------------------------------------------------------
// URL builders (pure / unit-testable)
// ---------------------------------------------------------------------------

export function buildDexScreenerSearchUrl(
  query: string,
  base: string = DEXSCREENER_API_BASE,
): string {
  const url = new URL("/latest/dex/search", base);
  url.searchParams.set("q", query);
  return url.toString();
}

export function buildDexScreenerPairUrl(
  chainId: string,
  pairAddress: string,
  base: string = DEXSCREENER_API_BASE,
): string {
  const chain = encodeURIComponent(chainId.trim().toLowerCase() || DEFAULT_DEXSCREENER_CHAIN);
  const pair = encodeURIComponent(pairAddress.trim());
  return `${base.replace(/\/$/, "")}/latest/dex/pairs/${chain}/${pair}`;
}

export function buildDexScreenerTokenPairsUrl(
  chainId: string,
  tokenAddress: string,
  base: string = DEXSCREENER_API_BASE,
): string {
  const chain = encodeURIComponent(chainId.trim().toLowerCase() || DEFAULT_DEXSCREENER_CHAIN);
  const token = encodeURIComponent(tokenAddress.trim());
  return `${base.replace(/\/$/, "")}/token-pairs/v1/${chain}/${token}`;
}

export function buildDexScreenerTokensUrl(
  chainId: string,
  tokenAddresses: string | string[],
  base: string = DEXSCREENER_API_BASE,
): string {
  const chain = encodeURIComponent(chainId.trim().toLowerCase() || DEFAULT_DEXSCREENER_CHAIN);
  const list = Array.isArray(tokenAddresses)
    ? tokenAddresses.map((a) => a.trim()).filter(Boolean).join(",")
    : tokenAddresses.trim();
  return `${base.replace(/\/$/, "")}/tokens/v1/${chain}/${encodeURIComponent(list)}`;
}

export function buildDexScreenerBoostsLatestUrl(
  base: string = DEXSCREENER_API_BASE,
): string {
  return `${base.replace(/\/$/, "")}/token-boosts/latest/v1`;
}

export function buildDexScreenerProfilesLatestUrl(
  base: string = DEXSCREENER_API_BASE,
): string {
  return `${base.replace(/\/$/, "")}/token-profiles/latest/v1`;
}

// ---------------------------------------------------------------------------
// Normalization (pure / unit-testable)
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Attach origin labels for known PulseChain fork/bridged addresses. */
export function enrichTokenSide(token: {
  address?: string;
  name?: string;
  symbol?: string;
}): DexScreenerPairSummary["baseToken"] {
  const address = str(token.address);
  const origin = address ? tokenLabelFields(address) : null;
  const out: DexScreenerPairSummary["baseToken"] = {
    address,
    name: str(token.name),
    symbol: str(token.symbol),
  };
  if (origin) out.origin = origin;
  return out;
}

/**
 * Normalize a raw DexScreener pair object into agent-friendly summary.
 * Pure / unit-testable.
 */
export function normalizeDexScreenerPair(
  raw: unknown,
): DexScreenerPairSummary | null {
  const p = asRecord(raw);
  if (!p) return null;
  const pairAddress = str(p.pairAddress);
  const chainId = str(p.chainId);
  if (!pairAddress || !chainId) return null;

  const base = asRecord(p.baseToken) ?? {};
  const quote = asRecord(p.quoteToken) ?? {};

  const summary: DexScreenerPairSummary = {
    chainId,
    dexId: str(p.dexId),
    url: str(p.url),
    pairAddress,
    baseToken: enrichTokenSide({
      address: str(base.address),
      name: str(base.name),
      symbol: str(base.symbol),
    }),
    quoteToken: enrichTokenSide({
      address: str(quote.address),
      name: str(quote.name),
      symbol: str(quote.symbol),
    }),
  };

  if (Array.isArray(p.labels)) {
    summary.labels = p.labels.filter((x): x is string => typeof x === "string");
  }
  if (p.priceNative !== undefined) summary.priceNative = str(p.priceNative);
  if (p.priceUsd !== undefined) {
    summary.priceUsd =
      p.priceUsd === null ? null : str(p.priceUsd as string);
  }
  if (asRecord(p.txns)) {
    summary.txns = p.txns as DexScreenerPairSummary["txns"];
  }
  if (asRecord(p.volume)) {
    summary.volume = p.volume as DexScreenerPairSummary["volume"];
  }
  if (p.priceChange === null) {
    summary.priceChange = null;
  } else if (asRecord(p.priceChange)) {
    summary.priceChange = p.priceChange as Record<string, number>;
  }
  if (p.liquidity === null) {
    summary.liquidity = null;
  } else if (asRecord(p.liquidity)) {
    const liq = p.liquidity as Record<string, unknown>;
    summary.liquidity = {
      usd: numOrNull(liq.usd),
      base: numOrNull(liq.base) ?? undefined,
      quote: numOrNull(liq.quote) ?? undefined,
    };
  }
  if (p.fdv !== undefined) summary.fdv = numOrNull(p.fdv);
  if (p.marketCap !== undefined) summary.marketCap = numOrNull(p.marketCap);
  if (p.pairCreatedAt !== undefined) {
    summary.pairCreatedAt = numOrNull(p.pairCreatedAt);
  }

  return summary;
}

/** Extract pair array from various DexScreener response shapes. */
export function extractPairsFromResponse(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const rec = asRecord(body);
  if (!rec) return [];
  if (Array.isArray(rec.pairs)) return rec.pairs;
  if (rec.pair != null) return [rec.pair];
  return [];
}

/** Filter pairs to a chain id (default pulsechain). Pure. */
export function filterPairsByChain(
  pairs: DexScreenerPairSummary[],
  chainId: string = DEFAULT_DEXSCREENER_CHAIN,
): DexScreenerPairSummary[] {
  const want = chainId.trim().toLowerCase();
  return pairs.filter((p) => p.chainId.toLowerCase() === want);
}

// ---------------------------------------------------------------------------
// Search-only spoof-aware rank + annotate (pure / unit-testable)
// ---------------------------------------------------------------------------

function tokenIsCatalogued(side: {
  origin?: Record<string, unknown>;
}): boolean {
  return side.origin != null && typeof side.origin === "object";
}

function pairLiquidityUsd(p: DexScreenerPairSummary): number {
  const u = p.liquidity?.usd;
  return typeof u === "number" && Number.isFinite(u) ? u : 0;
}

/** Catalog preference score — higher ranks first. Pure. */
export function searchPairCatalogScore(p: DexScreenerPairSummary): number {
  let score = 0;
  if (tokenIsCatalogued(p.baseToken)) score += 100;
  if (tokenIsCatalogued(p.quoteToken)) score += 100;
  // Mild bonus when origin is bridged/state_fork (dual-asset awareness)
  for (const side of [p.baseToken, p.quoteToken]) {
    const o = side.origin?.token_origin;
    if (o === "bridged") score += 5;
    if (o === "state_fork") score += 5;
    if (o === "pulsechain") score += 2;
  }
  return score;
}

/**
 * Build symbol → distinct addresses map from a pair list (base + quote).
 * Pure.
 */
export function collectSearchSymbolAddresses(
  pairs: DexScreenerPairSummary[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const p of pairs) {
    for (const side of [p.baseToken, p.quoteToken]) {
      const sym = (side.symbol || "").trim().toUpperCase();
      const addr = (side.address || "").trim().toLowerCase();
      if (!sym || !/^0x[a-f0-9]{40}$/.test(addr)) continue;
      if (!map.has(sym)) map.set(sym, new Set());
      map.get(sym)!.add(addr);
    }
  }
  return map;
}

/** Collect lowercased token addresses appearing on base or quote sides. Pure. */
export function collectPairTokenAddresses(
  pairs: DexScreenerPairSummary[],
): Set<string> {
  const out = new Set<string>();
  for (const p of pairs) {
    for (const side of [p.baseToken, p.quoteToken]) {
      const addr = (side.address || "").trim().toLowerCase();
      if (/^0x[a-f0-9]{40}$/.test(addr)) out.add(addr);
    }
  }
  return out;
}

/**
 * Normalize a free-text search query into an uppercase symbol token for catalog matching.
 * Pure. Only exact symbol tokens (after trim) match catalog primaries — not free-form prose.
 */
export function normalizeSearchQuerySymbol(query: string): string {
  return query.trim().toUpperCase().replace(/\s+/g, "_");
}

/**
 * When symbol search matches a known dual-asset catalog family, detect whether
 * the canonical / sibling catalog addresses appear in upstream results.
 * Never invents pairs — only recommends address-keyed follow-ups.
 * Pure / unit-testable.
 */
export function buildCatalogSearchCoverage(
  query: string,
  pairs: DexScreenerPairSummary[],
): {
  catalog_coverage: CatalogSearchCoverage | null;
  recommended_address_followups: RecommendedAddressFollowUp[];
} {
  const sym = normalizeSearchQuerySymbol(query);
  if (!sym) {
    return { catalog_coverage: null, recommended_address_followups: [] };
  }

  const primaryEntries = SEARCH_CATALOG_ENTRIES.filter((e) =>
    e.primary_symbols.includes(sym),
  );
  if (primaryEntries.length === 0) {
    return { catalog_coverage: null, recommended_address_followups: [] };
  }

  const present = collectPairTokenAddresses(pairs);
  const matched_symbols = [sym];
  const present_catalog_addresses: string[] = [];
  const missing_catalog_entries: CatalogSearchCoverage["missing_catalog_entries"] =
    [];

  // Primary entries for this query symbol
  for (const e of primaryEntries) {
    const addr = e.address.toLowerCase();
    if (present.has(addr)) {
      present_catalog_addresses.push(addr);
    } else {
      missing_catalog_entries.push({
        address: e.address,
        display_name: e.display_name,
        role: e.role,
        family: e.family,
        is_primary_for_query: true,
      });
    }
  }

  // Sibling dual-asset entries in the same families (secondary follow-ups)
  const families = new Set(primaryEntries.map((e) => e.family));
  for (const e of SEARCH_CATALOG_ENTRIES) {
    if (!families.has(e.family)) continue;
    if (primaryEntries.some((p) => p.address.toLowerCase() === e.address.toLowerCase())) {
      continue;
    }
    const addr = e.address.toLowerCase();
    if (present.has(addr)) {
      if (!present_catalog_addresses.includes(addr)) {
        present_catalog_addresses.push(addr);
      }
    } else {
      // Only surface sibling as missing when primary is also missing (avoid noise
      // when canonical is already in results).
      const primaryMissing = missing_catalog_entries.some(
        (m) => m.is_primary_for_query && m.family === e.family,
      );
      if (primaryMissing) {
        missing_catalog_entries.push({
          address: e.address,
          display_name: e.display_name,
          role: e.role,
          family: e.family,
          is_primary_for_query: false,
        });
      }
    }
  }

  const primaryMissing = missing_catalog_entries.some((m) => m.is_primary_for_query);
  const canonical_missing_from_upstream = primaryMissing;

  // Spoof-dominated: primary missing and results exist with spoof flags and/or
  // no primary catalog address present (upstream may return only impostors).
  const anySpoofFlag = pairs.some(
    (p) =>
      p.search_flags?.ticker_spoof_risk != null ||
      p.search_flags?.demoted === true,
  );
  const anyUncataloguedSameTicker = pairs.some((p) => {
    for (const side of [p.baseToken, p.quoteToken]) {
      const s = (side.symbol || "").trim().toUpperCase();
      if (s !== sym && !primaryEntries.some((e) => e.primary_symbols.includes(s) || e.sibling_symbols?.includes(s))) {
        continue;
      }
      // Matching ticker side without catalog origin
      if (s === sym || primaryEntries.some((e) => e.sibling_symbols?.includes(s))) {
        if (!tokenIsCatalogued(side)) return true;
      }
    }
    return false;
  });

  const spoof_dominated =
    canonical_missing_from_upstream &&
    pairs.length > 0 &&
    (anySpoofFlag || anyUncataloguedSameTicker || present_catalog_addresses.length === 0);

  let note: string;
  if (!canonical_missing_from_upstream) {
    note =
      "Primary catalog address for this query appears in upstream results; " +
      "still prefer address tools for identity-sensitive work.";
  } else if (spoof_dominated) {
    note =
      `Upstream symbol search for "${sym}" is spoof-dominated or omits the catalogued ` +
      `canonical asset(s). MCP will not invent missing DexScreener pairs — use ` +
      `dexscreener_token_pairs / dexscreener_tokens with the recommended 0x address(es). ` +
      `Symbol search remains discovery-only; address tools are identity truth.`;
  } else {
    note =
      `Catalogued primary asset(s) for "${sym}" are missing from upstream search results. ` +
      `Use dexscreener_token_pairs with the recommended address(es) — do not trust symbol alone.`;
  }

  const catalog_coverage: CatalogSearchCoverage = {
    query_matched_catalog: true,
    matched_symbols,
    present_catalog_addresses,
    missing_catalog_entries,
    canonical_missing_from_upstream,
    spoof_dominated,
    note,
  };

  const recommended_address_followups: RecommendedAddressFollowUp[] = [];
  if (canonical_missing_from_upstream) {
    // Primaries first, then siblings
    const ordered = [
      ...missing_catalog_entries.filter((m) => m.is_primary_for_query),
      ...missing_catalog_entries.filter((m) => !m.is_primary_for_query),
    ];
    for (const m of ordered) {
      recommended_address_followups.push({
        address: m.address,
        display_name: m.display_name,
        role: m.role,
        family: m.family,
        preferred_tool: "dexscreener_token_pairs",
        reason: m.is_primary_for_query
          ? `Canonical catalog asset for symbol "${sym}" was missing from upstream search; ` +
            `call dexscreener_token_pairs with this address for identity-true pools.`
          : `Related dual-asset catalog address (same family as "${sym}"); verify separately — not interchangeable.`,
      });
      // Curated major pair addresses (guidance only — never invent search rows)
      const catalogEntry = SEARCH_CATALOG_ENTRIES.find(
        (e) => e.address.toLowerCase() === m.address.toLowerCase(),
      );
      if (catalogEntry?.known_major_pairs) {
        for (const pair of catalogEntry.known_major_pairs) {
          recommended_address_followups.push({
            address: pair.address,
            display_name: pair.display_name,
            role: "known_major_pair_guidance",
            family: m.family,
            preferred_tool: "dexscreener_pair",
            reason:
              `Catalog major pair for ${catalogEntry.display_name} (guidance only — not a fabricated search row). ` +
              `Call dexscreener_pair with this pair address when upstream symbol search omits the canonical asset.`,
          });
        }
      }
    }
  }

  return { catalog_coverage, recommended_address_followups };
}

/**
 * Compose final search guidance string (base + missing-canonical supplement).
 * Pure.
 */
export function composeSearchGuidance(
  base: string,
  coverage: CatalogSearchCoverage | null,
  followups: RecommendedAddressFollowUp[],
): string {
  if (!coverage?.canonical_missing_from_upstream) {
    return base;
  }
  const parts = [base, coverage.note];
  if (followups.length > 0) {
    const list = followups
      .map(
        (f) =>
          `${f.display_name} → ${f.preferred_tool}(${f.address})`,
      )
      .join("; ");
    parts.push(`Recommended address follow-ups: ${list}.`);
  }
  return parts.join(" ");
}

/**
 * Annotate same-symbol collisions and rank catalogued addresses ahead of
 * unknown impostors. Does not drop pairs (discovery preserved). Pure.
 *
 * Rules:
 * - Prefer pairs with catalog origin labels (CORE / known addresses)
 * - When a ticker maps to multiple addresses, mark collisions
 * - Unknown-origin addresses sharing a ticker get ticker_spoof_risk annotation
 *   (stronger when a catalogued same-ticker address is also in the set, or low liq)
 * - Never invent token_origin for spoofs
 */
export function rankAndAnnotateSearchPairs(
  pairs: DexScreenerPairSummary[],
): {
  pairs: DexScreenerPairSummary[];
  symbol_collisions: DexScreenerSearchMeta["symbol_collisions"];
} {
  if (pairs.length === 0) {
    return { pairs: [], symbol_collisions: [] };
  }

  const symMap = collectSearchSymbolAddresses(pairs);
  const collidingSymbols = new Set<string>();
  for (const [sym, addrs] of symMap) {
    if (addrs.size > 1) collidingSymbols.add(sym);
  }

  // Per address: is any occurrence catalogued in this set?
  const addressCatalogued = new Map<string, boolean>();
  for (const p of pairs) {
    for (const side of [p.baseToken, p.quoteToken]) {
      const addr = (side.address || "").trim().toLowerCase();
      if (!addr) continue;
      const known = tokenIsCatalogued(side);
      addressCatalogued.set(
        addr,
        (addressCatalogued.get(addr) === true) || known,
      );
    }
  }

  const symbol_collisions: DexScreenerSearchMeta["symbol_collisions"] = [];
  for (const sym of [...collidingSymbols].sort()) {
    const addrs = [...(symMap.get(sym) ?? [])];
    const known_catalog_addresses = addrs.filter(
      (a) => addressCatalogued.get(a) === true,
    );
    const unknown_addresses = addrs.filter(
      (a) => addressCatalogued.get(a) !== true,
    );
    symbol_collisions.push({
      symbol: sym,
      addresses: addrs,
      known_catalog_addresses,
      unknown_addresses,
    });
  }

  const annotated = pairs.map((p) => {
    const colliding_symbols: string[] = [];
    let worstRisk: DexScreenerSearchFlags["ticker_spoof_risk"] | undefined;
    const reasons: string[] = [];

    for (const side of [p.baseToken, p.quoteToken]) {
      const sym = (side.symbol || "").trim().toUpperCase();
      const addr = (side.address || "").trim().toLowerCase();
      if (!sym || !collidingSymbols.has(sym)) continue;
      colliding_symbols.push(sym);

      const catalogued = tokenIsCatalogued(side);
      if (catalogued) continue;

      // Unknown address on a colliding ticker
      const peers = symMap.get(sym) ?? new Set();
      const hasCatalogPeer = [...peers].some(
        (a) => a !== addr && addressCatalogued.get(a) === true,
      );
      const liq = pairLiquidityUsd(p);
      let risk: NonNullable<DexScreenerSearchFlags["ticker_spoof_risk"]>;
      if (hasCatalogPeer) {
        risk = "high";
        reasons.push(
          `Ticker "${sym}" also appears at a catalogued address in these results; ` +
            `this ${side === p.baseToken ? "base" : "quote"} address is not in the MCP catalog ` +
            `(possible ticker spoof). Prefer address-keyed tools.`,
        );
      } else if (liq > 0 && liq < SEARCH_SPOOF_LOW_LIQ_USD) {
        risk = "high";
        reasons.push(
          `Ticker "${sym}" maps to multiple addresses; this unknown-origin side has relatively low liquidity (possible impostor).`,
        );
      } else {
        risk = "medium";
        reasons.push(
          `Ticker "${sym}" maps to multiple contract addresses in these results; verify 0x identity — do not trust symbol alone.`,
        );
      }
      if (
        !worstRisk ||
        (risk === "high" && worstRisk !== "high") ||
        (risk === "medium" && worstRisk === "low")
      ) {
        worstRisk = risk;
      }
    }

    if (colliding_symbols.length === 0 && !worstRisk) {
      // No collision involvement — leave pair clean (clone without search_flags)
      const { search_flags: _drop, ...rest } = p;
      void _drop;
      return rest as DexScreenerPairSummary;
    }

    // Demote when an unknown-origin side participates in a ticker collision
    // (even if the other side e.g. WPLS is catalogued).
    const demoted = worstRisk != null;

    const flags: DexScreenerSearchFlags = {
      symbol_collision: colliding_symbols.length > 0,
      demoted: demoted || undefined,
      colliding_symbols:
        colliding_symbols.length > 0
          ? [...new Set(colliding_symbols)]
          : undefined,
    };
    if (worstRisk) {
      flags.ticker_spoof_risk = worstRisk;
      flags.prefer_address_tools = true;
      flags.reason = reasons[0];
    } else if (colliding_symbols.length > 0) {
      // Catalogued side of a collision — still note collision for awareness
      flags.reason =
        `Ticker(s) ${[...new Set(colliding_symbols)].join(", ")} appear at multiple addresses in this search; ` +
        `this pair includes a catalogued address (prefer it over unlabelled same-ticker rows).`;
    }

    return { ...p, search_flags: flags };
  });

  // Stable rank: non-demoted first, lower spoof risk, then catalog score, liq, index
  const indexed = annotated.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => {
    const da = a.p.search_flags?.demoted ? 1 : 0;
    const db = b.p.search_flags?.demoted ? 1 : 0;
    if (da !== db) return da - db;
    const riskRank = (r?: string) =>
      r === "high" ? 3 : r === "medium" ? 2 : r === "low" ? 1 : 0;
    const ra = riskRank(a.p.search_flags?.ticker_spoof_risk);
    const rb = riskRank(b.p.search_flags?.ticker_spoof_risk);
    if (ra !== rb) return ra - rb;
    const ca = searchPairCatalogScore(a.p);
    const cb = searchPairCatalogScore(b.p);
    if (cb !== ca) return cb - ca;
    const la = pairLiquidityUsd(a.p);
    const lb = pairLiquidityUsd(b.p);
    if (lb !== la) return lb - la;
    return a.i - b.i;
  });

  return {
    pairs: indexed.map((x) => x.p),
    symbol_collisions,
  };
}

// ---------------------------------------------------------------------------
// HTTP client (injectable fetch for tests)
// ---------------------------------------------------------------------------

export type DexFetch = typeof fetch;

let lastRequestAt = 0;
let spacingChain: Promise<void> = Promise.resolve();

/** Test helper: reset rate-limit spacing state. */
export function resetDexScreenerSpacing(): void {
  lastRequestAt = 0;
  spacingChain = Promise.resolve();
}

async function respectMinInterval(): Promise<void> {
  // Serialize spacing so concurrent tool calls don't burst the public API.
  spacingChain = spacingChain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, DEXSCREENER_MIN_INTERVAL_MS - (now - lastRequestAt));
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    lastRequestAt = Date.now();
  });
  await spacingChain;
}

export interface DexScreenerFetchOptions {
  timeoutMs?: number;
  fetchImpl?: DexFetch;
  /** Skip min-interval spacing (tests). */
  skipSpacing?: boolean;
}

/**
 * GET JSON from DexScreener. Returns soft-fail on non-OK / network / timeout.
 * Does not throw for upstream failures.
 */
export async function dexscreenerGetJson(
  pathOrUrl: string,
  config: Pick<AppConfig, "httpTimeoutMs">,
  options: DexScreenerFetchOptions = {},
): Promise<
  | { ok: true; status: number; body: unknown; url: string }
  | { ok: false; reason: string; status?: number; url: string }
> {
  const base = DEXSCREENER_API_BASE;
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${base.replace(/\/$/, "")}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

  if (!options.skipSpacing) {
    await respectMinInterval();
  }

  const timeoutMs = options.timeoutMs ?? config.httpTimeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    if (res.status === 429) {
      return {
        ok: false,
        reason: "DexScreener rate limit (HTTP 429). Retry shortly.",
        status: 429,
        url,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: `DexScreener HTTP ${res.status}`,
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
        reason: "DexScreener returned invalid JSON",
        status: res.status,
        url,
      };
    }

    return { ok: true, status: res.status, body, url };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        reason: `DexScreener request timed out after ${timeoutMs}ms`,
        url,
      };
    }
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `DexScreener network error: ${err.message}`
          : "DexScreener network error",
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

function softFail(
  reason: string,
  extra: Partial<DexScreenerSoftFail> = {},
): DexScreenerSoftFail {
  return {
    ok: false,
    source: "dexscreener",
    reason,
    ...extra,
  };
}

function normalizePairList(body: unknown): DexScreenerPairSummary[] {
  return extractPairsFromResponse(body)
    .map(normalizeDexScreenerPair)
    .filter((p): p is DexScreenerPairSummary => p !== null);
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export async function searchDexScreenerPairs(
  config: Pick<AppConfig, "httpTimeoutMs">,
  query: string,
  options: {
    chainId?: string;
    pulsechainOnly?: boolean;
    fetchImpl?: DexFetch;
    skipSpacing?: boolean;
  } = {},
): Promise<
  DexScreenerResult<{
    query: string;
    pairs: DexScreenerPairSummary[];
    discovery_only: true;
    guidance: string;
    symbol_collisions: DexScreenerSearchMeta["symbol_collisions"];
    catalog_coverage?: CatalogSearchCoverage;
    recommended_address_followups?: RecommendedAddressFollowUp[];
  }>
> {
  const q = query.trim();
  if (!q) {
    return softFail("Search query is empty", { path: "/latest/dex/search" });
  }
  const url = buildDexScreenerSearchUrl(q);
  const res = await dexscreenerGetJson(url, config, options);
  if (!res.ok) {
    return softFail(res.reason, { status: res.status, path: "/latest/dex/search" });
  }

  let pairs = normalizePairList(res.body);
  const chainId = options.chainId ?? DEFAULT_DEXSCREENER_CHAIN;
  const pulseOnly = options.pulsechainOnly !== false;
  if (pulseOnly) {
    pairs = filterPairsByChain(pairs, chainId);
  }

  // Search-only: demote/annotate same-ticker unknowns; do not filter discovery out.
  const ranked = rankAndAnnotateSearchPairs(pairs);

  // When query matches known catalog assets and upstream omits them, surface
  // explicit missing-canonical guidance + address follow-ups (never invent pairs).
  const { catalog_coverage, recommended_address_followups } =
    buildCatalogSearchCoverage(q, ranked.pairs);
  const guidance = composeSearchGuidance(
    DEXSCREENER_SEARCH_GUIDANCE,
    catalog_coverage,
    recommended_address_followups,
  );

  return {
    ok: true,
    source: "dexscreener",
    chainId,
    pulsechainOnly: pulseOnly,
    pairCount: ranked.pairs.length,
    data: {
      query: q,
      pairs: ranked.pairs,
      discovery_only: true,
      guidance,
      symbol_collisions: ranked.symbol_collisions,
      ...(catalog_coverage ? { catalog_coverage } : {}),
      ...(recommended_address_followups.length > 0
        ? { recommended_address_followups }
        : {}),
    },
  };
}

export async function getDexScreenerPair(
  config: Pick<AppConfig, "httpTimeoutMs">,
  pairAddress: string,
  options: {
    chainId?: string;
    fetchImpl?: DexFetch;
    skipSpacing?: boolean;
  } = {},
): Promise<DexScreenerResult<{ pair: DexScreenerPairSummary | null }>> {
  const chainId = (options.chainId ?? DEFAULT_DEXSCREENER_CHAIN).toLowerCase();
  const pair = pairAddress.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(pair)) {
    return softFail("pairAddress must be a 0x…40-hex address", {
      path: "/latest/dex/pairs",
      chainId,
    });
  }
  const url = buildDexScreenerPairUrl(chainId, pair);
  const res = await dexscreenerGetJson(url, config, options);
  if (!res.ok) {
    return softFail(res.reason, {
      status: res.status,
      path: `/latest/dex/pairs/${chainId}/…`,
      chainId,
    });
  }
  const pairs = normalizePairList(res.body);
  return {
    ok: true,
    source: "dexscreener",
    chainId,
    pairCount: pairs.length,
    data: { pair: pairs[0] ?? null },
  };
}

export async function getDexScreenerTokenPairs(
  config: Pick<AppConfig, "httpTimeoutMs">,
  tokenAddress: string,
  options: {
    chainId?: string;
    fetchImpl?: DexFetch;
    skipSpacing?: boolean;
  } = {},
): Promise<DexScreenerResult<{ tokenAddress: string; pairs: DexScreenerPairSummary[] }>> {
  const chainId = (options.chainId ?? DEFAULT_DEXSCREENER_CHAIN).toLowerCase();
  const token = tokenAddress.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(token)) {
    return softFail("tokenAddress must be a 0x…40-hex address", {
      path: "/token-pairs/v1",
      chainId,
    });
  }
  const url = buildDexScreenerTokenPairsUrl(chainId, token);
  const res = await dexscreenerGetJson(url, config, options);
  if (!res.ok) {
    return softFail(res.reason, {
      status: res.status,
      path: `/token-pairs/v1/${chainId}/…`,
      chainId,
    });
  }
  const pairs = normalizePairList(res.body);
  return {
    ok: true,
    source: "dexscreener",
    chainId,
    pairCount: pairs.length,
    data: { tokenAddress: token, pairs },
  };
}

export async function getDexScreenerTokens(
  config: Pick<AppConfig, "httpTimeoutMs">,
  tokenAddresses: string[],
  options: {
    chainId?: string;
    fetchImpl?: DexFetch;
    skipSpacing?: boolean;
  } = {},
): Promise<DexScreenerResult<{ tokens: string[]; pairs: DexScreenerPairSummary[] }>> {
  const chainId = (options.chainId ?? DEFAULT_DEXSCREENER_CHAIN).toLowerCase();
  const tokens = tokenAddresses.map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    return softFail("At least one token address is required", {
      path: "/tokens/v1",
      chainId,
    });
  }
  for (const t of tokens) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(t)) {
      return softFail(`Invalid token address: ${t}`, {
        path: "/tokens/v1",
        chainId,
      });
    }
  }
  // DexScreener allows up to 30 addresses
  const limited = tokens.slice(0, 30);
  const url = buildDexScreenerTokensUrl(chainId, limited);
  const res = await dexscreenerGetJson(url, config, options);
  if (!res.ok) {
    return softFail(res.reason, {
      status: res.status,
      path: `/tokens/v1/${chainId}/…`,
      chainId,
    });
  }
  const pairs = normalizePairList(res.body);
  return {
    ok: true,
    source: "dexscreener",
    chainId,
    pairCount: pairs.length,
    data: { tokens: limited, pairs },
  };
}

export async function getDexScreenerBoostsLatest(
  config: Pick<AppConfig, "httpTimeoutMs">,
  options: {
    chainId?: string;
    pulsechainOnly?: boolean;
    fetchImpl?: DexFetch;
    skipSpacing?: boolean;
  } = {},
): Promise<DexScreenerResult<{ boosts: unknown[] }>> {
  const url = buildDexScreenerBoostsLatestUrl();
  const res = await dexscreenerGetJson(url, config, options);
  if (!res.ok) {
    return softFail(res.reason, {
      status: res.status,
      path: "/token-boosts/latest/v1",
    });
  }
  let boosts = Array.isArray(res.body) ? res.body : [];
  const chainId = options.chainId ?? DEFAULT_DEXSCREENER_CHAIN;
  if (options.pulsechainOnly !== false) {
    boosts = boosts.filter((b) => {
      const r = asRecord(b);
      return r && str(r.chainId).toLowerCase() === chainId.toLowerCase();
    });
  }
  return {
    ok: true,
    source: "dexscreener",
    chainId,
    pulsechainOnly: options.pulsechainOnly !== false,
    data: { boosts },
  };
}

export async function getDexScreenerProfilesLatest(
  config: Pick<AppConfig, "httpTimeoutMs">,
  options: {
    chainId?: string;
    pulsechainOnly?: boolean;
    fetchImpl?: DexFetch;
    skipSpacing?: boolean;
  } = {},
): Promise<DexScreenerResult<{ profiles: unknown[] }>> {
  const url = buildDexScreenerProfilesLatestUrl();
  const res = await dexscreenerGetJson(url, config, options);
  if (!res.ok) {
    return softFail(res.reason, {
      status: res.status,
      path: "/token-profiles/latest/v1",
    });
  }
  let profiles = Array.isArray(res.body) ? res.body : [];
  const chainId = options.chainId ?? DEFAULT_DEXSCREENER_CHAIN;
  if (options.pulsechainOnly !== false) {
    profiles = profiles.filter((p) => {
      const r = asRecord(p);
      return r && str(r.chainId).toLowerCase() === chainId.toLowerCase();
    });
  }
  return {
    ok: true,
    source: "dexscreener",
    chainId,
    pulsechainOnly: options.pulsechainOnly !== false,
    data: { profiles },
  };
}
