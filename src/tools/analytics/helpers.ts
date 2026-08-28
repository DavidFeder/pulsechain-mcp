/**
 * Pure helpers for free-tier analytics (scoring, parsing, tiers).
 * No network I/O — unit-testable offline.
 */

import { tokenLabelFields } from "../../constants.js";

export function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}

export function isoDateFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
}

export type SafetyGrade = "A" | "B" | "C" | "D" | "F";

export function scoreToGrade(score: number): SafetyGrade {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export interface SafetySignals {
  /** Contract source verified on explorer */
  verified: boolean;
  /** Ownable owner() is zero / renounced, or no owner interface */
  ownershipRenounced: boolean | null;
  /** Total liquidity USD across pairs */
  liquidityUsd: number;
  /** Top-holder share of supply (0-1), if known */
  topHolderShare: number | null;
  /** Top-10 holder share of supply (0-1), if known */
  top10Share: number | null;
  /** Token age proxy in days from first day-data / pair timestamp */
  ageDays: number | null;
  /** Heuristic honeypot / high-tax flags */
  honeypotFlags: string[];
  /** Suspicious ABI patterns (blacklist, setTax, etc.) */
  suspiciousAbi: string[];
}

/**
 * Composite safety score 0–100 from public signals.
 * NOT a full audit — documented as heuristic.
 */
export function computeSafetyScore(signals: SafetySignals): {
  score: number;
  grade: SafetyGrade;
  factors: Record<string, { score: number; detail: string }>;
} {
  const factors: Record<string, { score: number; detail: string }> = {};
  let total = 0;
  let weightSum = 0;

  const add = (
    key: string,
    weight: number,
    score: number,
    detail: string,
  ) => {
    factors[key] = { score, detail };
    total += score * weight;
    weightSum += weight;
  };

  // Verification
  add(
    "verified",
    15,
    signals.verified ? 100 : 25,
    signals.verified
      ? "Contract source verified on BlockScout"
      : "Contract not verified on explorer",
  );

  // Ownership
  if (signals.ownershipRenounced === true) {
    add("ownership", 20, 100, "Ownership renounced (owner is zero address)");
  } else if (signals.ownershipRenounced === false) {
    add("ownership", 20, 40, "Ownership still held (owner() non-zero)");
  } else {
    add(
      "ownership",
      10,
      60,
      "No Ownable owner() interface detected (unknown)",
    );
  }

  // Liquidity
  const liq = signals.liquidityUsd;
  let liqScore = 10;
  if (liq >= 500_000) liqScore = 100;
  else if (liq >= 100_000) liqScore = 85;
  else if (liq >= 25_000) liqScore = 70;
  else if (liq >= 5_000) liqScore = 50;
  else if (liq >= 1_000) liqScore = 30;
  add(
    "liquidity",
    20,
    liqScore,
    `Aggregated pool liquidity ~$${liq.toFixed(0)}`,
  );

  // Holder concentration
  if (signals.topHolderShare !== null) {
    const share = signals.topHolderShare;
    let hScore = 100;
    if (share >= 0.5) hScore = 15;
    else if (share >= 0.3) hScore = 35;
    else if (share >= 0.15) hScore = 55;
    else if (share >= 0.08) hScore = 75;
    add(
      "top_holder",
      15,
      hScore,
      `Top holder holds ~${(share * 100).toFixed(1)}% of supply`,
    );
  }
  if (signals.top10Share !== null) {
    const share = signals.top10Share;
    let hScore = 100;
    if (share >= 0.9) hScore = 20;
    else if (share >= 0.7) hScore = 40;
    else if (share >= 0.5) hScore = 60;
    else if (share >= 0.3) hScore = 80;
    add(
      "top10_holders",
      10,
      hScore,
      `Top 10 holders hold ~${(share * 100).toFixed(1)}% of supply`,
    );
  }

  // Age
  if (signals.ageDays !== null) {
    const d = signals.ageDays;
    let aScore = 20;
    if (d >= 365) aScore = 100;
    else if (d >= 90) aScore = 85;
    else if (d >= 30) aScore = 70;
    else if (d >= 7) aScore = 45;
    add("age", 10, aScore, `Approximate token age ~${d.toFixed(0)} days`);
  }

  // Honeypot / ABI risk
  const flagLabels = [
    ...new Set([...signals.honeypotFlags, ...signals.suspiciousAbi]),
  ];
  const flagCount = flagLabels.length;
  let riskScore = 100;
  if (flagCount >= 3) riskScore = 10;
  else if (flagCount === 2) riskScore = 30;
  else if (flagCount === 1) riskScore = 55;
  add(
    "contract_risk",
    20,
    riskScore,
    flagCount === 0
      ? "No heuristic honeypot/tax flags detected"
      : `Flags: ${flagLabels.join(", ")}`,
  );

  const score =
    weightSum > 0 ? Math.round(Math.min(100, Math.max(0, total / weightSum))) : 50;

  return { score, grade: scoreToGrade(score), factors };
}

/** Suspicious ABI / source keywords used as soft honeypot proxies. */
export const SUSPICIOUS_ABI_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /blacklist|blackList|isBlacklisted/i, label: "blacklist" },
  { re: /setTax|setFees|setBuyTax|setSellTax|buyTax|sellTax|_tax/i, label: "mutable_tax" },
  { re: /maxTx|maxTransaction|maxWallet|_maxTxAmount/i, label: "max_tx_limits" },
  { re: /enableTrading|tradingEnabled|setTrading/i, label: "trading_toggle" },
  { re: /onlyOwner.*transfer|transfer.*onlyOwner/i, label: "owner_gated_transfer" },
  { re: /isBot|antiBot|sniper/i, label: "antibot" },
];

