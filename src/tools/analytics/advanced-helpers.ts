/**
 * Pure heuristics for advanced analytics tools.
 * Risk / scam signals are approximate — callers should surface method + confidence.
 */

import {
  CORE_TOKENS,
  POPULAR_CONTRACTS_BY_ADDRESS,
  WPLS_ADDRESS,
} from "../../constants.js";
import {
  HEURISTIC_SCORE_HONESTY,
  resolvePairLiquidityUsd,
  type HeuristicScoreHonesty,
} from "./helpers.js";

export type Confidence = "high" | "medium" | "low";

export interface RiskSignal {
  id: string;
  severity: "info" | "low" | "medium" | "high";
  message: string;
  evidence?: Record<string, unknown>;
}

export interface ExplorerTxLike {
  hash?: string;
  from?: string;
  to?: string;
  value?: string;
  timeStamp?: string;
  timestamp?: string;
  isError?: string;
  contractAddress?: string;
  input?: string;
  functionName?: string;
}

export interface HolderLike {
  address?: string | { hash?: string };
  addressHash?: string;
  value?: string;
  balance?: string;
}

const KNOWN_SAFE = new Set(
  Object.values(CORE_TOKENS)
    .map((t) => t.address.toLowerCase())
    .concat(Object.keys(POPULAR_CONTRACTS_BY_ADDRESS)),
);

export function isKnownSafeAddress(address: string): boolean {
  return KNOWN_SAFE.has(address.toLowerCase());
}

export function normalizeHolderAddress(h: HolderLike): string | undefined {
  const nested =
    h.address && typeof h.address === "object"
      ? (h.address as { hash?: string }).hash
      : undefined;
  const a =
    (typeof h.address === "string" ? h.address : undefined) ??
    h.addressHash ??
    nested;
  if (!a) return undefined;
  return a.toLowerCase();
}

export function holderBalance(h: HolderLike): bigint {
  const raw = h.value ?? h.balance ?? "0";
  try {
    return BigInt(raw.split(".")[0] ?? "0");
  } catch {
    return 0n;
  }
}

/** Extract unix seconds from explorer tx. */
export function txTimestamp(tx: ExplorerTxLike): number | undefined {
  const raw = tx.timeStamp ?? tx.timestamp;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Min of finite positive timestamps; undefined when the list is empty (avoids Math.min(...[]) === Infinity). */
export function earliestTxTimestamp(txs: ExplorerTxLike[]): number | undefined {
  const times = txs
    .map(txTimestamp)
    .filter((t): t is number => t !== undefined);
  if (times.length === 0) return undefined;
  return Math.min(...times);
}

export function isPositiveWeiString(value: string | undefined): boolean {
  if (value === undefined) return false;
  const s = value.trim();
  if (!s) return false;
  try {
    if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s) > 0n;
    if (!/^\d+$/.test(s)) return false;
    return BigInt(s) > 0n;
  } catch {
    return false;
  }
}

/**
 * Age of address from earliest known transaction timestamp (seconds).
 */
export function computeAddressAge(
  earliestTs: number | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): {
  ageSeconds: number | null;
  ageDays: number | null;
  young: boolean;
} {
  if (earliestTs === undefined || earliestTs <= 0) {
    return { ageSeconds: null, ageDays: null, young: false };
  }
  const ageSeconds = Math.max(0, nowSec - earliestTs);
  const ageDays = ageSeconds / 86_400;
  return {
    ageSeconds,
    ageDays: Math.round(ageDays * 100) / 100,
    young: ageDays < 7,
  };
}

/**
 * Infer first native funder: earliest inbound tx (to == address, value > 0).
 */
