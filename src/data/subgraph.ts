import { GraphQLClient, gql } from "graphql-request";
import type { AppConfig, SubgraphVersion } from "../types.js";
import { SubgraphError, mapUnknownError } from "../utils/errors.js";
import { httpFetch } from "../utils/httpFetch.js";
import { assertAddress } from "../utils/safety.js";
import { resolvePairLiquidityUsd } from "../tools/analytics/helpers.js";

export function createSubgraphClient(
  url: string,
  timeoutMs = 30_000,
): GraphQLClient {
  return new GraphQLClient(url, {
    headers: { "content-type": "application/json" },
    // graphql-request still receives a Response; 429 retries stay in httpFetch.
    fetch: async (input, init) =>
      httpFetch(input, init, {
        timeoutMs,
        retry429: "query-post",
      }),
  });
}

export function getPulseXClient(
  config: AppConfig,
  version: SubgraphVersion = "v2",
): GraphQLClient {
  const url =
    version === "v1" ? config.pulseXSubgraphV1 : config.pulseXSubgraphV2;
  if (!url) {
    throw new SubgraphError(
      `PulseX subgraph ${version} URL is not configured (PULSEX_SUBGRAPH_${version.toUpperCase()})`,
    );
  }
  return createSubgraphClient(url, config.httpTimeoutMs);
}

async function requestSafe<T>(
  client: GraphQLClient,
  document: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  try {
    return await client.request<T>(document, variables);
  } catch (err) {
    throw mapUnknownError(err, "PulseX subgraph");
  }
}

// ---------------------------------------------------------------------------
// Queries — PulseX schema (derivedPLS/derivedUSD, totalTransactions, plsPrice)
// Both pulsex and pulsexv2 subgraphs use this schema (not vanilla Uniswap V2).
// ---------------------------------------------------------------------------

export const META_QUERY = gql`
  query Meta {
    _meta {
      block {
        number
      }
      hasIndexingErrors
    }
  }
`;

export const BUNDLE_QUERY = gql`
  query Bundle {
    bundle(id: "1") {
      id
      plsPrice
    }
  }
`;

export const FACTORIES_QUERY = gql`
  query Factories {
    pulseXFactories(first: 1) {
      id
      totalPairs
      totalTransactions
      totalVolumeUSD
      totalVolumePLS
      untrackedVolumeUSD
      totalLiquidityUSD
      totalLiquidityPLS
    }
  }
`;

export const TOKEN_QUERY = gql`
  query Token($id: ID!) {
    token(id: $id) {
      id
      symbol
      name
      decimals
      totalSupply
      tradeVolume
      tradeVolumeUSD
      untrackedVolumeUSD
      totalTransactions
      totalLiquidity
      derivedPLS
      derivedUSD
    }
  }
`;

export const PAIR_QUERY = gql`
  query Pair($id: ID!) {
    pair(id: $id) {
      id
      token0 {
        id
        symbol
        name
        decimals
        derivedUSD
        derivedPLS
      }
      token1 {
        id
        symbol
        name
        decimals
        derivedUSD
        derivedPLS
      }
      reserve0
      reserve1
      totalSupply
      reservePLS
      reserveUSD
      trackedReservePLS
      token0Price
      token1Price
      volumeToken0
      volumeToken1
      volumeUSD
      untrackedVolumeUSD
      totalTransactions
      timestamp
      block
    }
  }
`;

export const SWAPS_QUERY = gql`
  query Swaps($pair: String, $first: Int!, $skip: Int!) {
    swaps(
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
      where: { pair: $pair }
    ) {
      id
      timestamp
      pair {
        id
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      sender
      amount0In
      amount1In
      amount0Out
      amount1Out
      to
      amountUSD
      transaction {
        id
      }
    }
  }
`;

/**
 * Batch swaps across multiple pairs in one GraphQL round-trip.
 * Avoids sequential/parallel per-pair fan-out that times out on public subgraph.
 */
export const SWAPS_BY_PAIRS_QUERY = gql`
  query SwapsByPairs($pairs: [String!]!, $first: Int!, $skip: Int!) {
    swaps(
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
      where: { pair_in: $pairs }
    ) {
      id
      timestamp
      pair {
        id
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      sender
      amount0In
      amount1In
      amount0Out
      amount1Out
      to
      amountUSD
      transaction {
        id
      }
    }
  }
`;

export const SWAPS_GLOBAL_QUERY = gql`
  query SwapsGlobal($first: Int!, $skip: Int!) {
    swaps(first: $first, skip: $skip, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      pair {
        id
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      amount0In
      amount1In
      amount0Out
      amount1Out
      amountUSD
      transaction {
        id
      }
    }
  }
`;

export const TOKEN_DAY_DATA_QUERY = gql`
  query TokenDayData($token: String!, $first: Int!) {
    tokenDayDatas(
      first: $first
      orderBy: date
      orderDirection: desc
      where: { token: $token }
    ) {
      id
      date
      priceUSD
      totalLiquidityToken
      totalLiquidityUSD
      totalLiquidityPLS
      dailyVolumeToken
      dailyVolumePLS
      dailyVolumeUSD
      dailyTxns
    }
  }
`;

export const PAIR_DAY_DATA_QUERY = gql`
  query PairDayData($pairAddress: String!, $first: Int!) {
    pairDayDatas(
      first: $first
      orderBy: date
      orderDirection: desc
      where: { pairAddress: $pairAddress }
    ) {
      id
      date
      dailyVolumeToken0
      dailyVolumeToken1
      dailyVolumeUSD
      dailyTxns
      reserve0
      reserve1
      reserveUSD
      totalSupply
    }
  }
`;

export const PULSEX_DAY_DATA_QUERY = gql`
  query PulsexDayData($first: Int!) {
    pulsexDayDatas(first: $first, orderBy: date, orderDirection: desc) {
      id
      date
      dailyVolumePLS
      dailyVolumeUSD
      dailyVolumeUntracked
      totalVolumePLS
      totalLiquidityPLS
      totalVolumeUSD
      totalLiquidityUSD
      totalTransactions
    }
  }
`;