export function scanSuspiciousPatterns(text: string): string[] {
  const found: string[] = [];
  for (const { re, label } of SUSPICIOUS_ABI_PATTERNS) {
    if (re.test(text) && !found.includes(label)) found.push(label);
  }
  return found;
}

/**
 * Holder league tiers (approximate USD buckets used by community tools).
 * Applied to token balance × priceUSD when available.
 */
export const HOLDER_LEAGUE_TIERS = [
  { tier: "poseidon", minUsd: 1_000_000 },
  { tier: "whale", minUsd: 100_000 },
  { tier: "shark", minUsd: 10_000 },
  { tier: "dolphin", minUsd: 1_000 },
  { tier: "squid", minUsd: 100 },
  { tier: "turtle", minUsd: 0 },
] as const;

export type HolderLeagueTier = (typeof HOLDER_LEAGUE_TIERS)[number]["tier"];

export function tierForUsd(balanceUsd: number): HolderLeagueTier {
  for (const t of HOLDER_LEAGUE_TIERS) {
    if (balanceUsd >= t.minUsd) return t.tier;
  }
  return "turtle";
}

export function bucketHoldersByLeague(
  holders: Array<{ balanceUsd: number }>,
): Array<{
  tier: HolderLeagueTier;
  holder_count: number;
  min_balance_usd: number;
  total_value_usd: number;
}> {
  const buckets = HOLDER_LEAGUE_TIERS.map((t) => ({
    tier: t.tier as HolderLeagueTier,
    holder_count: 0,
    min_balance_usd: t.minUsd,
    total_value_usd: 0,
  }));

  for (const h of holders) {
    const tier = tierForUsd(h.balanceUsd);
    const b = buckets.find((x) => x.tier === tier);
    if (b) {
      b.holder_count += 1;
      b.total_value_usd += h.balanceUsd;
    }
  }
  return buckets;
}

/**
 * Subgraph reserveUSD pollution guards.
 * PulseChain major pools are far below multi-billion; values above this cap are
 * treated as pathological (dust memes / bad derivedUSD) for ranking and TVL sums.
 */
export const MAX_SANE_PAIR_RESERVE_USD = 5_000_000_000; // $5B hard cap per pair
/** Soft flag: pairs above this are demoted even if under the hard cap. */
export const SUSPECT_PAIR_RESERVE_USD = 500_000_000; // $500M
/**
 * Per-token derivedUSD above this is treated as oracle pollution for estimates
 * (a single whole token priced above $100k is not a usable PulseX input).
 */
export const MAX_SANE_TOKEN_DERIVED_USD = 100_000;

/**
 * True when reserveUSD is finite, non-negative, and under the hard pollution cap.
 * Pure / unit-testable.
 */
export function isSaneReserveUsd(
  reserveUsd: unknown,
  max = MAX_SANE_PAIR_RESERVE_USD,
): boolean {
  const n = num(reserveUsd, Number.NaN);
  return Number.isFinite(n) && n >= 0 && n <= max;
}

/**
 * Liquidity value used for ranking/sums: absurd reserveUSD → 0 (demoted).
 * Pure / unit-testable.
 */
export function saneLiquidityUsd(
  reserveUsd: unknown,
  max = MAX_SANE_PAIR_RESERVE_USD,
): number {
  const n = num(reserveUsd);
  if (!Number.isFinite(n) || n < 0 || n > max) return 0;
  return n;
}

/**
 * Sanitize token-level liquidity_usd_estimate = totalLiquidity × derivedUSD.
 * Absurd unit prices or TVL-scale products are demoted to 0 (not invented ranks).
 * Pure / unit-testable.
 */
export function resolveTokenLiquidityUsdEstimate(
  totalLiquidity: unknown,
  derivedUsd: unknown,
): {
  liquidityUsd: number;
  rawEstimate: number;
  polluted: boolean;
  priceSane: boolean;
} {
  const units = num(totalLiquidity, Number.NaN);
  const price = num(derivedUsd, Number.NaN);
  if (!Number.isFinite(units) || units < 0) {
    return { liquidityUsd: 0, rawEstimate: 0, polluted: true, priceSane: false };
  }
  if (!Number.isFinite(price) || price < 0) {
    return { liquidityUsd: 0, rawEstimate: 0, polluted: true, priceSane: false };
  }
  const raw = units * price;
  if (!Number.isFinite(raw) || raw < 0) {
    return { liquidityUsd: 0, rawEstimate: 0, polluted: true, priceSane: false };
  }
  // Absurd per-token derivedUSD → demote (meme oracle pollution)
  if (price > MAX_SANE_TOKEN_DERIVED_USD) {
    return {
      liquidityUsd: 0,
      rawEstimate: raw,
      polluted: true,
      priceSane: false,
    };
  }
  // Absurd total estimate (same hard cap as pair reserve pollution)
  if (raw > MAX_SANE_PAIR_RESERVE_USD) {
    return {
      liquidityUsd: 0,
      rawEstimate: raw,
      polluted: true,
      priceSane: true,
    };
  }
  return {
    liquidityUsd: raw,
    rawEstimate: raw,
    polluted: raw > SUSPECT_PAIR_RESERVE_USD,
    priceSane: true,
  };
}

