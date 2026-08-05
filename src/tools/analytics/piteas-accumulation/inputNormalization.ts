import {
  DEFAULT_FOCUSED_REFRESH_DURATION_MS,
  DEFAULT_GENERATED_STEPS,
  DEFAULT_MAX_BATCH_WINDOW_MS,
  DEFAULT_MAX_BLOCK_SPREAD,
  DEFAULT_MAX_COLLECTION_DURATION_MS,
  DEFAULT_MAX_PAIR_WINDOW_MS,
  DEFAULT_MAX_QUOTE_AGE_SPREAD_MS,
  DEFAULT_QUOTE_CONCURRENCY,
  DEFAULT_REFERENCE_AMOUNT_CANDIDATES,
  MAX_CANDIDATE_CHUNK_COUNT,
  MAX_CANDIDATE_CHUNK_COUNTS,
  MAX_FOCUSED_POINTS,
  MAX_LADDER_POINTS,
  MAX_QUOTE_CONCURRENCY,
} from "./constants.js";
import { isSuccessfulPoint, parseHumanAmount } from "./decimalMath.js";
import type { PiteasAccumulationPlanInput, QuotePoint, SnapshotLimits } from "./types.js";

export function buildQuoteLadder(input: {
  explicitLadderHuman?: string[];
  chunkSizeHuman?: string;
  generatedSteps?: number;
  totalBudgetRaw: bigint;
  decimals: number;
}): { sizesRaw: bigint[]; source: string } {
  const sizes: bigint[] = [];
  if (input.explicitLadderHuman?.length) {
    for (const human of input.explicitLadderHuman) {
      const raw = parseHumanAmount(human, input.decimals, "quoteSizeLadderHuman");
      if (raw > 0n && raw <= input.totalBudgetRaw) sizes.push(raw);
    }
    sizes.push(input.totalBudgetRaw);
    return {
      sizesRaw: limitLadder(uniqueSorted(sizes), input.totalBudgetRaw, MAX_LADDER_POINTS),
      source: "explicit_sorted_deduped_plus_total_budget",
    };
  }

  if (input.chunkSizeHuman) {
    const chunkRaw = parseHumanAmount(input.chunkSizeHuman, input.decimals, "chunkSizeHuman");
    if (chunkRaw <= 0n) throw new Error("chunkSizeHuman must be positive");
    for (let current = chunkRaw; current < input.totalBudgetRaw; current += chunkRaw) {
      sizes.push(current);
      if (sizes.length >= MAX_LADDER_POINTS - 1) break;
    }
    sizes.push(input.totalBudgetRaw);
    return {
      sizesRaw: uniqueSorted(sizes),
      source: "generated_from_chunk_size_plus_total_budget",
    };
  }

  const steps = Math.min(
    Math.max(input.generatedSteps ?? DEFAULT_GENERATED_STEPS, 2),
    MAX_LADDER_POINTS,
  );
  for (let k = 1; k <= steps; k += 1) {
    sizes.push((input.totalBudgetRaw * BigInt(k)) / BigInt(steps));
  }
  sizes.push(input.totalBudgetRaw);
  return {
    sizesRaw: uniqueSorted(sizes.filter((size) => size > 0n)),
    source: "generated_equal_budget_steps",
  };
}

export function buildFocusedLadder(input: {
  explicitLadderHuman?: string[];
  broadPoints: QuotePoint[];
  totalBudgetRaw: bigint;
  decimals: number;
}): bigint[] {
  if (input.explicitLadderHuman?.length) {
    return limitLadder(
      uniqueSorted(
        input.explicitLadderHuman
          .map((human) => parseHumanAmount(human, input.decimals, "focusedQuoteLadderHuman"))
          .filter((raw) => raw > 0n && raw <= input.totalBudgetRaw),
      ),
      input.totalBudgetRaw,
      MAX_FOCUSED_POINTS,
    );
  }
  const boundary = identifyDecisionBoundary(input.broadPoints, input.totalBudgetRaw);
  const fractions: Array<[bigint, bigint]> = [
    [1n, 3n],
    [1n, 2n],
    [2n, 3n],
    [11n, 15n],
    [4n, 5n],
    [13n, 15n],
    [14n, 15n],
    [1n, 1n],
  ];
  const sizes = fractions
    .map(([num, den]) => (boundary * num) / den)
    .filter((raw) => raw > 0n && raw <= input.totalBudgetRaw);
  return uniqueSorted(sizes);
}

