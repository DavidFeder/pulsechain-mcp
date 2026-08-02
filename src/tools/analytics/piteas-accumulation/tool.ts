import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppConfig } from "../../../types.js";
import { ok } from "../../../utils/result.js";
import { registerTool } from "../../define.js";
import {
  DEFAULT_EUSDC_DECIMALS,
  DEFAULT_FOCUSED_REFRESH_DURATION_MS,
  DEFAULT_MAX_ADAPTIVE_ROUNDS,
  DEFAULT_MAX_BATCH_WINDOW_MS,
  DEFAULT_MAX_BLOCK_SPREAD,
  DEFAULT_MAX_COLLECTION_DURATION_MS,
  DEFAULT_MAX_PAIR_WINDOW_MS,
  DEFAULT_MAX_QUOTE_AGE_SPREAD_MS,
  DEFAULT_MAX_REFERENCE_DRIFT_PERCENT,
  DEFAULT_OPERATIONAL_SAFETY_BUFFER_PERCENT,
  DEFAULT_PHIAT_DECIMALS,
  DEFAULT_QUOTE_CONCURRENCY,
  DEFAULT_TRANCHE_INCREMENT_HUMAN,
  MAX_CANDIDATE_CHUNK_COUNT,
  MAX_CANDIDATE_CHUNK_COUNTS,
  MAX_FOCUSED_POINTS,
  MAX_LADDER_POINTS,
  MAX_QUOTE_CONCURRENCY,
} from "./constants.js";
import { addressSchema, decimalHumanSchema } from "./schema.js";
import { buildPiteasAccumulationPlan, defaultDeps } from "./builder.js";
import type { ConfirmationMode, PiteasAccumulationPlanDeps } from "./types.js";