/**
 * Optional estimate from reserves × token derivedUSD when subgraph reserveUSD
 * is absurd. Returns null when inputs are missing or derivedUSD is polluted.
 * Pure / unit-testable.
 */
export function estimatePairLiquidityUsd(pair: {
  reserve0?: string | number;
  reserve1?: string | number;
  token0?: { derivedUSD?: string | number; decimals?: string | number };
  token1?: { derivedUSD?: string | number; decimals?: string | number };
}): number | null {
  const d0 = num(pair.token0?.derivedUSD, Number.NaN);
  const d1 = num(pair.token1?.derivedUSD, Number.NaN);
  const r0 = num(pair.reserve0, Number.NaN);
  const r1 = num(pair.reserve1, Number.NaN);
  if (
    !Number.isFinite(d0) ||
    !Number.isFinite(d1) ||
    !Number.isFinite(r0) ||
    !Number.isFinite(r1)
  ) {
    return null;
  }
  // Reject absurd per-token derivedUSD so re-estimates cannot re-inflate pollution
  if (
    d0 < 0 ||
    d1 < 0 ||
    d0 > MAX_SANE_TOKEN_DERIVED_USD ||
    d1 > MAX_SANE_TOKEN_DERIVED_USD
  ) {
    return null;
  }
  // Subgraph reserves are already human units (not raw wei) on PulseX schema
  const est = r0 * d0 + r1 * d1;
  if (!Number.isFinite(est) || est < 0) return null;
  if (est > MAX_SANE_PAIR_RESERVE_USD) return null;
  return est;
}

/**
 * Resolve a ranking/display liquidity for a pair: prefer sane reserveUSD;
 * else try reserve×price estimate; else 0 with pollution flag.
 * Pure / unit-testable.
 */
export function resolvePairLiquidityUsd(pair: {
  reserveUSD?: string | number;
  reserve0?: string | number;
  reserve1?: string | number;
  /** Optional derivedUSD for re-estimate; other token fields ignored. */
  token0?: { derivedUSD?: string | number; id?: string; symbol?: string };
  token1?: { derivedUSD?: string | number; id?: string; symbol?: string };
}): {
  liquidityUsd: number;
  rawReserveUsd: number;
  polluted: boolean;
  source: "reserveUSD" | "estimated" | "demoted";
} {
  const raw = num(pair.reserveUSD);
  const est = estimatePairLiquidityUsd(pair);

  // Sane reserveUSD under hard cap — but if reserves×derivedUSD is far lower,
  // trust the estimate (inflated subgraph reserve is common under the hard cap).
  if (isSaneReserveUsd(raw)) {
    if (est !== null && est > 0 && raw > 0 && est < raw * 0.1) {
      return {
        liquidityUsd: est,
        rawReserveUsd: raw,
        polluted: true,
        source: "estimated",
      };
    }
    return {
      liquidityUsd: raw,
      rawReserveUsd: raw,
      polluted: raw > SUSPECT_PAIR_RESERVE_USD,
      source: "reserveUSD",
    };
  }
  if (est !== null && est > 0) {
    return {
      liquidityUsd: est,
      rawReserveUsd: raw,
      polluted: true,
      source: "estimated",
    };
  }
  return {
    liquidityUsd: 0,
    rawReserveUsd: raw,
    polluted: true,
    source: "demoted",
  };
}

/**
 * token0_price / token1_price from the PulseX subgraph are **pair-relative**
 * (token1 per token0 and inverse) — **not USD**. Prefer reserves, get_token_price,
 * or DexScreener-by-address for pricing.
 */
export const PAIR_PRICE_FIELDS_NOTE =
  "token0_price and token1_price are pair-relative (token1 per token0 / inverse), NOT USD. " +
  "Prefer reserve0/reserve1, get_token_price, or DexScreener by token/pair address for pricing.";

export type LiquidityMappedPair = {
  pair_address: string;
  token0_address?: string;
  token0_symbol?: string;
  /** Catalog display symbol (e.g. pHEX, eHEX, pDAI) when address is known. */
  token0_display_symbol?: string;
  /** Catalog origin (pulsechain | ethereum_bridged | …) when address is known. */
  token0_origin?: string;
  token1_address?: string;
  token1_symbol?: string;
  token1_display_symbol?: string;
  token1_origin?: string;
  liquidity_usd: number;
  raw_reserve_usd: number;
  liquidity_polluted: boolean;
  liquidity_source: "reserveUSD" | "estimated" | "demoted";
  volume_usd_cumulative: number;
  tx_count: number;
  reserve0?: string | number;
  reserve1?: string | number;
  /**
   * Pair-relative price (token1 per token0) — **not USD**.
   * See PAIR_PRICE_FIELDS_NOTE.
   */
  token0_price?: number;
  /**
   * Pair-relative price (token0 per token1) — **not USD**.
   * See PAIR_PRICE_FIELDS_NOTE.
   */
  token1_price?: number;
};