export const TOP_TOKENS_QUERY = gql`
  query TopTokens($first: Int!, $orderBy: String!) {
    tokens(
      first: $first
      orderBy: $orderBy
      orderDirection: desc
      where: { totalLiquidity_gt: "0" }
    ) {
      id
      symbol
      name
      decimals
      tradeVolumeUSD
      totalLiquidity
      totalTransactions
      derivedPLS
      derivedUSD
    }
  }
`;

export const TOP_PAIRS_QUERY = gql`
  query TopPairs($first: Int!, $orderBy: String!) {
    pairs(
      first: $first
      orderBy: $orderBy
      orderDirection: desc
      where: { reserveUSD_gt: "100", volumeUSD_gt: "100" }
    ) {
      id
      token0 {
        id
        symbol
        name
        decimals
        derivedUSD
      }
      token1 {
        id
        symbol
        name
        decimals
        derivedUSD
      }
      reserveUSD
      volumeUSD
      totalTransactions
      token0Price
      token1Price
      reserve0
      reserve1
      reservePLS
    }
  }
`;

/** Pairs where token is token0 or token1 (two queries merged client-side). */
export const PAIRS_FOR_TOKEN0_QUERY = gql`
  query PairsToken0($token: String!, $first: Int!) {
    pairs(
      first: $first
      orderBy: reserveUSD
      orderDirection: desc
      where: { token0: $token, reserveUSD_gt: "0" }
    ) {
      id
      token0 {
        id
        symbol
        name
        decimals
        derivedUSD
      }
      token1 {
        id
        symbol
        name
        decimals
        derivedUSD
      }
      reserve0
      reserve1
      reserveUSD
      reservePLS
      volumeUSD
      totalTransactions
      token0Price
      token1Price
    }
  }
`;

export const PAIRS_FOR_TOKEN1_QUERY = gql`
  query PairsToken1($token: String!, $first: Int!) {
    pairs(
      first: $first
      orderBy: reserveUSD
      orderDirection: desc
      where: { token1: $token, reserveUSD_gt: "0" }
    ) {
      id
      token0 {
        id
        symbol
        name
        decimals
        derivedUSD
      }
      token1 {
        id
        symbol
        name
        decimals
        derivedUSD
      }
      reserve0
      reserve1
      reserveUSD
      reservePLS
      volumeUSD
      totalTransactions
      token0Price
      token1Price
    }
  }
`;

// ---------------------------------------------------------------------------
// High-level helpers
// ---------------------------------------------------------------------------

export async function fetchSubgraphMeta(
  config: AppConfig,
  version: SubgraphVersion = "v2",
): Promise<unknown> {
  const client = getPulseXClient(config, version);
  return requestSafe(client, META_QUERY);
}

export async function fetchBundle(
  config: AppConfig,
  version: SubgraphVersion = "v2",
): Promise<{ bundle: { id: string; plsPrice: string } | null }> {
  const client = getPulseXClient(config, version);
  return requestSafe(client, BUNDLE_QUERY);
}

export async function fetchFactories(
  config: AppConfig,
  version: SubgraphVersion = "v2",
): Promise<{
  pulseXFactories: Array<{
    id: string;
    totalPairs: string;
    totalTransactions: string;
    totalVolumeUSD: string;
    totalVolumePLS: string;
    untrackedVolumeUSD: string;
    totalLiquidityUSD: string;
    totalLiquidityPLS: string;
  }>;
}> {
  const client = getPulseXClient(config, version);
  return requestSafe(client, FACTORIES_QUERY);
}

export async function fetchToken(
  config: AppConfig,
  tokenAddress: string,
  version: SubgraphVersion = "v2",
): Promise<{
  token: {
    id: string;
    symbol: string;
    name: string;
    decimals: string;
    totalSupply: string;
    tradeVolume: string;
    tradeVolumeUSD: string;
    untrackedVolumeUSD: string;
    totalTransactions: string;
    totalLiquidity: string;
    derivedPLS: string;
    derivedUSD: string;
  } | null;
}> {
  const id = assertAddress(tokenAddress).toLowerCase();
  const client = getPulseXClient(config, version);
  return requestSafe(client, TOKEN_QUERY, { id });
}

export async function fetchPair(
  config: AppConfig,
  pairAddress: string,
  version: SubgraphVersion = "v2",
): Promise<unknown> {
  const id = assertAddress(pairAddress).toLowerCase();
  const client = getPulseXClient(config, version);
  return requestSafe(client, PAIR_QUERY, { id });
}

export async function fetchSwaps(
  config: AppConfig,
  options: {
    pair?: string;
    first?: number;
    skip?: number;
    version?: SubgraphVersion;
  } = {},
): Promise<unknown> {
  const first = Math.min(options.first ?? 20, 100);
  const skip = options.skip ?? 0;
  const version = options.version ?? "v2";
  const client = getPulseXClient(config, version);

  if (options.pair) {
    const pair = assertAddress(options.pair).toLowerCase();
    return requestSafe(client, SWAPS_QUERY, { pair, first, skip });
  }
  return requestSafe(client, SWAPS_GLOBAL_QUERY, { first, skip });
}

export async function fetchTokenDayData(
  config: AppConfig,
  tokenAddress: string,
  first = 30,
  version: SubgraphVersion = "v2",
): Promise<{
  tokenDayDatas: Array<{
    id: string;
    date: number;
    priceUSD: string;
    totalLiquidityToken: string;
    totalLiquidityUSD: string;
    totalLiquidityPLS: string;
    dailyVolumeToken: string;
    dailyVolumePLS: string;
    dailyVolumeUSD: string;
    dailyTxns: string;
  }>;
}> {
  const token = assertAddress(tokenAddress).toLowerCase();
  const client = getPulseXClient(config, version);
  return requestSafe(client, TOKEN_DAY_DATA_QUERY, {
    token,
    first: Math.min(first, 90),
  });
}

