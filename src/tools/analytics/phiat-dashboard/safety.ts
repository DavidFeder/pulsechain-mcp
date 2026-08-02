import type { DexScreenerPairSummary } from "../../../data/index.js";
import type { AppConfig } from "../../../types.js";
import { assertAddress } from "../../../utils/safety.js";
import { computeSafetyScore, scanSuspiciousPatterns } from "../helpers.js";
import {
  computeAddressAge,
  inferFirstFunder,
  scoreAddressRisk,
  txTimestamp,
  type ExplorerTxLike,
} from "../advanced-helpers.js";
import { assessLiquidityReliability } from "./marketData.js";
import { ageDaysFromIso, timestampToIso, unixSecondsToIso } from "./dates.js";
import { asRecord, dedupeFailures, numberOrNull, stringOrNull } from "./math.js";
import type {
  CaptureResult,
  HolderMetrics,
  PartialFailure,
  PhiatDashboardDeps,
} from "./builder.js";

export function buildSafetyOutput(input: {
  tokenAddress: string;
  tokenEntity: { symbol?: string; name?: string } | null;
  sourceRows: unknown[] | null;
  holderMetrics: HolderMetrics;
  totalLiquidityUsd: number | null;
  liquidityReliability: ReturnType<typeof assessLiquidityReliability>;
  ageSemantics: Record<string, unknown>;
  sourceAvailable: boolean;
}): Record<string, unknown> {
  const sourceText = Array.isArray(input.sourceRows)
    ? input.sourceRows
        .map((row) => {
          const rec = asRecord(row);
          return `${rec.SourceCode ?? ""}\n${rec.ABI ?? ""}`;
        })
        .join("\n")
    : "";
  const sourceFirst =
    Array.isArray(input.sourceRows) && input.sourceRows.length > 0
      ? asRecord(input.sourceRows[0])
      : {};
  const verified = input.sourceAvailable
    ? sourceText.length > 2 && !/not verified/i.test(sourceText)
    : null;
  const suspiciousPatterns = sourceText
    ? scanSuspiciousPatterns(sourceText)
    : [];
  const flags: string[] = [];
  if (input.liquidityReliability.liquidityRiskLevel === "critical") {
    flags.push("critical_low_liquidity");
  } else if (input.liquidityReliability.liquidityRiskLevel === "high") {
    flags.push("high_liquidity_risk");
  }
  if (
    input.holderMetrics.holderMetricsValid &&
    input.holderMetrics.topHolderShare !== null &&
    input.holderMetrics.topHolderShare > 0.8
  ) {
    flags.push("extreme_holder_concentration");
  }
  if (suspiciousPatterns.includes("mutable_tax")) {
    flags.push("mutable_tax_functions");
  }
  if (suspiciousPatterns.includes("blacklist")) {
    flags.push("blacklist_functions");
  }

  const unavailableInputs: string[] = [];
  if (!input.sourceAvailable) unavailableInputs.push("contract_source");
  if (!input.holderMetrics.holderMetricsValid) {
    unavailableInputs.push("valid_holder_metrics");
  }
  if (input.totalLiquidityUsd === null) unavailableInputs.push("liquidity_usd");
  if (input.liquidityReliability.liquidityRiskLevel === "critical") {
    unavailableInputs.push("reliable_market_liquidity");
  }
  const verifiedContractAgeDays =
    typeof input.ageSemantics.verifiedContractAgeDays === "number"
      ? input.ageSemantics.verifiedContractAgeDays
      : null;
  if (verifiedContractAgeDays === null) {
    unavailableInputs.push("verified_contract_age");
  }

  const canIssueGrade =
    input.sourceAvailable &&
    input.holderMetrics.holderMetricsValid &&
    input.totalLiquidityUsd !== null &&
    input.liquidityReliability.liquidityRiskLevel !== "critical";
  const scored =
    canIssueGrade && input.totalLiquidityUsd !== null
      ? computeSafetyScore({
        verified: verified === true,
        ownershipRenounced: null,
        liquidityUsd: input.totalLiquidityUsd,
        topHolderShare: input.holderMetrics.topHolderShare,
        top10Share: input.holderMetrics.top10HolderShare,
        ageDays: verifiedContractAgeDays,
        honeypotFlags: flags,
        suspiciousAbi: suspiciousPatterns,
      })
      : null;
  const safetyGradeConfidence = !canIssueGrade
    ? "withheld"
    : verifiedContractAgeDays === null
      ? "medium"
      : "high";

  return {
    address: input.tokenAddress,
    symbol: input.tokenEntity?.symbol ?? null,
    name: input.tokenEntity?.name ?? null,
    rawHeuristics: {
      verified,
      contractName: stringOrNull(sourceFirst.ContractName),
      proxy: stringOrNull(sourceFirst.Proxy),
      liquidityUsd: input.totalLiquidityUsd,
      liquidityRiskLevel: input.liquidityReliability.liquidityRiskLevel,
      topHolderShare: input.holderMetrics.topHolderShare,
      top10HolderShare: input.holderMetrics.top10HolderShare,
      holderMetricsValid: input.holderMetrics.holderMetricsValid,
      holderMetricErrors: input.holderMetrics.holderMetricErrors,
      holderSampleSize: input.holderMetrics.holderSampleSize,
      verifiedContractAgeDays,
      suspiciousPatterns,
      flags,
    },
    validatedHeuristics: {
      verified,
      liquidityUsd:
        input.totalLiquidityUsd !== null &&
        input.liquidityReliability.liquidityRiskLevel !== "critical"
          ? input.totalLiquidityUsd
          : null,
      topHolderShare: input.holderMetrics.holderMetricsValid
        ? input.holderMetrics.topHolderShare
        : null,
      top10HolderShare: input.holderMetrics.holderMetricsValid
        ? input.holderMetrics.top10HolderShare
        : null,
      holderSampleSize: input.holderMetrics.holderMetricsValid
        ? input.holderMetrics.holderSampleSize
        : null,
      verifiedContractAgeDays,
      suspiciousPatterns: input.sourceAvailable ? suspiciousPatterns : [],
      flags,
    },
    safetyGrade: scored?.grade ?? null,
    safetyScore: scored?.score ?? null,
    safetyFactors: scored?.factors ?? null,
    safetyGradeConfidence,
    unavailableInputs: [...new Set(unavailableInputs)],
    limitations: [
      "Heuristic score only; not a security audit or honeypot oracle.",
      "Ownership renounce status is not probed by this dashboard.",
      "Buy/sell tax is not measured; suspicious function names are only static signals.",
      "Holder concentration uses a limited public explorer sample and is withheld if validation fails.",
      "Liquidity and USD values rely on public market APIs and may be stale or noisy.",
      "A safety grade is withheld when holder metrics, contract source, or reliable liquidity are unavailable.",
    ],
  };
}