/**
 * Attach catalog origin / display_symbol for a pair side when the address is
 * known. Never invents origin for unknown tokens. Pure.
 */
export function catalogPairSideLabels(
  address: string | undefined | null,
): { display_symbol?: string; origin?: string } {
  if (!address || typeof address !== "string") return {};
  const fields = tokenLabelFields(address);
  if (!fields) return {};
  const out: { display_symbol?: string; origin?: string } = {};
  if (typeof fields.display_symbol === "string") {
    out.display_symbol = fields.display_symbol;
  }
  if (typeof fields.token_origin === "string") {
    out.origin = fields.token_origin;
  }
  return out;
}

type RankablePair = {
  id?: string;
  reserveUSD?: string | number;
  reserve0?: string | number;
  reserve1?: string | number;
  volumeUSD?: string | number;
  totalTransactions?: string | number;
  token0Price?: string | number;
  token1Price?: string | number;
  token0?: {
    id?: string;
    symbol?: string;
    derivedUSD?: string | number;
  };
  token1?: {
    id?: string;
    symbol?: string;
    derivedUSD?: string | number;
  };
};

/**
 * Map raw subgraph pairs into display rows with sanitized liquidity.
 * Attaches catalog origin/display_symbol for known token0/token1 addresses only.
 * token0_price/token1_price remain pair-relative (not USD).
 * Pure / unit-testable.
 */
export function mapPairsWithSaneLiquidity(
  pairs: RankablePair[],
): LiquidityMappedPair[] {
  return pairs.map((p) => {
    const liq = resolvePairLiquidityUsd(p);
    const t0 = catalogPairSideLabels(p.token0?.id);
    const t1 = catalogPairSideLabels(p.token1?.id);
    return {
      pair_address: p.id ?? "",
      token0_address: p.token0?.id,
      token0_symbol: p.token0?.symbol,
      ...(t0.display_symbol
        ? { token0_display_symbol: t0.display_symbol }
        : {}),
      ...(t0.origin ? { token0_origin: t0.origin } : {}),
      token1_address: p.token1?.id,
      token1_symbol: p.token1?.symbol,
      ...(t1.display_symbol
        ? { token1_display_symbol: t1.display_symbol }
        : {}),
      ...(t1.origin ? { token1_origin: t1.origin } : {}),
      liquidity_usd: liq.liquidityUsd,
      raw_reserve_usd: liq.rawReserveUsd,
      liquidity_polluted: liq.polluted,
      liquidity_source: liq.source,
      volume_usd_cumulative: num(p.volumeUSD),
      tx_count: num(p.totalTransactions),
      reserve0: p.reserve0,
      reserve1: p.reserve1,
      // Pair-relative — NOT USD (see PAIR_PRICE_FIELDS_NOTE)
      token0_price: num(p.token0Price),
      token1_price: num(p.token1Price),
    };
  });
}

/**
 * Select useful top pairs for liquidity ranking.
 * Prefers non-polluted rows with positive sanitized liquidity; never returns
 * empty when the input window still has demoted/volume-active pairs (fallback
 * by volume so get_top_pairs(sort=liquidity) stays useful).
 * Pure / unit-testable.
 */
export function selectTopPairsByLiquidity(
  pairs: RankablePair[],
  limit: number,
): {
  pairs: LiquidityMappedPair[];
  droppedDemoted: number;
  usedVolumeFallback: boolean;
} {
  const mapped = mapPairsWithSaneLiquidity(pairs);
  const withLiq = mapped
    .filter((p) => p.liquidity_usd > 0)
    .sort(compareLiquidityMapped);

  if (withLiq.length > 0) {
    return {
      pairs: withLiq.slice(0, limit),
      droppedDemoted: mapped.length - withLiq.length,
      usedVolumeFallback: false,
    };
  }

  // All demoted: keep a volume-ranked window so the tool is not empty
  const fallback = [...mapped]
    .sort(
      (a, b) =>
        b.volume_usd_cumulative - a.volume_usd_cumulative ||
        b.tx_count - a.tx_count,
    )
    .slice(0, limit);
  return {
    pairs: fallback,
    droppedDemoted: mapped.length,
    usedVolumeFallback: true,
  };
}

function compareLiquidityMapped(
  a: LiquidityMappedPair,
  b: LiquidityMappedPair,
): number {
  // Primary: sanitized liquidity. Prefer non-polluted / reserveUSD source on ties
  // so polluted re-estimates do not crowd out equally-liquid trusted pools.
  if (b.liquidity_usd !== a.liquidity_usd) {
    return b.liquidity_usd - a.liquidity_usd;
  }
  if (a.liquidity_polluted !== b.liquidity_polluted) {
    return a.liquidity_polluted ? 1 : -1;
  }
  const sourceRank = (s: LiquidityMappedPair["liquidity_source"]) =>
    s === "reserveUSD" ? 2 : s === "estimated" ? 1 : 0;
  return sourceRank(b.liquidity_source) - sourceRank(a.liquidity_source);
}

