import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  fetchPair,
  fetchPairDayData,
  fetchSubgraphMeta,
  fetchSwaps,
  fetchToken,
  fetchTokenDayData,
  fetchTopPairs,
  fetchTopTokens,
} from "../../data/subgraph.js";
import type { AppConfig } from "../../types.js";
import { ok } from "../../utils/result.js";
import { registerTool } from "../define.js";
import { registerAdvancedAnalyticsTools } from "./advanced.js";
import { registerDexScreenerTools } from "./dexscreener.js";
import { registerFreeTierAnalyticsTools } from "./freeTier.js";
import { registerPhiatDashboardTool } from "./phiatDashboard.js";
import { registerPiteasAccumulationPlanTool } from "./piteasAccumulationPlan.js";
import { registerTierATools } from "./tierA.js";
import { registerTierBTools } from "./tierB.js";
import {
  labelSubgraphPairRow,
  labelSubgraphSwapRow,
  labelSubgraphTokenRow,
} from "./helpers.js";

export { registerFreeTierAnalyticsTools } from "./freeTier.js";
export { registerAdvancedAnalyticsTools } from "./advanced.js";
export { registerDexScreenerTools } from "./dexscreener.js";
export { registerPhiatDashboardTool, buildPhiatDashboard } from "./phiatDashboard.js";
export {
  registerPiteasAccumulationPlanTool,
  buildPiteasAccumulationPlan,
} from "./piteasAccumulationPlan.js";
export { registerTierATools } from "./tierA.js";
export { registerTierBTools } from "./tierB.js";
export {
  computeSafetyScore,
  scoreToGrade,
  scanSuspiciousPatterns,
  bucketHoldersByLeague,
  tierForUsd,
  num,
  labelSubgraphTokenRow,
  labelSubgraphPairRow,
  labelSubgraphSwapRow,
  buildTokenInfoPayload,
} from "./helpers.js";

const versionSchema = z
  .enum(["v1", "v2"])
  .default("v2")
  .describe("PulseX subgraph version");

/**
 * Register analytics tools: free-tier openpulsechain-parity tools,
 * advanced public-data tools, DexScreener market data, Tier A
 * (BlockScout/DefiLlama/PulseSwap), and low-level PulseX subgraph helpers.
 */