export function inferFirstFunder(
  address: string,
  txsAsc: ExplorerTxLike[],
): {
  funder: string | null;
  valueWei: string | null;
  txHash: string | null;
  timestamp: number | null;
  method: string;
} {
  const addr = address.toLowerCase();
  for (const tx of txsAsc) {
    const to = (tx.to ?? "").toLowerCase();
    const from = (tx.from ?? "").toLowerCase();
    const value = tx.value ?? "0";
    if (to === addr && from && from !== addr && isPositiveWeiString(value)) {
      return {
        funder: from,
        valueWei: value,
        txHash: tx.hash ?? null,
        timestamp: txTimestamp(tx) ?? null,
        method: "earliest native inbound tx from explorer txlist sort=asc",
      };
    }
  }
  return {
    funder: null,
    valueWei: null,
    txHash: null,
    timestamp: null,
    method: "earliest native inbound tx from explorer txlist sort=asc",
  };
}

/**
 * Heuristic risk signals from public explorer history (no private labels DB).
 */
export function scoreAddressRisk(input: {
  address: string;
  isContract?: boolean;
  earliestTxTs?: number;
  txCountSample: number;
  failedTxCount: number;
  uniqueFunders: string[];
  firstFunder: string | null;
  contractCreations: number;
  nowSec?: number;
}): {
  riskScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  signals: RiskSignal[];
  confidence: Confidence;
  method: string;
} & HeuristicScoreHonesty {
  const signals: RiskSignal[] = [];
  let score = 0;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const age = computeAddressAge(input.earliestTxTs, nowSec);
  const addr = input.address.toLowerCase();

  if (isKnownSafeAddress(addr)) {
    signals.push({
      id: "known_core_address",
      severity: "info",
      message: "Address is a well-known PulseChain core token/contract.",
    });
    return {
      riskScore: 0,
      riskLevel: "low",
      signals,
      confidence: "medium",
      method:
        "Public heuristics on explorer tx history + known CORE_TOKENS/POPULAR_CONTRACTS registry",
      ...HEURISTIC_SCORE_HONESTY,
    };
  }

  if (age.young && age.ageDays !== null) {
    score += age.ageDays < 1 ? 35 : 20;
    signals.push({
      id: "young_address",
      severity: age.ageDays < 1 ? "high" : "medium",
      message: `Address age ~${age.ageDays} days (under 7 days is elevated).`,
      evidence: { ageDays: age.ageDays, ageSeconds: age.ageSeconds },
    });
  }

  if (input.txCountSample === 0) {
    score += 10;
    signals.push({
      id: "no_tx_history",
      severity: "low",
      message: "No transactions found in explorer sample.",
    });
  }

  if (input.uniqueFunders.length === 1 && input.firstFunder) {
    score += 10;
    signals.push({
      id: "single_funder",
      severity: "low",
      message: "Only one observed native funder in sample (common for new EOAs).",
      evidence: { funder: input.firstFunder },
    });
  }

  if (input.uniqueFunders.length >= 8 && age.young) {
    score += 15;
    signals.push({
      id: "many_funders_young",
      severity: "medium",
      message:
        "Young address with many distinct funders — possible distribution/mixer pattern.",
      evidence: { funderCount: input.uniqueFunders.length },
    });
  }

  if (input.failedTxCount > 0 && input.txCountSample > 0) {
    const failRate = input.failedTxCount / input.txCountSample;
    if (failRate >= 0.4) {
      score += 20;
      signals.push({
        id: "high_fail_rate",
        severity: "medium",
        message: `High failed-tx ratio in sample (${Math.round(failRate * 100)}%).`,
        evidence: {
          failedTxCount: input.failedTxCount,
          sampleSize: input.txCountSample,
        },
      });
    }
  }

  if (input.contractCreations >= 5 && age.young) {
    score += 25;
    signals.push({
      id: "burst_deployer",
      severity: "high",
      message:
        "Young address with multiple contract creations — spray deployer pattern.",
      evidence: { contractCreations: input.contractCreations },
    });
  } else if (input.contractCreations >= 3) {
    score += 10;
    signals.push({
      id: "multi_deployer",
      severity: "low",
      message: "Address has created multiple contracts in sample.",
      evidence: { contractCreations: input.contractCreations },
    });
  }

  if (input.isContract) {
    signals.push({
      id: "is_contract",
      severity: "info",
      message: "Address appears to be a contract (has code / creation record).",
    });
  }

  score = Math.min(100, score);
  const riskLevel =
    score >= 70
      ? "critical"
      : score >= 45
        ? "high"
        : score >= 25
          ? "medium"
          : "low";

  return {
    riskScore: score,
    riskLevel,
    signals,
    confidence: input.txCountSample >= 20 ? "medium" : "low",
    method:
      "Public heuristics on explorer tx history + known CORE_TOKENS/POPULAR_CONTRACTS registry. " +
      "Not a scam blacklist; false positives expected. Confidence reflects sample size.",
    ...HEURISTIC_SCORE_HONESTY,
  };
}