export async function fetchPairDayData(
  config: AppConfig,
  pairAddress: string,
  first = 30,
  version: SubgraphVersion = "v2",
): Promise<unknown> {
  const pairAddressNorm = assertAddress(pairAddress).toLowerCase();
  const client = getPulseXClient(config, version);
  return requestSafe(client, PAIR_DAY_DATA_QUERY, {
    pairAddress: pairAddressNorm,
    first: Math.min(first, 90),
  });
}

export async function fetchPulsexDayData(
  config: AppConfig,
  first = 14,
  version: SubgraphVersion = "v2",
): Promise<{
  pulsexDayDatas: Array<{
    id: string;
    date: number;
    dailyVolumeUSD: string;
    dailyVolumePLS: string;
    totalLiquidityUSD: string;
    totalLiquidityPLS: string;
    totalVolumeUSD: string;
    totalTransactions: string;
  }>;
}> {
  const client = getPulseXClient(config, version);
  return requestSafe(client, PULSEX_DAY_DATA_QUERY, {
    first: Math.min(first, 90),
  });
}

export async function fetchTopTokens(
  config: AppConfig,
  options: {
    first?: number;
    orderBy?: "tradeVolumeUSD" | "totalLiquidity" | "totalTransactions";
    version?: SubgraphVersion;
  } = {},
): Promise<{
  tokens: Array<{
    id: string;
    symbol: string;
    name: string;
    decimals: string;
    tradeVolumeUSD: string;
    totalLiquidity: string;
    totalTransactions: string;
    derivedPLS: string;
    derivedUSD: string;
  }>;
}> {
  const client = getPulseXClient(config, options.version ?? "v2");
  return requestSafe(client, TOP_TOKENS_QUERY, {
    first: Math.min(options.first ?? 20, 100),
    orderBy: options.orderBy ?? "tradeVolumeUSD",
  });
}

export async function fetchTopPairs(
  config: AppConfig,
  options: {
    first?: number;
    orderBy?: "volumeUSD" | "reserveUSD" | "totalTransactions";
    version?: SubgraphVersion;
  } = {},
): Promise<{
  pairs: Array<{
    id: string;
    token0: {
      id: string;
      symbol: string;
      name?: string;
      decimals?: string;
      derivedUSD?: string;
    };
    token1: {
      id: string;
      symbol: string;
      name?: string;
      decimals?: string;
      derivedUSD?: string;
    };
    reserveUSD: string;
    volumeUSD: string;
    totalTransactions: string;
    token0Price: string;
    token1Price: string;
    reserve0: string;
    reserve1: string;
    reservePLS?: string;
  }>;
}> {
  const client = getPulseXClient(config, options.version ?? "v2");
  return requestSafe(client, TOP_PAIRS_QUERY, {
    first: Math.min(options.first ?? 20, 100),
    orderBy: options.orderBy ?? "volumeUSD",
  });
}

export type SubgraphPair = {
  id: string;
  token0: {
    id: string;
    symbol: string;
    name?: string;
    decimals?: string;
    derivedUSD?: string;
  };
  token1: {
    id: string;
    symbol: string;
    name?: string;
    decimals?: string;
    derivedUSD?: string;
  };
  reserve0: string;
  reserve1: string;
  reserveUSD: string;
  reservePLS?: string;
  volumeUSD: string;
  totalTransactions: string;
  token0Price: string;
  token1Price: string;
};

/**
 * Fetch pairs involving a token (as token0 or token1), merged & sorted by
 * **sanitized** liquidity (demotes absurd reserveUSD so polluted pairs cannot
 * crowd out real pools for swap discovery / top-pair selection).
 */
export async function fetchPairsForToken(
  config: AppConfig,
  tokenAddress: string,
  first = 20,
  version: SubgraphVersion = "v2",
): Promise<SubgraphPair[]> {
  const token = assertAddress(tokenAddress).toLowerCase();
  const client = getPulseXClient(config, version);
  const half = Math.min(Math.max(first, 5), 50);

  const [as0, as1] = await Promise.all([
    requestSafe<{ pairs: SubgraphPair[] }>(client, PAIRS_FOR_TOKEN0_QUERY, {
      token,
      first: half,
    }),
    requestSafe<{ pairs: SubgraphPair[] }>(client, PAIRS_FOR_TOKEN1_QUERY, {
      token,
      first: half,
    }),
  ]);

  const byId = new Map<string, SubgraphPair>();
  for (const p of [...(as0.pairs ?? []), ...(as1.pairs ?? [])]) {
    byId.set(p.id, p);
  }
  // Rank by sane liquidity (not raw parseFloat(reserveUSD)) so absurd outliers
  // sink below real pools used for swap pair-id selection.
  return [...byId.values()]
    .sort(
      (a, b) =>
        resolvePairLiquidityUsd(b).liquidityUsd -
        resolvePairLiquidityUsd(a).liquidityUsd,
    )
    .slice(0, first);
}

/**
 * Pure ranking of token pairs by sanitized liquidity (for unit tests + offline reuse).
 * Same comparator as {@link fetchPairsForToken}.
 */
export function rankSubgraphPairsBySaneLiquidity(
  pairs: SubgraphPair[],
  first?: number,
): SubgraphPair[] {
  const ranked = [...pairs].sort(
    (a, b) =>
      resolvePairLiquidityUsd(b).liquidityUsd -
      resolvePairLiquidityUsd(a).liquidityUsd,
  );
  return first === undefined ? ranked : ranked.slice(0, first);
}

// ---------------------------------------------------------------------------
// Advanced analytics queries (public PulseX subgraph only)
// ---------------------------------------------------------------------------