export function registerPiteasAccumulationPlanTool(
  server: McpServer,
  config: AppConfig,
  deps: PiteasAccumulationPlanDeps = defaultDeps,
): void {
  registerTool(server, config, {
    name: "piteas_accumulation_plan",
    description:
      "Research-only eUSDC -> PHIAT accumulation planner using Piteas quote data only. " +
      "Requires verified token addresses, checks quote coherence, and never prepares or submits transactions.",
    category: "analytics",
    inputSchema: {
      eUsdcAddress: addressSchema,
      phiatAddress: addressSchema,
      totalBudgetHuman: decimalHumanSchema,
      quoteSizeLadderHuman: z.array(decimalHumanSchema).max(MAX_LADDER_POINTS).optional(),
      chunkSizeHuman: decimalHumanSchema.optional(),
      generatedLadderSteps: z.number().int().min(2).max(MAX_LADDER_POINTS).optional(),
      candidateChunkCounts: z
        .array(z.number().int().min(1).max(MAX_CANDIDATE_CHUNK_COUNT))
        .max(MAX_CANDIDATE_CHUNK_COUNTS)
        .optional(),
      eUsdcDecimals: z.number().int().min(0).max(36).default(DEFAULT_EUSDC_DECIMALS),
      phiatDecimals: z.number().int().min(0).max(36).default(DEFAULT_PHIAT_DECIMALS),
      allowedSlippagePercent: z.number().min(0).max(100).default(0.5),
      priceImpactThresholdsPercent: z.array(z.number().min(0).max(100)).max(5).optional(),
      maximumAcceptableAveragePrice: decimalHumanSchema.optional(),
      maxGasCostPercentOfChunk: z.number().min(0).max(100).default(1),
      maxSnapshotBlockSpread: z.number().int().min(0).max(100).default(DEFAULT_MAX_BLOCK_SPREAD),
      maxSnapshotCollectionDurationMs: z
        .number()
        .int()
        .min(1_000)
        .max(300_000)
        .default(DEFAULT_MAX_COLLECTION_DURATION_MS),
      maxQuoteAgeSpreadMs: z
        .number()
        .int()
        .min(1_000)
        .max(300_000)
        .default(DEFAULT_MAX_QUOTE_AGE_SPREAD_MS),
      focusedRefresh: z.boolean().default(true),
      focusedQuoteLadderHuman: z.array(decimalHumanSchema).max(MAX_FOCUSED_POINTS).optional(),
      focusedRefreshMaxDurationMs: z
        .number()
        .int()
        .min(1_000)
        .max(300_000)
        .default(DEFAULT_FOCUSED_REFRESH_DURATION_MS),
      pairedReferenceAmountHuman: decimalHumanSchema.optional(),
      pairedCandidateSizesHuman: z
        .array(decimalHumanSchema)
        .max(MAX_LADDER_POINTS)
        .optional(),
      maximumPairWindowMs: z
        .number()
        .int()
        .min(500)
        .max(300_000)
        .default(DEFAULT_MAX_PAIR_WINDOW_MS),
      confirmationMode: z
        .enum(["individual_pairs", "batch_sandwich", "adaptive"])
        .default("adaptive"),
      referenceAmountCandidatesHuman: z
        .array(decimalHumanSchema)
        .max(MAX_LADDER_POINTS)
        .optional(),
      confirmationCandidateSizesHuman: z
        .array(decimalHumanSchema)
        .max(MAX_LADDER_POINTS)
        .optional(),
      maximumBatchWindowMs: z
        .number()
        .int()
        .min(1_000)
        .max(300_000)
        .default(DEFAULT_MAX_BATCH_WINDOW_MS),
      maximumReferenceDriftPercent: z
        .number()
        .min(0)
        .max(100)
        .default(DEFAULT_MAX_REFERENCE_DRIFT_PERCENT),
      quoteConcurrency: z
        .number()
        .int()
        .min(1)
        .max(MAX_QUOTE_CONCURRENCY)
        .default(DEFAULT_QUOTE_CONCURRENCY),
      maximumAdaptiveRounds: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(DEFAULT_MAX_ADAPTIVE_ROUNDS),
      maximumBracketWidthHuman: decimalHumanSchema.optional(),
      allowLowConfidenceFreshness: z
        .boolean()
        .default(false)
        .describe(
          "Operator override. When false, identical before/after references with no independent freshness metadata withhold recommendations.",
        ),
      trancheIncrementHuman: decimalHumanSchema
        .default(DEFAULT_TRANCHE_INCREMENT_HUMAN)
        .describe("Input-token tranche increment used to round operational tranche sizes down."),
      operationalSafetyBufferPercent: z
        .number()
        .min(0)
        .max(100)
        .default(DEFAULT_OPERATIONAL_SAFETY_BUFFER_PERCENT),
      account: addressSchema.optional(),
    },
    handler: async (args, cfg) =>
      ok(
        await buildPiteasAccumulationPlan(
          cfg,
          {
            eUsdcAddress: args.eUsdcAddress as string,
            phiatAddress: args.phiatAddress as string,
            totalBudgetHuman: args.totalBudgetHuman as string,
            quoteSizeLadderHuman: args.quoteSizeLadderHuman as string[] | undefined,
            chunkSizeHuman: args.chunkSizeHuman as string | undefined,
            generatedLadderSteps: args.generatedLadderSteps as number | undefined,
            candidateChunkCounts: args.candidateChunkCounts as number[] | undefined,
            eUsdcDecimals: args.eUsdcDecimals as number | undefined,
            phiatDecimals: args.phiatDecimals as number | undefined,
            allowedSlippagePercent: args.allowedSlippagePercent as number | undefined,
            priceImpactThresholdsPercent:
              args.priceImpactThresholdsPercent as number[] | undefined,
            maximumAcceptableAveragePrice:
              args.maximumAcceptableAveragePrice as string | undefined,
            maxGasCostPercentOfChunk:
              args.maxGasCostPercentOfChunk as number | undefined,
            maxSnapshotBlockSpread: args.maxSnapshotBlockSpread as number | undefined,
            maxSnapshotCollectionDurationMs:
              args.maxSnapshotCollectionDurationMs as number | undefined,
            maxQuoteAgeSpreadMs: args.maxQuoteAgeSpreadMs as number | undefined,
            focusedRefresh: args.focusedRefresh as boolean | undefined,
            focusedQuoteLadderHuman: args.focusedQuoteLadderHuman as string[] | undefined,
            focusedRefreshMaxDurationMs:
              args.focusedRefreshMaxDurationMs as number | undefined,
            pairedReferenceAmountHuman:
              args.pairedReferenceAmountHuman as string | undefined,
            pairedCandidateSizesHuman:
              args.pairedCandidateSizesHuman as string[] | undefined,
            maximumPairWindowMs: args.maximumPairWindowMs as number | undefined,
            confirmationMode:
              (args.confirmationMode as ConfirmationMode | undefined) ?? "adaptive",
            referenceAmountCandidatesHuman:
              args.referenceAmountCandidatesHuman as string[] | undefined,
            confirmationCandidateSizesHuman:
              args.confirmationCandidateSizesHuman as string[] | undefined,
            maximumBatchWindowMs: args.maximumBatchWindowMs as number | undefined,
            maximumReferenceDriftPercent:
              args.maximumReferenceDriftPercent as number | undefined,
            quoteConcurrency: args.quoteConcurrency as number | undefined,
            maximumAdaptiveRounds: args.maximumAdaptiveRounds as number | undefined,
            maximumBracketWidthHuman:
              args.maximumBracketWidthHuman as string | undefined,
            allowLowConfidenceFreshness:
              args.allowLowConfidenceFreshness as boolean | undefined,
            trancheIncrementHuman: args.trancheIncrementHuman as string | undefined,
            operationalSafetyBufferPercent:
              args.operationalSafetyBufferPercent as number | undefined,
            account: args.account as string | undefined,
          },
          deps,
        ),
      ),
  });
}