export function registerAnalyticsTools(
  server: McpServer,
  config: AppConfig,
): void {
  // Free-tier named tools (get_token_price, get_token_info, …)
  registerFreeTierAnalyticsTools(server, config);
  // Advanced / pro-parity tools (risk, smart money, wallets) — public data only
  registerAdvancedAnalyticsTools(server, config);
  // DexScreener public API (PulseChain defaults, no API key)
  registerDexScreenerTools(server, config);
  // Consolidated PHIAT research dashboard (address-first, read-only)
  registerPhiatDashboardTool(server, config);
  // Research-only Piteas eUSDC -> PHIAT quote-curve planner
  registerPiteasAccumulationPlanTool(server, config);
  // Tier A: BlockScout enrichment + DefiLlama + PulseSwap quotes
  registerTierATools(server, config);
  // Tier B: PulseX factory/day/LP gaps + HEX stake reads (bridge flows skipped)
  registerTierBTools(server, config);

  // Low-level subgraph access (kept for power users / debugging)
  registerTool(server, config, {
    name: "pulsex_subgraph_meta",
    description:
      "Fetch PulseX subgraph _meta (indexing status). Uses public graph.pulsechain.com endpoints by default.",
    category: "analytics",
    inputSchema: { version: versionSchema },
    handler: async (args, cfg) => {
      const data = await fetchSubgraphMeta(
        cfg,
        (args.version as "v1" | "v2") ?? "v2",
      );
      return ok(data);
    },
  });

  registerTool(server, config, {
    name: "pulsex_token",
    description: "PulseX subgraph token entity by address.",
    category: "analytics",
    inputSchema: {
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      version: versionSchema,
    },
    handler: async (args, cfg) =>
      ok(
        await fetchToken(
          cfg,
          args.address as string,
          (args.version as "v1" | "v2") ?? "v2",
        ),
      ),
  });

  registerTool(server, config, {
    name: "pulsex_pair",
    description: "PulseX subgraph pair/pool entity by pair address.",
    category: "analytics",
    inputSchema: {
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      version: versionSchema,
    },
    handler: async (args, cfg) =>
      ok(
        await fetchPair(
          cfg,
          args.address as string,
          (args.version as "v1" | "v2") ?? "v2",
        ),
      ),
  });

  registerTool(server, config, {
    name: "pulsex_swaps",
    description:
      "Recent swaps from PulseX subgraph (optionally filtered by pair). " +
      "Raw subgraph power tool: catalogued pair sides get display_symbol/token_origin. " +
      "Prefer get_recent_swaps for filtered views; use addresses for identity.",
    category: "analytics",
    inputSchema: {
      pair: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .optional(),
      first: z.number().int().min(1).max(100).default(20),
      skip: z.number().int().min(0).default(0),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const raw = (await fetchSwaps(cfg, {
        pair: args.pair as string | undefined,
        first: (args.first as number) ?? 20,
        skip: (args.skip as number) ?? 0,
        version: (args.version as "v1" | "v2") ?? "v2",
      })) as { swaps?: unknown[] } | unknown[];
      const swapsArr = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { swaps?: unknown[] })?.swaps)
          ? ((raw as { swaps: unknown[] }).swaps ?? [])
          : [];
      if (Array.isArray(raw)) {
        return ok(swapsArr.map((s) => labelSubgraphSwapRow(s as never)));
      }
      return ok({
        ...(raw as object),
        swaps: swapsArr.map((s) => labelSubgraphSwapRow(s as never)),
        label_note:
          "display_symbol/token_origin on pair sides only for catalogued addresses",
      });
    },
  });

  registerTool(server, config, {
    name: "pulsex_token_day_data",
    description: "Daily volume/liquidity/price history for a token.",
    category: "analytics",
    inputSchema: {
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      first: z.number().int().min(1).max(90).default(30),
      version: versionSchema,
    },
    handler: async (args, cfg) =>
      ok(
        await fetchTokenDayData(
          cfg,
          args.address as string,
          (args.first as number) ?? 30,
          (args.version as "v1" | "v2") ?? "v2",
        ),
      ),
  });

  registerTool(server, config, {
    name: "pulsex_pair_day_data",
    description: "Daily volume/reserves history for a pair.",
    category: "analytics",
    inputSchema: {
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      first: z.number().int().min(1).max(90).default(30),
      version: versionSchema,
    },
    handler: async (args, cfg) =>
      ok(
        await fetchPairDayData(
          cfg,
          args.address as string,
          (args.first as number) ?? 30,
          (args.version as "v1" | "v2") ?? "v2",
        ),
      ),
  });

  registerTool(server, config, {
    name: "pulsex_top_tokens",
    description:
      "Top tokens by volume, liquidity, or tx count (raw PulseX subgraph). " +
      "Catalogued addresses get display_symbol/token_origin (e.g. pHEX, eUSDC) — never invented. " +
      "Prefer get_top_tokens for free-tier ranking with liquidity demotion. " +
      "Ranking is heuristic/directional — not settlement-grade.",
    category: "analytics",
    inputSchema: {
      first: z.number().int().min(1).max(100).default(20),
      orderBy: z
        .enum(["tradeVolumeUSD", "totalLiquidity", "totalTransactions"])
        .default("tradeVolumeUSD"),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const raw = await fetchTopTokens(cfg, {
        first: (args.first as number) ?? 20,
        orderBy: args.orderBy as
          | "tradeVolumeUSD"
          | "totalLiquidity"
          | "totalTransactions"
          | undefined,
        version: (args.version as "v1" | "v2") ?? "v2",
      });
      const tokens = Array.isArray((raw as { tokens?: unknown[] })?.tokens)
        ? (raw as { tokens: Array<{ id?: string; symbol?: string }> }).tokens.map(
            (t) => labelSubgraphTokenRow(t),
          )
        : [];
      return ok({
        ...(raw as object),
        tokens,
        label_note:
          "display_symbol/token_origin attached only for catalogued addresses",
      });
    },
  });

  registerTool(server, config, {
    name: "pulsex_top_pairs",
    description:
      "Top pairs by volume, liquidity (reserveUSD), or tx count (raw PulseX subgraph). " +
      "Catalogued token sides get display_symbol/origin — never invented. " +
      "Prefer get_top_pairs for free-tier ranking with sanitized liquidity. " +
      "Ranking is heuristic/directional — not settlement-grade.",
    category: "analytics",
    inputSchema: {
      first: z.number().int().min(1).max(100).default(20),
      orderBy: z
        .enum(["volumeUSD", "reserveUSD", "totalTransactions"])
        .default("volumeUSD"),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const raw = await fetchTopPairs(cfg, {
        first: (args.first as number) ?? 20,
        orderBy: args.orderBy as
          | "volumeUSD"
          | "reserveUSD"
          | "totalTransactions"
          | undefined,
        version: (args.version as "v1" | "v2") ?? "v2",
      });
      const pairs = Array.isArray((raw as { pairs?: unknown[] })?.pairs)
        ? (
            raw as {
              pairs: Array<{
                id?: string;
                token0?: { id?: string; symbol?: string };
                token1?: { id?: string; symbol?: string };
              }>;
            }
          ).pairs.map((p) => labelSubgraphPairRow(p))
        : [];
      return ok({
        ...(raw as object),
        pairs,
        label_note:
          "token0/1 display_symbol/origin attached only for catalogued addresses",
      });
    },
  });
}