export const SWAPS_MIN_USD_QUERY = gql`
  query SwapsMinUsd($minUsd: BigDecimal!, $first: Int!, $skip: Int!) {
    swaps(
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
      where: { amountUSD_gt: $minUsd }
    ) {
      id
      timestamp
      sender
      to
      amount0In
      amount1In
      amount0Out
      amount1Out
      amountUSD
      pair {
        id
        reserveUSD
        token0 {
          id
          symbol
          name
        }
        token1 {
          id
          symbol
          name
        }
      }
      transaction {
        id
      }
    }
  }
`;

export const SWAPS_BY_WALLET_QUERY = gql`
  query SwapsByWallet($wallet: Bytes!, $first: Int!, $skip: Int!) {
    asSender: swaps(
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
      where: { sender: $wallet }
    ) {
      id
      timestamp
      sender
      to
      amount0In
      amount1In
      amount0Out
      amount1Out
      amountUSD
      pair {
        id
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      transaction {
        id
      }
    }
    asTo: swaps(
      first: $first
      skip: $skip
      orderBy: timestamp
      orderDirection: desc
      where: { to: $wallet }
    ) {
      id
      timestamp
      sender
      to
      amount0In
      amount1In
      amount0Out
      amount1Out
      amountUSD
      pair {
        id
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      transaction {
        id
      }
    }
  }
`;

/** PulseX pairs use `timestamp` (not createdAtTimestamp). */
export const RECENT_PAIRS_QUERY = gql`
  query RecentPairs($first: Int!, $minReserveUsd: BigDecimal!) {
    pairs(
      first: $first
      orderBy: timestamp
      orderDirection: desc
      where: { reserveUSD_gt: $minReserveUsd }
    ) {
      id
      timestamp
      block
      reserveUSD
      volumeUSD
      totalTransactions
      reserve0
      reserve1
      totalSupply
      token0 {
        id
        symbol
        name
        totalTransactions
        totalLiquidity
      }
      token1 {
        id
        symbol
        name
        totalTransactions
        totalLiquidity
      }
    }
  }
`;

export const RECENT_BURNS_QUERY = gql`
  query RecentBurns($first: Int!, $minLiquidity: BigDecimal!) {
    burns(
      first: $first
      orderBy: timestamp
      orderDirection: desc
      where: { amountUSD_gt: $minLiquidity }
    ) {
      id
      timestamp
      amount0
      amount1
      amountUSD
      liquidity
      to
      sender
      pair {
        id
        reserveUSD
        totalSupply
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      transaction {
        id
      }
    }
  }
`;

export interface SubgraphSwap {
  id: string;
  timestamp: string;
  sender?: string;
  to?: string;
  amount0In?: string;
  amount1In?: string;
  amount0Out?: string;
  amount1Out?: string;
  amountUSD?: string;
  pair?: {
    id: string;
    reserveUSD?: string;
    token0?: { id?: string; symbol?: string; name?: string };
    token1?: { id?: string; symbol?: string; name?: string };
  };
  transaction?: { id: string };
}

export async function fetchLargeSwaps(
  config: AppConfig,
  options: {
    minUsd?: number;
    first?: number;
    skip?: number;
    version?: SubgraphVersion;
  } = {},
): Promise<{ swaps: SubgraphSwap[] }> {
  const client = getPulseXClient(config, options.version ?? "v2");
  const minUsd = String(options.minUsd ?? 10_000);
  return requestSafe<{ swaps: SubgraphSwap[] }>(client, SWAPS_MIN_USD_QUERY, {
    minUsd,
    first: Math.min(options.first ?? 25, 100),
    skip: options.skip ?? 0,
  });
}

export async function fetchWalletSwaps(
  config: AppConfig,
  walletAddress: string,
  options: {
    first?: number;
    skip?: number;
    version?: SubgraphVersion;
  } = {},
): Promise<{
  swaps: SubgraphSwap[];
  method: string;
  incomplete: boolean;
  coverage: SwapPageCoverage;
}> {
  const wallet = assertAddress(walletAddress).toLowerCase();
  const client = getPulseXClient(config, options.version ?? "v2");
  const first = Math.min(options.first ?? 25, 100);
  const skip = Math.max(0, options.skip ?? 0);
  // Small pages: fetch skip+first from tip (skip 0), merge, then slice — correct
  // across sender/to feeds. Deep pages exceed the 100-row GraphQL cap, so pass
  // skip to each feed (approximate merged page, same as pre-fix deep behavior).
  const deep = skip + first > 100;
  const fetchCount = deep ? first : Math.min(skip + first, 100);
  const gqlSkip = deep ? skip : 0;
  const page = swapPageFlags({ skip, first, deep });

  const data = await requestSafe<{
    asSender: SubgraphSwap[];
    asTo: SubgraphSwap[];
  }>(client, SWAPS_BY_WALLET_QUERY, {
    wallet,
    first: fetchCount,
    skip: gqlSkip,
  });

  const byId = new Map<string, SubgraphSwap>();
  for (const s of [...(data.asSender ?? []), ...(data.asTo ?? [])]) {
    byId.set(s.id, s);
  }
  const swaps = [...byId.values()].sort(
    (a, b) => Number(b.timestamp) - Number(a.timestamp),
  );
  return {
    swaps: deep ? swaps.slice(0, first) : swaps.slice(skip, skip + first),
    method: deep
      ? "subgraph swaps where sender or to equals wallet (deep skip uses per-feed skip; merged page is approximate)"
      : "subgraph swaps where sender or to equals wallet",
    incomplete: page.incomplete,
    coverage: page.coverage,
  };
}

export async function fetchRecentPairs(
  config: AppConfig,
  options: {
    first?: number;
    minReserveUsd?: number;
    version?: SubgraphVersion;
  } = {},
): Promise<{ pairs: unknown[] }> {
  const client = getPulseXClient(config, options.version ?? "v2");
  return requestSafe<{ pairs: unknown[] }>(client, RECENT_PAIRS_QUERY, {
    first: Math.min(options.first ?? 30, 100),
    minReserveUsd: String(options.minReserveUsd ?? 0),
  });
}