export interface ScamPairLike {
  id: string;
  /** PulseX subgraph uses `timestamp`; Uniswap-style may use createdAtTimestamp. */
  timestamp?: string;
  createdAtTimestamp?: string;
  reserveUSD?: string;
  reserve0?: string;
  reserve1?: string;
  volumeUSD?: string;
  txCount?: string;
  totalTransactions?: string;
  totalSupply?: string;
  token0?: { id?: string; symbol?: string; derivedUSD?: string };
  token1?: { id?: string; symbol?: string; derivedUSD?: string };
}

export interface ScamBurnLike {
  id: string;
  timestamp?: string;
  amountUSD?: string;
  liquidity?: string;
  pair?: {
    id?: string;
    reserveUSD?: string;
    reserve0?: string;
    reserve1?: string;
    totalSupply?: string;
    token0?: { id?: string; symbol?: string; derivedUSD?: string };
    token1?: { id?: string; symbol?: string; derivedUSD?: string };
  };
  transaction?: { id?: string };
}

/**
 * Flag pairs/burns that look like liquidity-pull or honeypot-adjacent patterns.
 * Approximate only — labels confidence + method.
 */
export function detectScamAlerts(input: {
  pairs: ScamPairLike[];
  burns: ScamBurnLike[];
  nowSec?: number;
  maxAgeDays?: number;
  volumeToLiquidityRatio?: number;
}): {
  alerts: Array<{
    type: string;
    severity: "low" | "medium" | "high";
    message: string;
    pair?: string;
    tokenHints?: string[];
    evidence: Record<string, unknown>;
    confidence: Confidence;
  }>;
  method: string;
  confidence: Confidence;
} & HeuristicScoreHonesty {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAgeDays = input.maxAgeDays ?? 14;
  const volRatio = input.volumeToLiquidityRatio ?? 20;
  const alerts: Array<{
    type: string;
    severity: "low" | "medium" | "high";
    message: string;
    pair?: string;
    tokenHints?: string[];
    evidence: Record<string, unknown>;
    confidence: Confidence;
  }> = [];

  for (const pair of input.pairs) {
    const created = Number(pair.timestamp ?? pair.createdAtTimestamp ?? 0);
    const ageDays = created > 0 ? (nowSec - created) / 86_400 : null;
    // Prefer sanitized liquidity so absurd subgraph reserveUSD cannot suppress
    // volume/liquidity alerts by inflating the denominator. Demoted polluted
    // pairs (liquidity 0 after sanitation) use a $1 floor for ratio math so
    // high-volume signals still fire instead of being silenced.
    const liq = resolvePairLiquidityUsd(pair);
    const reserve =
      liq.liquidityUsd > 0
        ? liq.liquidityUsd
        : liq.polluted
          ? 1
          : 0;
    const volume = Number(pair.volumeUSD ?? 0);
    const txns = Number(pair.totalTransactions ?? pair.txCount ?? 0);
    const tokens = [pair.token0?.symbol, pair.token1?.symbol].filter(
      Boolean,
    ) as string[];
    const tokenIds = [pair.token0?.id, pair.token1?.id]
      .filter(Boolean)
      .map((x) => (x as string).toLowerCase());

    const isCorePair = tokenIds.every(
      (id) => isKnownSafeAddress(id) || id === WPLS_ADDRESS.toLowerCase(),
    );
    if (isCorePair) continue;

    if (ageDays !== null && ageDays <= maxAgeDays && reserve > 0 && volume / reserve >= volRatio) {
      alerts.push({
        type: "high_volume_low_liquidity_young_pair",
        severity: volume / reserve >= 50 ? "high" : "medium",
        message: `Young pair with volume/liquidity ratio ~${(volume / reserve).toFixed(1)}x.`,
        pair: pair.id,
        tokenHints: tokens,
        evidence: {
          ageDays: Math.round(ageDays * 100) / 100,
          reserveUSD: reserve,
          rawReserveUSD: liq.rawReserveUsd,
          liquiditySource: liq.source,
          liquidityPolluted: liq.polluted,
          volumeUSD: volume,
          totalTransactions: txns,
        },
        confidence: "medium",
      });
    }

    // Thin-liquidity: use sanitized USD (demoted polluted counts as thin)
    const thinReserve = liq.liquidityUsd > 0 ? liq.liquidityUsd : liq.polluted ? 0 : -1;
    if (
      ageDays !== null &&
      ageDays <= 3 &&
      thinReserve >= 0 &&
      thinReserve < 500 &&
      txns >= 50
    ) {
      alerts.push({
        type: "thin_liquidity_high_activity",
        severity: "medium",
        message:
          "Very new pair with thin USD reserves but elevated swap count (honeypot-like activity pattern).",
        pair: pair.id,
        tokenHints: tokens,
        evidence: {
          ageDays: Math.round(ageDays * 100) / 100,
          reserveUSD: thinReserve,
          rawReserveUSD: liq.rawReserveUsd,
          liquiditySource: liq.source,
          totalTransactions: txns,
        },
        confidence: "low",
      });
    }
  }

  for (const burn of input.burns) {
    const burnUsd = Number(burn.amountUSD ?? 0);
    const burnLiq = burn.pair
      ? resolvePairLiquidityUsd(burn.pair)
      : { liquidityUsd: 0, rawReserveUsd: 0, polluted: false, source: "demoted" as const };
    const reserve = burnLiq.liquidityUsd;
    if (burnUsd <= 0) continue;
    // Large burn relative to remaining (sanitized) reserve → possible LP pull
    if (reserve >= 0 && burnUsd >= 1_000) {
      const fraction =
        reserve + burnUsd > 0 ? burnUsd / (reserve + burnUsd) : 1;
      if (fraction >= 0.5 || reserve < burnUsd * 0.25) {
        alerts.push({
          type: "liquidity_pull_signal",
          severity: fraction >= 0.8 ? "high" : "medium",
          message:
            "Large LP burn relative to remaining pair reserves (liquidity-pull heuristic).",
          pair: burn.pair?.id,
          tokenHints: [
            burn.pair?.token0?.symbol,
            burn.pair?.token1?.symbol,
          ].filter(Boolean) as string[],
          evidence: {
            burnUsd,
            remainingReserveUSD: reserve,
            approxBurnFraction: Math.round(fraction * 1000) / 1000,
            tx: burn.transaction?.id,
            timestamp: burn.timestamp,
          },
          confidence: "medium",
        });
      }
    }
  }

  alerts.sort((a, b) => {
    const rank = { high: 3, medium: 2, low: 1 };
    return rank[b.severity] - rank[a.severity];
  });

  return {
    alerts,
    method:
      "PulseX subgraph heuristics: (1) young pairs with volume>>reserveUSD, " +
      "(2) thin-liquidity high-tx pairs, (3) large burns vs remaining reserves. " +
      "Not definitive scam detection; no private openpulsechain feeds.",
    confidence: "medium",
    ...HEURISTIC_SCORE_HONESTY,
  };
}