export async function buildDeployerReputation(input: {
  config: AppConfig;
  deps: PhiatDashboardDeps;
  capture: <T>(source: string, task: () => Promise<T>) => Promise<CaptureResult<T>>;
  tokenAddress: string;
  creationRaw: unknown;
}): Promise<Record<string, unknown>> {
  const creation = normalizeCreation(input.creationRaw);
  const creator = creation.creator ? assertAddress(creation.creator).toLowerCase() : null;
  if (!creator) {
    return {
      creator: null,
      creationTxHash: creation.txHash,
      reputation: null,
      confidence: "low",
      method: "BlockScout getcontractcreation; creator unavailable",
      notes: [
        "Creator not found in public explorer response.",
        "Create2/proxy/factory deployments can obscure deployer identity.",
      ],
    };
  }

  const [recentRes, earliestRes] = await Promise.all([
    input.capture("blockscout.deployerTxList.desc", () =>
      input.deps.getAccountTxList(input.config, creator, 1, 50, "desc"),
    ),
    input.capture("blockscout.deployerTxList.asc", () =>
      input.deps.getAccountTxList(input.config, creator, 1, 20, "asc"),
    ),
  ]);
  const recent = asTxArray(recentRes.data);
  const earliest = asTxArray(earliestRes.data);
  const earliestTs =
    earliest.length > 0 ? txTimestamp(earliest[0]!) : firstTimestamp(recent);
  const failedTxCount = recent.filter((tx) => tx.isError === "1").length;
  const deployments = recent.filter(
    (tx) =>
      (!tx.to || tx.to === "") &&
      tx.contractAddress &&
      String(tx.contractAddress).length >= 42,
  );
  const firstFunder = inferFirstFunder(creator, earliest);
  const risk = scoreAddressRisk({
    address: creator,
    isContract: false,
    earliestTxTs: earliestTs,
    txCountSample: recent.length,
    failedTxCount,
    uniqueFunders: [],
    firstFunder: firstFunder.funder,
    contractCreations: deployments.length,
  });

  return {
    creator,
    creationTxHash: creation.txHash,
    age: computeAddressAge(earliestTs),
    reputation: {
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      signals: risk.signals,
      summary:
        deployments.length >= 5
          ? "Multiple contract deployments observed in recent sample."
          : deployments.length > 0
            ? "Some contract deployment activity observed in recent sample."
            : "Limited deployment activity observed in recent sample.",
    },
    sample: {
      txCount: recent.length,
      failedTxCount,
      deploymentsInSample: deployments.length,
    },
    otherDeployments: deployments
      .map((tx) => ({
        contractAddress: tx.contractAddress ?? null,
        txHash: tx.hash ?? null,
        timestamp: txTimestamp(tx) ?? null,
      }))
      .filter(
        (row) =>
          row.contractAddress?.toLowerCase() !== input.tokenAddress.toLowerCase(),
      )
      .slice(0, 20),
    firstFunder,
    confidence: risk.confidence,
    method: "BlockScout getcontractcreation + creator txlist public heuristics",
    caveats: [
      "No private reputation database is used.",
      "Sample is page-limited and can miss older deployer behavior.",
      "Explorer creator records can be incomplete for factory/proxy/create2 deployments.",
    ],
  };
}