export async function fetchRecentBurns(
  config: AppConfig,
  options: {
    first?: number;
    minLiquidityUsd?: number;
    version?: SubgraphVersion;
  } = {},
): Promise<{ burns: unknown[] }> {
  const client = getPulseXClient(config, options.version ?? "v2");
  return requestSafe<{ burns: unknown[] }>(client, RECENT_BURNS_QUERY, {
    first: Math.min(options.first ?? 30, 100),
    minLiquidity: String(options.minLiquidityUsd ?? 100),
  });
}

// ---------------------------------------------------------------------------
// Tier B — dedicated factory / DEX day / LP mint-burn (soft-fail wrappers)
// ---------------------------------------------------------------------------

/** Recent LP mints (global, optional min USD). */
export const LP_MINTS_GLOBAL_QUERY = gql`
  query LpMintsGlobal($first: Int!, $minUsd: BigDecimal!) {
    mints(
      first: $first
      orderBy: timestamp
      orderDirection: desc
      where: { amountUSD_gt: $minUsd }
    ) {
      id
      timestamp
      amount0
      amount1
      amountUSD
      liquidity
      to
      sender
      pair {
        id
        reserveUSD
        totalSupply
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      transaction {
        id
      }
    }
  }
`;

/** Recent LP burns (global, optional min USD). */
export const LP_BURNS_GLOBAL_QUERY = gql`
  query LpBurnsGlobal($first: Int!, $minUsd: BigDecimal!) {
    burns(
      first: $first
      orderBy: timestamp
      orderDirection: desc
      where: { amountUSD_gt: $minUsd }
    ) {
      id
      timestamp
      amount0
      amount1
      amountUSD
      liquidity
      to
      sender
      pair {
        id
        reserveUSD
        totalSupply
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      transaction {
        id
      }
    }
  }
`;

/** Pair-scoped LP mints. */
export const LP_MINTS_BY_PAIR_QUERY = gql`
  query LpMintsByPair($pair: String!, $first: Int!) {
    mints(
      first: $first
      orderBy: timestamp
      orderDirection: desc
      where: { pair: $pair }
    ) {
      id
      timestamp
      amount0
      amount1
      amountUSD
      liquidity
      to
      sender
      pair {
        id
        reserveUSD
        totalSupply
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      transaction {
        id
      }
    }
  }
`;

/** Pair-scoped LP burns. */
export const LP_BURNS_BY_PAIR_QUERY = gql`
  query LpBurnsByPair($pair: String!, $first: Int!) {
    burns(
      first: $first
      orderBy: timestamp
      orderDirection: desc
      where: { pair: $pair }
    ) {
      id
      timestamp
      amount0
      amount1
      amountUSD
      liquidity
      to
      sender
      pair {
        id
        reserveUSD
        totalSupply
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      transaction {
        id
      }
    }
  }
`;

export type PulseXSoftFail = {
  ok: false;
  source: "pulsex-subgraph";
  subgraph: SubgraphVersion;
  reason: string;
  path?: string;
};

export type PulseXSoftSuccess<T> = {
  ok: true;
  source: "pulsex-subgraph";
  subgraph: SubgraphVersion;
  data: T;
};

export type PulseXSoftResult<T> = PulseXSoftSuccess<T> | PulseXSoftFail;

export interface LpEventRow {
  kind: "mint" | "burn";
  id: string;
  timestamp: string;
  amount0?: string;
  amount1?: string;
  amountUSD?: string;
  liquidity?: string;
  to?: string;
  sender?: string;
  pair?: {
    id: string;
    reserveUSD?: string;
    totalSupply?: string;
    token0?: { id?: string; symbol?: string };
    token1?: { id?: string; symbol?: string };
  };
  transaction?: { id?: string };
}

/**
 * Soft-fail PulseX factory metrics (total pairs, liquidity, volume, txs).
 * Gaps vs get_market_overview: dedicated surface without day/gainers fan-out.
 */
export async function getFactoryMetricsSoft(
  config: AppConfig,
  version: SubgraphVersion = "v2",
): Promise<
  PulseXSoftResult<{
    factory: Record<string, unknown> | null;
    note: string;
  }>
> {
  try {
    const raw = await fetchFactories(config, version);
    const factory = (raw.pulseXFactories?.[0] as Record<string, unknown>) ?? null;
    return {
      ok: true,
      source: "pulsex-subgraph",
      subgraph: version,
      data: {
        factory,
        note:
          "PulseX pulseXFactories aggregate. TVL/volume are subgraph-derived " +
          "(not consensus). Prefer get_market_overview for day series + PLS price.",
      },
    };
  } catch (e) {
    return {
      ok: false,
      source: "pulsex-subgraph",
      subgraph: version,
      reason: e instanceof Error ? e.message : String(e),
      path: "pulseXFactories",
    };
  }
}

/**
 * Soft-fail DEX-level day history (pulsexDayDatas).
 * Richer dedicated history than the 8-day sample inside get_market_overview.
 */
export async function getDexDayDataSoft(
  config: AppConfig,
  first = 30,
  version: SubgraphVersion = "v2",
): Promise<
  PulseXSoftResult<{
    days: Array<Record<string, unknown>>;
    count: number;
    note: string;
  }>
> {
  try {
    const raw = await fetchPulsexDayData(config, first, version);
    const days = (raw.pulsexDayDatas ?? []) as Array<Record<string, unknown>>;
    return {
      ok: true,
      source: "pulsex-subgraph",
      subgraph: version,
      data: {
        days,
        count: days.length,
        note:
          "PulseX pulsexDayDatas (protocol-level). dailyVolumeUSD / totalLiquidityUSD " +
          "are subgraph estimates. Token/pair day series: pulsex_token_day_data / pulsex_pair_day_data.",
      },
    };
  } catch (e) {
    return {
      ok: false,
      source: "pulsex-subgraph",
      subgraph: version,
      reason: e instanceof Error ? e.message : String(e),
      path: "pulsexDayDatas",
    };
  }
}