/**
 * True when a pair shows high "liquidity" with negligible cumulative volume —
 * typical subgraph junk rails (meme-staked reserveUSD) that must not lead
 * get_token_info or dominate total_liquidity_usd. Pure / unit-testable.
 *
 * Residual: ranking improves trust; subgraph can still be wrong. Not an oracle.
 */
export function isGhostLiquidityPair(pair: {
  reserveUSD?: string | number;
  reserve0?: string | number;
  reserve1?: string | number;
  volumeUSD?: string | number;
  token0?: { derivedUSD?: string | number; id?: string; symbol?: string };
  token1?: { derivedUSD?: string | number; id?: string; symbol?: string };
}): boolean {
  const r = resolvePairLiquidityUsd(pair);
  const liq = r.liquidityUsd;
  if (!(liq > 0)) return false;
  // Without volumeUSD we cannot detect ghost rails — reserve pollution only.
  const volRaw = pair.volumeUSD;
  const volKnown =
    volRaw !== undefined && volRaw !== null && String(volRaw).trim() !== "";
  if (!volKnown) return false;
  const vol = num(pair.volumeUSD);
  // Large USD "liquidity" with almost no all-time volume
  if (liq >= 1_000_000 && vol < 10_000) return true;
  if (liq >= 100_000 && vol < 100) return true;
  // Extreme liquidity/volume ratio (stale or fake reserveUSD)
  if (vol > 0 && liq / vol > 50_000) return true;
  if (vol === 0 && liq >= 50_000) return true;
  return false;
}

/**
 * Catalog rail preference for ranking: both sides known > one side > none.
 * Never invents catalog labels. Pure / unit-testable.
 */
export function catalogRailScore(pair: {
  token0?: { id?: string };
  token1?: { id?: string };
}): number {
  let score = 0;
  if (pair.token0?.id && tokenLabelFields(pair.token0.id)) score += 1;
  if (pair.token1?.id && tokenLabelFields(pair.token1.id)) score += 1;
  return score;
}

/**
 * Sort pairs by quality then sane liquidity.
 * Order: usable non-ghost non-polluted first → catalog rails → liquidity → volume.
 * Demoted/ghost/polluted sink so junk cannot lead get_token_info.
 * Pure / unit-testable.
 */
export function rankPairsBySaneLiquidity<
  T extends {
    reserveUSD?: string | number;
    reserve0?: string | number;
    reserve1?: string | number;
    volumeUSD?: string | number;
    token0?: { derivedUSD?: string | number; id?: string; symbol?: string };
    token1?: { derivedUSD?: string | number; id?: string; symbol?: string };
  },
>(pairs: T[]): Array<
  T & {
    _saneLiquidityUsd: number;
    _liquidityPolluted: boolean;
    _liquiditySource: "reserveUSD" | "estimated" | "demoted";
    _ghostLiquidity: boolean;
    _catalogRailScore: number;
  }
> {
  return pairs
    .map((p) => {
      const resolved = resolvePairLiquidityUsd(p);
      const ghost = isGhostLiquidityPair(p);
      return {
        ...p,
        // Ranking weight: ghost rails keep raw for debug but sort as unusable
        _saneLiquidityUsd: ghost ? 0 : resolved.liquidityUsd,
        _liquidityPolluted: resolved.polluted || ghost,
        _liquiditySource: ghost
          ? ("demoted" as const)
          : resolved.source,
        _ghostLiquidity: ghost,
        _catalogRailScore: catalogRailScore(p),
        // Preserve resolved display liquidity for totals that opt in later
        _rawSaneLiquidityUsd: resolved.liquidityUsd,
      };
    })
    .sort((a, b) => {
      // 1) Prefer pairs with positive ranking liquidity
      const aPos = a._saneLiquidityUsd > 0;
      const bPos = b._saneLiquidityUsd > 0;
      if (aPos !== bPos) return aPos ? -1 : 1;
      // 2) Prefer non-polluted / non-ghost
      if (a._liquidityPolluted !== b._liquidityPolluted) {
        return a._liquidityPolluted ? 1 : -1;
      }
      // 3) Prefer catalog major rails (both sides known > one side)
      if (a._catalogRailScore !== b._catalogRailScore) {
        return b._catalogRailScore - a._catalogRailScore;
      }
      // 4) Higher sane liquidity
      if (b._saneLiquidityUsd !== a._saneLiquidityUsd) {
        return b._saneLiquidityUsd - a._saneLiquidityUsd;
      }
      // 5) Higher cumulative volume (real activity)
      const volA = num(
        (a as { volumeUSD?: string | number }).volumeUSD,
      );
      const volB = num(
        (b as { volumeUSD?: string | number }).volumeUSD,
      );
      if (volB !== volA) return volB - volA;
      const sourceRank = (s: typeof a._liquiditySource) =>
        s === "reserveUSD" ? 2 : s === "estimated" ? 1 : 0;
      return sourceRank(b._liquiditySource) - sourceRank(a._liquiditySource);
    });
}

/**
 * Deduplicate pair rows by lowercase id, preserving first-seen order.
 * Used so shared stablecoin pools are not double-counted in bridge TVL.
 */
