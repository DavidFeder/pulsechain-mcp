import type { DexScreenerPairSummary, SubgraphPair } from "../../../data/index.js";
import {
  mapPairsWithSaneLiquidity,
  rankPairsBySaneLiquidity,
  type LiquidityMappedPair,
} from "../helpers.js";
import {
  LIQUIDITY_CRITICAL_USD,
  LIQUIDITY_HIGH_RISK_USD,
  LIQUIDITY_MEDIUM_RISK_USD,
  MATERIAL_DISCREPANCY_PERCENT,
} from "./constants.js";
import { timestampToIso } from "./dates.js";
import { formatRawUnits, numberOrNull, round } from "./math.js";
import type { MetricPoint } from "./builder.js";

export function buildMarketSection(input: {
  fetchedAt: string;
  tokenDayTimestamp: string | null;
  subgraphPriceUsd: number | null;
  subgraphPricePls: number | null;
  primaryPairPriceUsd: number | null;
  primaryPairPriceNative: number | null;
  totalLiquidityUsd: number | null;
  primaryPairLiquidityUsd: number | null;
  tokenAggregateVolume24hUsd: number | null;
  primaryPairVolume24hUsd: number | null;
  tokenAggregatePriceChange24h: number | null;
  primaryPairPriceChange24h: number | null;
  subgraphMarketCap: number | null;
  dexScreenerMarketCap: number | null;
  dexScreenerFdv: number | null;
  primaryPair: Record<string, unknown> | null;
  dex: string | null;
}): Record<string, unknown> & { warnings: string[] } {
  const warnings = [
    discrepancyWarning(
      "priceUsd",
      input.subgraphPriceUsd,
      input.primaryPairPriceUsd,
      "PulseX token aggregate",
      "DexScreener primary pair",
    ),
    discrepancyWarning(
      "liquidityUsd",
      input.totalLiquidityUsd,
      input.primaryPairLiquidityUsd,
      "PulseX sanitized pair sum",
      "DexScreener primary pair",
    ),
    discrepancyWarning(
      "volume24hUsd",
      input.tokenAggregateVolume24hUsd,
      input.primaryPairVolume24hUsd,
      "PulseX tokenDayData aggregate",
      "DexScreener primary pair",
    ),
    discrepancyWarning(
      "priceChange24h",
      input.tokenAggregatePriceChange24h,
      input.primaryPairPriceChange24h,
      "PulseX tokenDayData aggregate",
      "DexScreener primary pair",
    ),
    discrepancyWarning(
      "marketCap",
      input.subgraphMarketCap,
      input.dexScreenerMarketCap,
      "contract supply x PulseX aggregate price",
      "DexScreener primary pair",
    ),
  ].filter((warning): warning is string => warning !== null);

  return {
    priceUsd: {
      aggregate: metricPoint(
        input.subgraphPriceUsd,
        "pulsex_subgraph.token.derivedUSD",
        input.fetchedAt,
      ),
      primaryPair: metricPoint(
        input.primaryPairPriceUsd,
        "dexscreener.primaryPair.priceUsd",
        input.fetchedAt,
      ),
    },
    pricePls: {
      aggregate: metricPoint(
        input.subgraphPricePls,
        "pulsex_subgraph.token.derivedPLS",
        input.fetchedAt,
      ),
      primaryPair: metricPoint(
        input.primaryPairPriceNative,
        "dexscreener.primaryPair.priceNative",
        input.fetchedAt,
        "DexScreener native price is primary-pair native quote context.",
      ),
    },
    liquidityUsd: {
      aggregate: metricPoint(
        input.totalLiquidityUsd,
        "pulsex_subgraph.sanitizedPairLiquiditySum",
        input.fetchedAt,
      ),
      primaryPair: metricPoint(
        input.primaryPairLiquidityUsd,
        "dexscreener.primaryPair.liquidity.usd",
        input.fetchedAt,
      ),
    },
    volume24hUsd: {
      aggregate: metricPoint(
        input.tokenAggregateVolume24hUsd,
        "pulsex_subgraph.tokenDayData.dailyVolumeUSD",
        input.tokenDayTimestamp,
      ),
      primaryPair: metricPoint(
        input.primaryPairVolume24hUsd,
        "dexscreener.primaryPair.volume.h24",
        input.fetchedAt,
      ),
    },
    priceChange24h: {
      aggregate: metricPoint(
        input.tokenAggregatePriceChange24h,
        "pulsex_subgraph.tokenDayData.priceUSD pctChange(today,yesterday)",
        input.tokenDayTimestamp,
      ),
      primaryPair: metricPoint(
        input.primaryPairPriceChange24h,
        "dexscreener.primaryPair.priceChange.h24",
        input.fetchedAt,
      ),
    },
    marketCap: {
      computedFromContractSupplyAndAggregatePrice: metricPoint(
        input.subgraphMarketCap,
        "contractTotalSupplyFormatted * pulsex_subgraph.token.derivedUSD",
        input.fetchedAt,
      ),
      primaryPairDexScreener: metricPoint(
        input.dexScreenerMarketCap,
        "dexscreener.primaryPair.marketCap",
        input.fetchedAt,
      ),
    },
    fdv: {
      computedFromMaximumSupply: metricPoint(
        null,
        "unavailable.maximumSupply_not_independently_documented",
        input.fetchedAt,
        "FDV is not computed from current totalSupply; maximumSupply is not inferred.",
      ),
      primaryPairDexScreener: metricPoint(
        input.dexScreenerFdv,
        "dexscreener.primaryPair.fdv",
        input.fetchedAt,
      ),
    },
    primaryPair: input.primaryPair,
    dex: input.dex,
    warnings,
  };
}