/**
 * Soft-fail LP mint/burn events (optional pair filter).
 * No per-wallet LP position indexer — pair totalSupply + events only.
 */
export async function getLpEventsSoft(
  config: AppConfig,
  options: {
    pair?: string;
    first?: number;
    minUsd?: number;
    version?: SubgraphVersion;
    /** Include mints (default true). */
    includeMints?: boolean;
    /** Include burns (default true). */
    includeBurns?: boolean;
  } = {},
): Promise<
  PulseXSoftResult<{
    events: LpEventRow[];
    mintCount: number;
    burnCount: number;
    pair: string | null;
    note: string;
  }>
> {
  const version = options.version ?? "v2";
  const first = Math.min(Math.max(options.first ?? 20, 1), 50);
  const minUsd = String(options.minUsd ?? 0);
  const includeMints = options.includeMints !== false;
  const includeBurns = options.includeBurns !== false;

  try {
    const client = getPulseXClient(config, version);
    let pair: string | undefined;
    if (options.pair) {
      pair = assertAddress(options.pair).toLowerCase();
    }

    const tasks: Array<Promise<{ mints?: unknown[]; burns?: unknown[] }>> = [];
    if (includeMints) {
      tasks.push(
        pair
          ? requestSafe(client, LP_MINTS_BY_PAIR_QUERY, { pair, first })
          : requestSafe(client, LP_MINTS_GLOBAL_QUERY, { first, minUsd }),
      );
    }
    if (includeBurns) {
      tasks.push(
        pair
          ? requestSafe(client, LP_BURNS_BY_PAIR_QUERY, { pair, first })
          : requestSafe(client, LP_BURNS_GLOBAL_QUERY, { first, minUsd }),
      );
    }

    const results = await Promise.all(tasks);
    const events: LpEventRow[] = [];
    let mintCount = 0;
    let burnCount = 0;

    for (const r of results) {
      for (const m of r.mints ?? []) {
        mintCount += 1;
        events.push({ kind: "mint", ...(m as object) } as LpEventRow);
      }
      for (const b of r.burns ?? []) {
        burnCount += 1;
        events.push({ kind: "burn", ...(b as object) } as LpEventRow);
      }
    }

    events.sort(
      (a, b) => Number(b.timestamp ?? 0) - Number(a.timestamp ?? 0),
    );

    return {
      ok: true,
      source: "pulsex-subgraph",
      subgraph: version,
      data: {
        events: events.slice(0, first * 2),
        mintCount,
        burnCount,
        pair: pair ?? null,
        note:
          "PulseX LP mint/burn events (not full position accounting). " +
          "No wallet LP-share indexer on public subgraph — pair totalSupply is on the pair entity. " +
          "amountUSD may be noisy for junk pairs.",
      },
    };
  } catch (e) {
    return {
      ok: false,
      source: "pulsex-subgraph",
      subgraph: version,
      reason: e instanceof Error ? e.message : String(e),
      path: "mints+burns",
    };
  }
}

/**
 * True when a swap involves the given token.
 *
 * Match order (any one is enough):
 * 1. pair.token0.id / pair.token1.id equals the token (preferred when GraphQL
 *    selects token ids — SWAPS_QUERY / SWAPS_MIN_USD_QUERY do after v0.1.21)
 * 2. pair.id is in `allowedPairIds` — critical when swaps were fetched only from
 *    pre-verified pairs for that token. Older SWAPS_QUERY selected only
 *    token0/1.symbol (no id); relying on ids alone dropped every live row.
 *
 * Pure / unit-testable.
 */
export function swapInvolvesToken(
  swap: SubgraphSwap,
  tokenAddress: string,
  allowedPairIds?: ReadonlySet<string> | readonly string[],
): boolean {
  const t = tokenAddress.toLowerCase();
  const t0 = swap.pair?.token0?.id?.toLowerCase();
  const t1 = swap.pair?.token1?.id?.toLowerCase();
  if (t0 === t || t1 === t) return true;

  if (allowedPairIds && swap.pair?.id) {
    const pairId = swap.pair.id.toLowerCase();
    const ids: string[] = Array.isArray(allowedPairIds)
      ? [...allowedPairIds]
      : [...(allowedPairIds as ReadonlySet<string>)];
    return ids.some((id) => id.toLowerCase() === pairId);
  }

  return false;
}

/**
 * Post-filter swaps to those involving `token`.
 * Pass `allowedPairIds` when rows come from pre-verified token pairs so
 * symbol-only GraphQL shapes (no token0/1.id) are not dropped.
 * Pure / unit-testable.
 */
export function filterSwapsByToken(
  swaps: SubgraphSwap[],
  tokenAddress: string,
  allowedPairIds?: ReadonlySet<string> | readonly string[],
): SubgraphSwap[] {
  return swaps.filter((s) =>
    swapInvolvesToken(s, tokenAddress, allowedPairIds),
  );
}

/**
 * Max verified pairs for token-filtered swaps (batch pair_in query).
 * Cap keeps the GraphQL `where: { pair_in }` list small and fast.
 */
export const MAX_TOKEN_SWAP_PAIR_QUERIES = 6;

/** Machine-readable swap-page coverage (not a pagination protocol). */
export interface SwapPageCoverage {
  skip: number;
  first: number;
  deep: boolean;
  pairCapHit?: boolean;
}

/**
 * Flags for capped / approximate subgraph swap pages.
 * `incomplete` is true when the merged page is deep (`skip + first > 100`)
 * or token-filtered pair fan-out hit {@link MAX_TOKEN_SWAP_PAIR_QUERIES}.
 */