export function uniquePairsById<T extends { id?: string }>(
  groups: T[][],
): T[] {
  const map = new Map<string, T>();
  for (const group of groups) {
    for (const p of group) {
      const id = (p.id ?? "").toLowerCase();
      if (id && !map.has(id)) map.set(id, p);
    }
  }
  return [...map.values()];
}

/**
 * Sum trust-worthy pair liquidity for TVL-style totals.
 * Excludes demoted, ghost (high-reserve / near-zero-volume), and zero rows so
 * a single junk pair cannot dominate total_liquidity_usd.
 * Polluted-but-estimated non-ghost rows still contribute their reduced estimate.
 * Pure / unit-testable.
 */
export function sumSanePairLiquidity(
  pairs: Array<{
    reserveUSD?: string | number;
    reserve0?: string | number;
    reserve1?: string | number;
    volumeUSD?: string | number;
    token0?: { derivedUSD?: string | number; id?: string; symbol?: string };
    token1?: { derivedUSD?: string | number; id?: string; symbol?: string };
  }>,
): {
  totalUsd: number;
  pollutedPairCount: number;
  ghostPairCount: number;
  pairCount: number;
  excludedFromTotalCount: number;
} {
  let totalUsd = 0;
  let pollutedPairCount = 0;
  let ghostPairCount = 0;
  let excludedFromTotalCount = 0;
  for (const p of pairs) {
    const r = resolvePairLiquidityUsd(p);
    const ghost = isGhostLiquidityPair(p);
    if (ghost) ghostPairCount += 1;
    if (r.polluted || ghost) pollutedPairCount += 1;
    // Do not let demoted or ghost rails inflate aggregates
    if (r.source === "demoted" || r.liquidityUsd <= 0 || ghost) {
      excludedFromTotalCount += 1;
      continue;
    }
    totalUsd += r.liquidityUsd;
  }
  return {
    totalUsd,
    pollutedPairCount,
    ghostPairCount,
    pairCount: pairs.length,
    excludedFromTotalCount,
  };
}

/**
 * True when a subgraph swap involves the given token address (token0 or token1).
 * Pure / unit-testable.
 */
export function swapInvolvesToken(
  swap: {
    pair?: {
      token0?: { id?: string };
      token1?: { id?: string };
    };
  },
  tokenAddress: string,
): boolean {
  const t = tokenAddress.toLowerCase();
  const t0 = swap.pair?.token0?.id?.toLowerCase();
  const t1 = swap.pair?.token1?.id?.toLowerCase();
  return t0 === t || t1 === t;
}

// ---------------------------------------------------------------------------
// Soft-fail token info assembly + origin label parity (v0.1.37)
// ---------------------------------------------------------------------------

/** Subgraph token entity fields used by get_token_info (optional when blipping). */
export type TokenInfoSubgraphToken = {
  id?: string;
  symbol?: string;
  name?: string;
  decimals?: string | number;
  totalSupply?: string;
  tradeVolumeUSD?: string | number;
  totalTransactions?: string | number;
  totalLiquidity?: string | number;
  derivedPLS?: string | number;
  derivedUSD?: string | number;
} | null;

export type TokenInfoExplorerV2 = {
  name?: string | null;
  symbol?: string | null;
  decimals?: string | number | null;
  total_supply?: string | null;
  holders?: string | number | null;
} | null;

/**
 * Assemble get_token_info payload from partial sources.
 * Soft-success when catalog identity and/or explorer/v2 remain even if the
 * PulseX token entity blips. Never invents token_origin for unknown addresses.
 * Pure / unit-testable.
 */