export function metricPoint(
  value: number | null,
  source: string,
  timestamp: string | null,
  note?: string,
): MetricPoint {
  return note ? { value, source, timestamp, note } : { value, source, timestamp };
}

export function discrepancyWarning(
  metric: string,
  left: number | null,
  right: number | null,
  leftLabel: string,
  rightLabel: string,
): string | null {
  if (left === null || right === null) return null;
  if (left === 0 && right === 0) return null;
  const denominator = Math.max(Math.abs(left), Math.abs(right));
  if (denominator === 0) return null;
  const diffPercent = (Math.abs(left - right) / denominator) * 100;
  if (diffPercent < MATERIAL_DISCREPANCY_PERCENT) return null;
  return `${metric} differs by ${round(diffPercent, 2)}% between ${leftLabel} (${left}) and ${rightLabel} (${right}).`;
}

export function assessLiquidityReliability(totalLiquidityUsd: number | null): {
  liquidityRiskLevel: "unknown" | "critical" | "high" | "medium" | "low";
  liquidityReliabilityWarning: string;
  thresholds: Record<string, string>;
} {
  const thresholds = {
    critical: `< $${LIQUIDITY_CRITICAL_USD}`,
    high: `$${LIQUIDITY_CRITICAL_USD} to < $${LIQUIDITY_HIGH_RISK_USD}`,
    medium: `$${LIQUIDITY_HIGH_RISK_USD} to < $${LIQUIDITY_MEDIUM_RISK_USD}`,
    low: `>= $${LIQUIDITY_MEDIUM_RISK_USD}`,
  };
  if (totalLiquidityUsd === null) {
    return {
      liquidityRiskLevel: "unknown",
      liquidityReliabilityWarning:
        "Liquidity unavailable; market price, volume, and FDV reliability cannot be assessed.",
      thresholds,
    };
  }
  if (totalLiquidityUsd < LIQUIDITY_CRITICAL_USD) {
    return {
      liquidityRiskLevel: "critical",
      liquidityReliabilityWarning:
        `Critical reliability: aggregate liquidity is below $${LIQUIDITY_CRITICAL_USD}; small trades can move price materially and market data may be fragile.`,
      thresholds,
    };
  }
  if (totalLiquidityUsd < LIQUIDITY_HIGH_RISK_USD) {
    return {
      liquidityRiskLevel: "high",
      liquidityReliabilityWarning:
        `High reliability risk: aggregate liquidity is below $${LIQUIDITY_HIGH_RISK_USD}.`,
      thresholds,
    };
  }
  if (totalLiquidityUsd < LIQUIDITY_MEDIUM_RISK_USD) {
    return {
      liquidityRiskLevel: "medium",
      liquidityReliabilityWarning:
        `Medium reliability risk: aggregate liquidity is below $${LIQUIDITY_MEDIUM_RISK_USD}.`,
      thresholds,
    };
  }
  return {
    liquidityRiskLevel: "low",
    liquidityReliabilityWarning:
      "Liquidity reliability risk is low by dashboard thresholds.",
    thresholds,
  };
}