export function identifyDecisionBoundary(points: QuotePoint[], totalBudgetRaw: bigint): bigint {
  const successful = points.filter(isSuccessfulPoint);
  const firstCrossing = successful.find((point) => point.thresholdCrossed === true);
  if (firstCrossing) return BigInt(firstCrossing.inputRaw);
  return successful.at(-1) ? BigInt(successful.at(-1)!.inputRaw) : totalBudgetRaw;
}

export function limitLadder(sizes: bigint[], totalBudgetRaw: bigint, maxPoints: number): bigint[] {
  if (sizes.length <= maxPoints) return sizes;
  const limited = sizes.slice(0, maxPoints - 1);
  if (!limited.includes(totalBudgetRaw) && sizes.includes(totalBudgetRaw)) {
    limited.push(totalBudgetRaw);
  }
  return uniqueSorted(limited);
}

export function uniqueSorted(values: bigint[]): bigint[] {
  return [...new Set(values.map((value) => value.toString()))]
    .map((value) => BigInt(value))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function normalizeThresholds(thresholds: number[] | undefined): number[] {
  const values = thresholds?.length ? thresholds : [1, 2, 5];
  return [...new Set(values.filter((value) => Number.isFinite(value) && value >= 0))]
    .sort((a, b) => a - b)
    .slice(0, 5);
}

export function normalizeCandidateChunkCounts(counts: number[] | undefined): number[] {
  if (!counts?.length) return [];
  if (counts.length > MAX_CANDIDATE_CHUNK_COUNTS) {
    throw new Error(
      `candidateChunkCounts must contain at most ${MAX_CANDIDATE_CHUNK_COUNTS} values`,
    );
  }
  for (const value of counts) {
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_CANDIDATE_CHUNK_COUNT
    ) {
      throw new Error(
        `candidateChunkCounts values must be integers between 1 and ${MAX_CANDIDATE_CHUNK_COUNT}`,
      );
    }
  }
  return [...new Set(
    counts,
  )]
    .sort((a, b) => a - b)
    .slice(0, MAX_CANDIDATE_CHUNK_COUNTS);
}

export function normalizeQuoteConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_QUOTE_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUOTE_CONCURRENCY) {
    throw new Error(`quoteConcurrency must be an integer between 1 and ${MAX_QUOTE_CONCURRENCY}`);
  }
  return value;
}

export function normalizeReferenceAmountCandidates(
  values: string[] | undefined,
  decimals: number,
  totalBudgetRaw: bigint,
): bigint[] {
  const source = values?.length ? values : [...DEFAULT_REFERENCE_AMOUNT_CANDIDATES];
  return limitLadder(
    uniqueSorted(
      source
        .map((value) => parseHumanAmount(value, decimals, "referenceAmountCandidatesHuman"))
        .filter((raw) => raw > 0n && raw <= totalBudgetRaw),
    ),
    totalBudgetRaw,
    MAX_LADDER_POINTS,
  );
}

export function normalizeConfirmationCandidateSizes(
  values: string[] | undefined,
  fallbackValues: string[] | undefined,
  decimals: number,
  totalBudgetRaw: bigint,
): bigint[] {
  const source = values?.length ? values : fallbackValues ?? [];
  return limitLadder(
    uniqueSorted(
      source
        .map((value) => parseHumanAmount(value, decimals, "confirmationCandidateSizesHuman"))
        .filter((raw) => raw > 0n && raw <= totalBudgetRaw),
    ),
    totalBudgetRaw,
    MAX_LADDER_POINTS,
  );
}

export function normalizeSnapshotLimits(input: PiteasAccumulationPlanInput): SnapshotLimits {
  return {
    maxBlockSpread: BigInt(input.maxSnapshotBlockSpread ?? DEFAULT_MAX_BLOCK_SPREAD),
    maxCollectionDurationMs:
      input.maxSnapshotCollectionDurationMs ?? DEFAULT_MAX_COLLECTION_DURATION_MS,
    maxQuoteAgeSpreadMs: input.maxQuoteAgeSpreadMs ?? DEFAULT_MAX_QUOTE_AGE_SPREAD_MS,
    focusedRefreshMaxDurationMs:
      input.focusedRefreshMaxDurationMs ?? DEFAULT_FOCUSED_REFRESH_DURATION_MS,
    maximumPairWindowMs: input.maximumPairWindowMs ?? DEFAULT_MAX_PAIR_WINDOW_MS,
    maximumBatchWindowMs:
      input.maximumBatchWindowMs ?? DEFAULT_MAX_BATCH_WINDOW_MS,
  };
}