export function buildTokenInfoPayload(params: {
  address: string;
  version: string;
  token: TokenInfoSubgraphToken;
  pairs: RankablePair[];
  explorerMeta: Record<string, unknown> | null;
  v2Meta: TokenInfoExplorerV2;
  /** When true, subgraph token fetch failed (not merely missing). */
  subgraphTokenFailed?: boolean;
  subgraphTokenError?: string;
  pairsFailed?: boolean;
  pairsError?: string;
  explorerUiBase?: string;
}): { found: false; reason: string } | { found: true; data: Record<string, unknown> } {
  const address = params.address.trim().toLowerCase();
  const identity = tokenLabelFields(address) ?? {};
  const hasCatalog = Object.keys(identity).length > 0;
  const token = params.token;
  const explorerObj =
    params.explorerMeta && typeof params.explorerMeta === "object"
      ? params.explorerMeta
      : {};
  const hasExplorer =
    params.explorerMeta != null && Object.keys(explorerObj).length > 0;
  const hasV2 = params.v2Meta != null;
  const hasToken = token != null;

  if (!hasToken && !hasExplorer && !hasV2 && !hasCatalog) {
    return {
      found: false,
      reason: `Token not found: ${address}`,
    };
  }

  const pairs = Array.isArray(params.pairs) ? params.pairs : [];
  const priceUsd = num(token?.derivedUSD);
  const liqToken = num(token?.totalLiquidity);
  const liqAgg = sumSanePairLiquidity(pairs);
  // Prefer pair-sum of trust-worthy rails; fall back to token entity product
  const totalLiquidityUsd = liqAgg.totalUsd || liqToken * priceUsd;
  const rankedPairs = rankPairsBySaneLiquidity(pairs);
  const preferredPair =
    rankedPairs.find((p) => p._saneLiquidityUsd > 0 && !p._ghostLiquidity) ??
    rankedPairs.find((p) => p._saneLiquidityUsd > 0) ??
    rankedPairs[0];

  const sourceNotes: string[] = [];
  if (params.subgraphTokenFailed) {
    sourceNotes.push(
      params.subgraphTokenError
        ? `PulseX token entity unavailable (${params.subgraphTokenError}); identity/market fields may be partial`
        : "PulseX token entity unavailable; identity/market fields may be partial",
    );
  }
  if (params.pairsFailed) {
    sourceNotes.push(
      params.pairsError
        ? `PulseX pairs unavailable (${params.pairsError})`
        : "PulseX pairs unavailable",
    );
  }
  if (!hasToken && hasCatalog) {
    sourceNotes.push(
      "Catalog origin labels attached from known address; market metrics may be missing",
    );
  }
  if (hasToken || hasExplorer || hasV2) {
    // Prefer noting when top subgraph pool may differ from curated major pairs
    sourceNotes.push(
      "Pair list is quality-ranked (catalog rails, demote ghost/polluted reserves); " +
        "subgraph can still be wrong under hard caps — use addresses, not an oracle",
    );
  }

  const partial =
    params.subgraphTokenFailed === true ||
    params.pairsFailed === true ||
    (!hasToken && (hasCatalog || hasExplorer || hasV2));

  const explorerBase =
    params.explorerUiBase?.replace(/\/$/, "") ??
    "https://scan.pulsechain.com";

  const mappedPairs = rankedPairs.map((p) => {
    const t0 = tokenLabelFields(p.token0?.id ?? "");
    const t1 = tokenLabelFields(p.token1?.id ?? "");
    const t0Side = catalogPairSideLabels(p.token0?.id);
    const t1Side = catalogPairSideLabels(p.token1?.id);
    return {
      pair_address: p.id,
      token0_address: p.token0?.id,
      token0_symbol: p.token0?.symbol,
      ...(t0Side.display_symbol
        ? { token0_display_symbol: t0Side.display_symbol }
        : {}),
      ...(t0Side.origin ? { token0_origin: t0Side.origin } : {}),
      token1_address: p.token1?.id,
      token1_symbol: p.token1?.symbol,
      ...(t1Side.display_symbol
        ? { token1_display_symbol: t1Side.display_symbol }
        : {}),
      ...(t1Side.origin ? { token1_origin: t1Side.origin } : {}),
      // Ranking liquidity (0 when ghost); not invented
      liquidity_usd: p._saneLiquidityUsd,
      volume_usd_cumulative: num(p.volumeUSD),
      liquidity_polluted: p._liquidityPolluted,
      ...(p._ghostLiquidity ? { liquidity_ghost: true } : {}),
      ...(t0?.is_fork_dai || t1?.is_fork_dai
        ? {
            pair_warning:
              "Pair includes forked pDAI (state-fork, not bridged $1 DAI) — verify addresses",
          }
        : {}),
    };
  });

  const liqNoteParts: string[] = [];
  if (liqAgg.pollutedPairCount > 0) {
    liqNoteParts.push(
      `${liqAgg.pollutedPairCount} pair(s) had absurd/suspect or ghost reserveUSD and were demoted`,
    );
  }
  if (liqAgg.ghostPairCount > 0) {
    liqNoteParts.push(
      `${liqAgg.ghostPairCount} ghost pair(s) excluded from total_liquidity_usd (high reserve, negligible volume)`,
    );
  }
  if (liqAgg.excludedFromTotalCount > 0 && liqNoteParts.length === 0) {
    liqNoteParts.push(
      `${liqAgg.excludedFromTotalCount} pair(s) excluded from total_liquidity_usd`,
    );
  }

  const data: Record<string, unknown> = {
    address,
    name:
      token?.name ??
      params.v2Meta?.name ??
      (explorerObj.name as string | undefined) ??
      (typeof identity.identity_note === "string"
        ? String(identity.display_symbol ?? identity.identity_note)
        : null) ??
      null,
    symbol:
      token?.symbol ??
      params.v2Meta?.symbol ??
      (explorerObj.symbol as string | undefined) ??
      (typeof identity.display_symbol === "string"
        ? identity.display_symbol
        : null) ??
      null,
    decimals: num(
      token?.decimals ??
        params.v2Meta?.decimals ??
        (explorerObj.decimals as string | undefined),
      18,
    ),
    total_supply:
      token?.totalSupply ??
      params.v2Meta?.total_supply ??
      (explorerObj.totalSupply as string | undefined) ??
      null,
    total_liquidity_usd: totalLiquidityUsd,
    trade_volume_usd: hasToken ? num(token?.tradeVolumeUSD) : null,
    volume_proxy_note:
      "trade_volume_usd is cumulative all-time volume from PulseX subgraph",
    holder_count: params.v2Meta?.holders
      ? num(params.v2Meta.holders)
      : null,
    total_transactions: hasToken ? num(token?.totalTransactions) : null,
    price_usd: hasToken ? priceUsd : null,
    price_pls: hasToken ? num(token?.derivedPLS) : null,
    pairs: mappedPairs,
    links: {
      explorer: `${explorerBase}/token/${params.address}`,
      // Prefer quality-ranked pair for PulseX link (not raw subgraph[0])
      pulsex: preferredPair?.id
        ? `https://app.pulsex.com/#/info/v2/pairs/${preferredPair.id}`
        : "https://app.pulsex.com",
    },
    liquidity_note:
      liqNoteParts.length > 0 ? liqNoteParts.join("; ") : undefined,
    source: "PulseX subgraph + BlockScout",
    subgraph: params.version,
    partial,
    ...(sourceNotes.length > 0 ? { source_notes: sourceNotes } : {}),
    // Catalog identity last so it is never overwritten by market fields
    ...identity,
  };

  // Prefer catalog display_symbol over raw symbol when catalogued
  if (typeof identity.display_symbol === "string") {
    data.display_symbol = identity.display_symbol;
  }
  if (typeof identity.token_origin === "string") {
    data.token_origin = identity.token_origin;
  }

  return { found: true, data };
}