export function mapDashboardPairs(
  pairs: SubgraphPair[],
  tokenAddress: string,
): Array<Record<string, unknown> & { liquidityUsd: number }> {
  const ranked = rankPairsBySaneLiquidity(pairs);
  const mappedById = new Map(
    mapPairsWithSaneLiquidity(ranked).map((p) => [p.pair_address.toLowerCase(), p]),
  );
  return ranked.map((pair) => {
    const mapped = mappedById.get(pair.id.toLowerCase()) ?? mapSinglePair(pair);
    return pairToDashboardRow(mapped, tokenAddress);
  });
}

export function mapSinglePair(pair: SubgraphPair): LiquidityMappedPair {
  return mapPairsWithSaneLiquidity([pair])[0]!;
}

export function pairToDashboardRow(
  pair: LiquidityMappedPair,
  tokenAddress: string,
): Record<string, unknown> & { liquidityUsd: number } {
  const tokenLower = tokenAddress.toLowerCase();
  const side =
    pair.token0_address?.toLowerCase() === tokenLower
      ? "token0"
      : pair.token1_address?.toLowerCase() === tokenLower
        ? "token1"
        : null;
  return {
    pairAddress: pair.pair_address,
    dex: "pulsex_v2",
    tokenSide: side,
    token0: {
      address: pair.token0_address ?? null,
      symbol: pair.token0_symbol ?? null,
      displaySymbol: pair.token0_display_symbol ?? null,
      origin: pair.token0_origin ?? null,
    },
    token1: {
      address: pair.token1_address ?? null,
      symbol: pair.token1_symbol ?? null,
      displaySymbol: pair.token1_display_symbol ?? null,
      origin: pair.token1_origin ?? null,
    },
    liquidityUsd: pair.liquidity_usd,
    rawReserveUsd: pair.raw_reserve_usd,
    liquidityPolluted: pair.liquidity_polluted,
    liquiditySource: pair.liquidity_source,
    volumeUsdCumulative: pair.volume_usd_cumulative,
    txCount: pair.tx_count,
    reserve0: pair.reserve0 ?? null,
    reserve1: pair.reserve1 ?? null,
  };
}

export function choosePrimaryDexPair(
  pairs: DexScreenerPairSummary[],
  tokenAddress: string,
): DexScreenerPairSummary | null {
  const token = tokenAddress.toLowerCase();
  const matching = pairs.filter((pair) => {
    const base = pair.baseToken.address.toLowerCase();
    const quote = pair.quoteToken.address.toLowerCase();
    return base === token || quote === token;
  });
  const ranked = (matching.length > 0 ? matching : pairs).sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
  );
  return ranked[0] ?? null;
}

export function buildPrimaryPair(
  dexPair: DexScreenerPairSummary | null,
  subgraphPair: (Record<string, unknown> & { liquidityUsd: number }) | null,
): Record<string, unknown> | null {
  if (dexPair) {
    return {
      source: "dexscreener",
      pairAddress: dexPair.pairAddress,
      url: dexPair.url,
      dex: dexPair.dexId,
      baseToken: dexPair.baseToken,
      quoteToken: dexPair.quoteToken,
      liquidityUsd: numberOrNull(dexPair.liquidity?.usd),
      priceUsd: numberOrNull(dexPair.priceUsd),
      priceNative: numberOrNull(dexPair.priceNative),
      volume24hUsd: numberOrNull(dexPair.volume?.h24),
      priceChange24h: numberOrNull(dexPair.priceChange?.h24),
      fdv: numberOrNull(dexPair.fdv),
      marketCap: numberOrNull(dexPair.marketCap),
      pairCreatedAt: timestampToIso(dexPair.pairCreatedAt),
    };
  }
  if (!subgraphPair) return null;
  return {
    source: "pulsex_subgraph",
    ...subgraphPair,
  };
}


export function computeMarketCap(
  totalSupply: string | null,
  decimals: number | null,
  priceUsd: number | null,
): number | null {
  if (!totalSupply || decimals === null || priceUsd === null || priceUsd < 0) {
    return null;
  }
  const supply = numberOrNull(formatRawUnits(totalSupply, decimals));
  if (supply === null) return null;
  return round(supply * priceUsd, 8);
}