export function swapPageFlags(input: {
  skip: number;
  first: number;
  deep: boolean;
  pairCapHit?: boolean;
}): { incomplete: boolean; coverage: SwapPageCoverage } {
  const coverage: SwapPageCoverage = {
    skip: input.skip,
    first: input.first,
    deep: input.deep,
  };
  if (input.pairCapHit !== undefined) {
    coverage.pairCapHit = input.pairCapHit;
  }
  return {
    incomplete: input.deep || input.pairCapHit === true,
    coverage,
  };
}

type TokenSwapPairInput = {
  id: string;
  volumeUSD?: string | number;
  reserveUSD?: string | number;
  reserve0?: string | number;
  reserve1?: string | number;
  token0?: { id?: string; derivedUSD?: string | number };
  token1?: { id?: string; derivedUSD?: string | number };
};

/**
 * Eligible verified pair ids for token-filtered swap discovery, uncapped.
 * Prefer this when detecting {@link MAX_TOKEN_SWAP_PAIR_QUERIES} fan-out.
 */
export function eligibleTokenSwapPairIds(
  pairs: TokenSwapPairInput[],
  tokenAddress: string,
): string[] {
  const token = tokenAddress.toLowerCase();
  const verified = pairs.filter(
    (p) =>
      p.token0?.id?.toLowerCase() === token ||
      p.token1?.id?.toLowerCase() === token,
  );
  return verified
    .map((p) => ({
      id: p.id,
      liq: resolvePairLiquidityUsd(p).liquidityUsd,
      vol: Number(p.volumeUSD ?? 0) || 0,
    }))
    .filter((p) => p.liq > 0 || p.vol > 0)
    .sort((a, b) => b.vol - a.vol || b.liq - a.liq)
    .map((p) => p.id);
}

/**
 * Pure: pick verified pair ids for token-filtered swap discovery.
 * Prefers high volume among pairs with positive sanitized liquidity so dead
 * high-reserve pollution does not starve the major trading pools.
 */
export function selectTokenSwapPairIds(
  pairs: TokenSwapPairInput[],
  tokenAddress: string,
  maxPairs = MAX_TOKEN_SWAP_PAIR_QUERIES,
): string[] {
  return eligibleTokenSwapPairIds(pairs, tokenAddress).slice(
    0,
    Math.max(1, maxPairs),
  );
}

/**
 * Pure: merge parallel pair-swap query results, strict-filter, sort, slice.
 * Used by fetchSwapsAdvanced so unit tests drive the same post-processing path.
 */
export function mergeTokenFilteredSwaps(options: {
  results: Array<{ pairId: string; swaps: SubgraphSwap[]; error?: string }>;
  tokenFilter: string;
  first: number;
  skip?: number;
  minUsd?: number;
}): {
  swaps: SubgraphSwap[];
  pairsUsed: string[];
  pairsFailed: string[];
  droppedUnrelated: number;
  partial: boolean;
} {
  const pairIds = options.results.map((r) => r.pairId);
  const pairsFailed = options.results
    .filter((r) => r.error)
    .map((r) => r.pairId);
  const all: SubgraphSwap[] = [];
  for (const r of options.results) {
    if (!r.error) all.push(...(r.swaps ?? []));
  }
  const pairIdSet = new Set(pairIds.map((id) => id.toLowerCase()));
  let swaps = filterSwapsByToken(all, options.tokenFilter, pairIdSet).sort(
    (a, b) => Number(b.timestamp) - Number(a.timestamp),
  );
  if (options.minUsd !== undefined && options.minUsd > 0) {
    const min = options.minUsd;
    swaps = swaps.filter((s) => Number(s.amountUSD ?? 0) >= min);
  }
  const matched = filterSwapsByToken(all, options.tokenFilter, pairIdSet).length;
  const skip = Math.max(0, options.skip ?? 0);
  return {
    swaps: swaps.slice(skip, skip + options.first),
    pairsUsed: pairIds,
    pairsFailed,
    droppedUnrelated: all.length - matched,
    partial: pairsFailed.length > 0,
  };
}