/**
 * Compact catalog labels for a single token address (top-tokens / swaps).
 * Never invents origin for unknowns. Pure.
 */
export function catalogTokenLabels(
  address: string | undefined | null,
): {
  display_symbol?: string;
  token_origin?: string;
} {
  if (!address || typeof address !== "string") return {};
  const fields = tokenLabelFields(address);
  if (!fields) return {};
  const out: { display_symbol?: string; token_origin?: string } = {};
  if (typeof fields.display_symbol === "string") {
    out.display_symbol = fields.display_symbol;
  }
  if (typeof fields.token_origin === "string") {
    out.token_origin = fields.token_origin;
  }
  return out;
}

/**
 * Label a raw subgraph top-token row. Additive display_symbol / token_origin only.
 * Pure / unit-testable.
 */
export function labelSubgraphTokenRow<
  T extends { id?: string; symbol?: string },
>(token: T): T & {
  display_symbol?: string;
  token_origin?: string;
} {
  const labels = catalogTokenLabels(token.id);
  return {
    ...token,
    ...(labels.display_symbol
      ? { display_symbol: labels.display_symbol }
      : {}),
    ...(labels.token_origin ? { token_origin: labels.token_origin } : {}),
  };
}

/**
 * Label a raw subgraph top-pair row (token0/token1 sides). Pure / unit-testable.
 */
export function labelSubgraphPairRow<
  T extends {
    id?: string;
    token0?: { id?: string; symbol?: string };
    token1?: { id?: string; symbol?: string };
  },
>(
  pair: T,
): T & {
  token0_display_symbol?: string;
  token0_origin?: string;
  token1_display_symbol?: string;
  token1_origin?: string;
  token0?: T["token0"] & {
    display_symbol?: string;
    token_origin?: string;
  };
  token1?: T["token1"] & {
    display_symbol?: string;
    token_origin?: string;
  };
} {
  const t0 = catalogPairSideLabels(pair.token0?.id);
  const t1 = catalogPairSideLabels(pair.token1?.id);
  const token0 = pair.token0
    ? {
        ...pair.token0,
        ...(t0.display_symbol
          ? { display_symbol: t0.display_symbol }
          : {}),
        ...(t0.origin ? { token_origin: t0.origin } : {}),
      }
    : pair.token0;
  const token1 = pair.token1
    ? {
        ...pair.token1,
        ...(t1.display_symbol
          ? { display_symbol: t1.display_symbol }
          : {}),
        ...(t1.origin ? { token_origin: t1.origin } : {}),
      }
    : pair.token1;
  return {
    ...pair,
    token0,
    token1,
    ...(t0.display_symbol
      ? { token0_display_symbol: t0.display_symbol }
      : {}),
    ...(t0.origin ? { token0_origin: t0.origin } : {}),
    ...(t1.display_symbol
      ? { token1_display_symbol: t1.display_symbol }
      : {}),
    ...(t1.origin ? { token1_origin: t1.origin } : {}),
  };
}

/**
 * Label a subgraph swap with pair-side origin/display fields.
 * Never invents labels for unknown token addresses. Pure / unit-testable.
 */
export function labelSubgraphSwapRow<
  T extends {
    pair?: {
      id?: string;
      token0?: { id?: string; symbol?: string };
      token1?: { id?: string; symbol?: string };
    };
  },
>(
  swap: T,
): T & {
  pair?: T["pair"] & {
    token0_display_symbol?: string;
    token0_origin?: string;
    token1_display_symbol?: string;
    token1_origin?: string;
    token0?: {
      id?: string;
      symbol?: string;
      display_symbol?: string;
      token_origin?: string;
    };
    token1?: {
      id?: string;
      symbol?: string;
      display_symbol?: string;
      token_origin?: string;
    };
  };
} {
  if (!swap.pair) return { ...swap };
  const labeled = labelSubgraphPairRow(swap.pair);
  return {
    ...swap,
    pair: labeled,
  };
}

/** Zero address used for renounced ownership checks. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Minimal Ownable owner() ABI for eth_call / multicall.
 */
export const OWNER_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

export const GET_OWNER_ABI = [
  {
    type: "function",
    name: "getOwner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;