export function buildAgeSemantics(input: {
  creationRaw: unknown;
  creationAvailable: boolean;
  primaryDexPair: DexScreenerPairSummary | null;
  dayData: Array<{ date: number }>;
}): Record<string, unknown> {
  const creation = normalizeCreation(input.creationRaw);
  const verifiedContractCreationTimestamp =
    input.creationAvailable && creation.timestamp !== null
      ? timestampToIso(creation.timestamp)
      : null;
  const primaryPairCreatedAt = timestampToIso(input.primaryDexPair?.pairCreatedAt);
  const firstIndexedActivityTimestamp = findFirstIndexedActivityTimestamp(input.dayData);

  return {
    verifiedContractCreationTimestamp,
    verifiedContractAgeDays: ageDaysFromIso(verifiedContractCreationTimestamp),
    primaryPairCreatedAt,
    primaryPairAgeDays: ageDaysFromIso(primaryPairCreatedAt),
    firstIndexedActivityTimestamp,
    firstIndexedActivitySource: firstIndexedActivityTimestamp
      ? "pulsex_subgraph.tokenDayData.v2 oldest returned date in capped sample"
      : null,
  };
}

export function normalizeCreation(raw: unknown): {
  creator: string | null;
  txHash: string | null;
  timestamp: unknown;
} {
  const recRaw = asRecord(raw);
  const result = recRaw.result;
  const first = Array.isArray(raw)
    ? raw[0]
    : Array.isArray(result)
      ? result[0]
      : raw;
  const rec = asRecord(first);
  return {
    creator: stringOrNull(
      rec.contractCreator ?? rec.creatorAddress ?? rec.creator ?? rec.from,
    ),
    txHash: stringOrNull(rec.txHash ?? rec.hash),
    timestamp:
      rec.timeStamp ??
      rec.timestamp ??
      rec.createdAt ??
      rec.created_at ??
      rec.creationTimestamp ??
      null,
  };
}

export function buildSafetyWarnings(
  tokenEntity: { id?: string } | null,
  tokenSafety: Record<string, unknown>,
  partialFailures: PartialFailure[],
  liquidityReliability: ReturnType<typeof assessLiquidityReliability>,
  marketWarnings: string[],
): string[] {
  const warnings: string[] = [];
  if (!tokenEntity) {
    warnings.push(
      "PulseX token entity was unavailable or not found; token identity/market fields are partial.",
    );
  }
  const rawHeuristics = asRecord(tokenSafety.rawHeuristics);
  const flags = Array.isArray(rawHeuristics.flags) ? rawHeuristics.flags : [];
  for (const flag of flags) {
    warnings.push(`Safety heuristic flag: ${String(flag)}`);
  }
  const suspicious = Array.isArray(rawHeuristics.suspiciousPatterns)
    ? rawHeuristics.suspiciousPatterns
    : [];
  for (const pattern of suspicious) {
    warnings.push(`Suspicious contract pattern: ${String(pattern)}`);
  }
  if (
    liquidityReliability.liquidityRiskLevel === "critical" ||
    liquidityReliability.liquidityRiskLevel === "unknown"
  ) {
    warnings.push(liquidityReliability.liquidityReliabilityWarning);
  }
  for (const warning of marketWarnings) {
    warnings.push(`Market source discrepancy: ${warning}`);
  }
  if (tokenSafety.safetyGrade === null) {
    warnings.push(
      "Safety grade withheld because one or more critical inputs are invalid, unavailable, or critically unreliable.",
    );
  }
  if (partialFailures.length > 0) {
    warnings.push(
      `${dedupeFailures(partialFailures).length} upstream source(s) failed; see dataQuality.partialFailures.`,
    );
  }
  return [...new Set(warnings)];
}

export function findFirstIndexedActivityTimestamp(days: Array<{ date: number }>): string | null {
  const timestamps = days
    .map((day) => numberOrNull(day.date))
    .filter((timestamp): timestamp is number => timestamp !== null && timestamp > 0);
  if (timestamps.length === 0) return null;
  return unixSecondsToIso(Math.min(...timestamps));
}

export function asTxArray(raw: unknown): ExplorerTxLike[] {
  return Array.isArray(raw) ? (raw as ExplorerTxLike[]) : [];
}

export function firstTimestamp(txs: ExplorerTxLike[]): number | undefined {
  const timestamps = txs
    .map((tx) => txTimestamp(tx))
    .filter((ts): ts is number => ts !== undefined);
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}