/**
 * Rank an address among holders list (page-ordered by balance desc typically).
 */
export function computeHolderRank(
  holders: HolderLike[],
  address: string,
  options: {
    page: number;
    offset: number;
    totalSupply?: string | null;
    source?: "v2" | "module";
  },
): {
  found: boolean;
  rank: number | null;
  balance: string | null;
  shareOfSamplePct: number | null;
  shareOfSupplyPct: number | null;
  percentileEstimate: number | null;
  method: string;
  confidence: Confidence;
  caveats: string[];
} {
  const addr = address.toLowerCase();
  const caveats: string[] = [];
  let index = -1;
  let bal: bigint | null = null;

  for (let i = 0; i < holders.length; i++) {
    const hAddr = normalizeHolderAddress(holders[i]!);
    if (hAddr === addr) {
      index = i;
      bal = holderBalance(holders[i]!);
      break;
    }
  }

  if (index < 0) {
    caveats.push(
      "Address not in returned holder page. Rank unknown without scanning more pages or full holder set.",
    );
    return {
      found: false,
      rank: null,
      balance: null,
      shareOfSamplePct: null,
      shareOfSupplyPct: null,
      percentileEstimate: null,
      method: "BlockScout getTokenHolders page scan",
      confidence: "low",
      caveats,
    };
  }

  const rank = (options.page - 1) * options.offset + index + 1;
  const sampleTotal = holders.reduce((acc, h) => acc + holderBalance(h), 0n);
  const shareOfSamplePct =
    sampleTotal > 0n && bal !== null
      ? Number((bal * 10_000n) / sampleTotal) / 100
      : null;

  let shareOfSupplyPct: number | null = null;
  if (options.totalSupply && bal !== null) {
    try {
      const supply = BigInt(String(options.totalSupply).split(".")[0] ?? "0");
      if (supply > 0n) {
        shareOfSupplyPct = Number((bal * 10_000n) / supply) / 100;
      }
    } catch {
      caveats.push("Could not parse totalSupply for share calculation.");
    }
  } else {
    caveats.push("totalSupply not provided; share-of-supply omitted.");
  }

  // Percentile estimate assumes holders are ordered by balance desc and
  // that page offset covers the top N — weak if address is mid-list unknown.
  const approxUniverse = Math.max(rank * 2, options.page * options.offset);
  const percentileEstimate =
    Math.round((1 - rank / approxUniverse) * 10_000) / 100;
  caveats.push(
    "percentileEstimate is approximate (assumes balance-desc ordering and incomplete universe).",
  );

  return {
    found: true,
    rank,
    balance: bal?.toString() ?? null,
    shareOfSamplePct,
    shareOfSupplyPct,
    percentileEstimate,
    method:
      options.source === "v2"
        ? "BlockScout API v2 /tokens/{addr}/holders (top holders page). Rank = index + 1 on the returned page."
        : "BlockScout module=token&action=getTokenHolders. Rank = (page-1)*offset + index + 1 when found on page.",
    confidence: options.page === 1 && rank <= options.offset ? "medium" : "low",
    caveats,
  };
}

/** Deduplicate and sort funding edges for tree output. */
export function buildFundingNodes(
  root: string,
  hops: Array<{
    address: string;
    fundedBy: string | null;
    valueWei: string | null;
    txHash: string | null;
    timestamp: number | null;
    depth: number;
  }>,
): {
  root: string;
  nodes: typeof hops;
  method: string;
  confidence: Confidence;
} {
  return {
    root: root.toLowerCase(),
    nodes: hops,
    method:
      "Depth-limited BFS using explorer txlist (sort=asc) earliest native inbound transfer as parent edge. " +
      "Internal txs not fully expanded; exchange deposit addresses may appear as roots.",
    confidence: "medium",
  };
}

export function weiToPls(wei: string | null | undefined): string | null {
  if (!wei) return null;
  try {
    const v = BigInt(wei);
    const whole = v / 10n ** 18n;
    const frac = v % 10n ** 18n;
    const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return null;
  }
}