export async function fetchSwapsAdvanced(
  config: AppConfig,
  options: {
    pair?: string;
    token?: string;
    minUsd?: number;
    first?: number;
    skip?: number;
    version?: SubgraphVersion;
  } = {},
): Promise<{
  swaps: SubgraphSwap[];
  filter: Record<string, unknown>;
  /** Set when a token filter was requested but could not be guaranteed. */
  filterError?: string;
  incomplete: boolean;
  coverage: SwapPageCoverage;
}> {
  const first = Math.min(options.first ?? 20, 100);
  const skip = options.skip ?? 0;
  const version = options.version ?? "v2";
  const client = getPulseXClient(config, version);
  const tokenFilter = options.token
    ? assertAddress(options.token).toLowerCase()
    : undefined;
  const exactPage = swapPageFlags({ skip, first, deep: false });

  // Token filter takes priority over bare minUsd (previously minUsd short-circuited
  // and silently ignored token — returning unrelated large swaps).
  if (tokenFilter) {
    // Discover pairs, prefer volume-active majors for the batch swap query.
    const pairs = await fetchPairsForToken(
      config,
      tokenFilter,
      Math.max(MAX_TOKEN_SWAP_PAIR_QUERIES + 6, 12),
      version,
    );
    const eligiblePairIds = eligibleTokenSwapPairIds(pairs, tokenFilter);
    const pairCapHit = eligiblePairIds.length > MAX_TOKEN_SWAP_PAIR_QUERIES;
    const pairIds = eligiblePairIds.slice(0, MAX_TOKEN_SWAP_PAIR_QUERIES);
    const deep = skip + first > 100;
    const page = swapPageFlags({ skip, first, deep, pairCapHit });

    if (pairIds.length === 0) {
      return {
        swaps: [],
        filter: { token: tokenFilter, pairsUsed: [], minUsd: options.minUsd },
        filterError:
          "No PulseX pairs found for this token; token filter cannot return swaps",
        incomplete: page.incomplete,
        coverage: page.coverage,
      };
    }

    const batchFirst = deep
      ? first
      : Math.min(Math.max((first + skip) * 2, first + skip + 10), 100);
    const batchSkip = deep ? skip : 0;
    let batchSwaps: SubgraphSwap[] = [];
    let batchError: string | undefined;
    try {
      // One GraphQL round-trip (pair_in) — live probe ~0.6s vs multi-pair timeout wall
      const data = await requestSafe<{ swaps: SubgraphSwap[] }>(
        client,
        SWAPS_BY_PAIRS_QUERY,
        { pairs: pairIds, first: batchFirst, skip: batchSkip },
      );
      batchSwaps = data.swaps ?? [];
    } catch (err) {
      batchError = err instanceof Error ? err.message : String(err);
    }

    if (!batchError) {
      const pairIdSet = new Set(pairIds.map((id) => id.toLowerCase()));
      let swaps = filterSwapsByToken(batchSwaps, tokenFilter, pairIdSet).sort(
        (a, b) => Number(b.timestamp) - Number(a.timestamp),
      );
      if (options.minUsd !== undefined && options.minUsd > 0) {
        const min = options.minUsd;
        swaps = swaps.filter((s) => Number(s.amountUSD ?? 0) >= min);
      }
      const matched = filterSwapsByToken(
        batchSwaps,
        tokenFilter,
        pairIdSet,
      ).length;
      return {
        swaps: deep ? swaps.slice(0, first) : swaps.slice(skip, skip + first),
        filter: {
          token: tokenFilter,
          pairsUsed: pairIds,
          pairsFailed: [],
          minUsd: options.minUsd,
          skip,
          strictTokenMatch: true,
          matchBy: "token_id_or_verified_pair_id",
          droppedUnrelated: batchSwaps.length - matched,
          partial: false,
          batch: true,
          maxPairs: MAX_TOKEN_SWAP_PAIR_QUERIES,
        },
        incomplete: page.incomplete,
        coverage: page.coverage,
      };
    }

    // Fallback: parallel per-pair (allSettled) with soft partial failure
    const perPairFirst = Math.min(
      Math.ceil(first / Math.max(pairIds.length, 1)) + 8,
      40,
    );
    const settled = await Promise.allSettled(
      pairIds.map((pairId) =>
        requestSafe<{ swaps: SubgraphSwap[] }>(client, SWAPS_QUERY, {
          pair: pairId,
          first: perPairFirst,
          skip: deep ? skip : 0,
        }).then((data) => ({
          pairId,
          swaps: data.swaps ?? [],
        })),
      ),
    );

    const results = settled.map((s, i) => {
      const pairId = pairIds[i]!;
      if (s.status === "fulfilled") {
        return { pairId, swaps: s.value.swaps };
      }
      const msg =
        s.reason instanceof Error ? s.reason.message : String(s.reason);
      return { pairId, swaps: [] as SubgraphSwap[], error: msg };
    });

    const merged = mergeTokenFilteredSwaps({
      results,
      tokenFilter,
      first,
      skip: deep ? 0 : skip,
      minUsd: options.minUsd,
    });

    if (
      merged.swaps.length === 0 &&
      merged.pairsFailed.length === pairIds.length
    ) {
      return {
        swaps: [],
        filter: {
          token: tokenFilter,
          pairsUsed: pairIds,
          pairsFailed: merged.pairsFailed,
          minUsd: options.minUsd,
          partial: true,
          batch: false,
          parallel: true,
          batchError,
        },
        filterError:
          "Token-filtered swap queries failed (batch + per-pair); try again or use pair= for a known pool",
        incomplete: page.incomplete,
        coverage: page.coverage,
      };
    }

    return {
      swaps: merged.swaps,
      filter: {
        token: tokenFilter,
        pairsUsed: merged.pairsUsed,
        pairsFailed: merged.pairsFailed,
        minUsd: options.minUsd,
        strictTokenMatch: true,
        matchBy: "token_id_or_verified_pair_id",
        droppedUnrelated: merged.droppedUnrelated,
        partial: merged.partial,
        batch: false,
        parallel: true,
        batchError,
        maxPairs: MAX_TOKEN_SWAP_PAIR_QUERIES,
        ...(merged.partial
          ? {
              note: "Batch pair_in failed; partial per-pair results",
            }
          : {
              note: "Batch pair_in failed; used per-pair fallback",
            }),
      },
      incomplete: page.incomplete,
      coverage: page.coverage,
    };
  }

  if (options.minUsd !== undefined && options.minUsd > 0 && !options.pair) {
    const data = await requestSafe<{ swaps: SubgraphSwap[] }>(
      client,
      SWAPS_MIN_USD_QUERY,
      {
        minUsd: String(options.minUsd),
        first,
        skip,
      },
    );
    return {
      swaps: data.swaps ?? [],
      filter: { minUsd: options.minUsd },
      incomplete: exactPage.incomplete,
      coverage: exactPage.coverage,
    };
  }

  if (options.pair) {
    const pair = assertAddress(options.pair).toLowerCase();
    const data = await requestSafe<{ swaps: SubgraphSwap[] }>(
      client,
      SWAPS_QUERY,
      { pair, first, skip },
    );
    let swaps = data.swaps ?? [];
    if (options.minUsd !== undefined && options.minUsd > 0) {
      const min = options.minUsd;
      swaps = swaps.filter((s) => Number(s.amountUSD ?? 0) >= min);
    }
    return {
      swaps,
      filter: { pair, minUsd: options.minUsd },
      incomplete: exactPage.incomplete,
      coverage: exactPage.coverage,
    };
  }

  const data = await requestSafe<{ swaps: SubgraphSwap[] }>(
    client,
    SWAPS_GLOBAL_QUERY,
    { first, skip },
  );
  return {
    swaps: data.swaps ?? [],
    filter: {},
    incomplete: exactPage.incomplete,
    coverage: exactPage.coverage,
  };
}
