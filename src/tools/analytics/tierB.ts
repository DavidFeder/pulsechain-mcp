/**
 * Tier B public RO tools: deeper PulseX surfaces + HEX stake reads.
 * Bridge flow tools intentionally omitted (no stable public indexer) —
 * see CHANGELOG residual notes; get_bridge_stats remains liquidity-proxy-only.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  getDexDayDataSoft,
  getFactoryMetricsSoft,
  getLpEventsSoft,
} from "../../data/subgraph.js";
import {
  getHexGlobalState,
  getHexStakesForAddress,
} from "../../data/hexStake.js";
import type { AppConfig } from "../../types.js";
import { ok } from "../../utils/result.js";
import { registerTool } from "../define.js";

const versionSchema = z
  .enum(["v1", "v2"])
  .default("v2")
  .describe("PulseX subgraph version");

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Expected 0x + 40 hex chars");

/**
 * Register Tier B analytics tools (PulseX gaps + HEX stakes).
 */
export function registerTierBTools(
  server: McpServer,
  config: AppConfig,
): void {
  // ── PulseX factory ─────────────────────────────────────────────────────
  registerTool(server, config, {
    name: "pulsex_factory",
    description:
      "PulseX factory-level metrics (total pairs, cumulative volume/liquidity, txs) " +
      "from public pulseXFactories. source=pulsex-subgraph. Fail-soft. Distinct from " +
      "get_market_overview (no day series / gainers fan-out).",
    category: "analytics",
    inputSchema: { version: versionSchema },
    handler: async (args, cfg) => {
      const result = await getFactoryMetricsSoft(
        cfg,
        (args.version as "v1" | "v2") ?? "v2",
      );
      return ok(result);
    },
  });

  // ── PulseX DEX day history ─────────────────────────────────────────────
  registerTool(server, config, {
    name: "pulsex_dex_day_data",
    description:
      "Protocol-level PulseX day history (pulsexDayDatas): daily volume, TVL, " +
      "cumulative series. Richer dedicated history than get_market_overview's short sample. " +
      "source=pulsex-subgraph. Fail-soft. For token/pair day series use " +
      "pulsex_token_day_data / pulsex_pair_day_data.",
    category: "analytics",
    inputSchema: {
      first: z
        .number()
        .int()
        .min(1)
        .max(90)
        .default(30)
        .describe("Number of days (default 30, max 90)"),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const result = await getDexDayDataSoft(
        cfg,
        (args.first as number | undefined) ?? 30,
        (args.version as "v1" | "v2") ?? "v2",
      );
      return ok(result);
    },
  });

  // ── PulseX LP mint/burn events ─────────────────────────────────────────
  registerTool(server, config, {
    name: "pulsex_lp_events",
    description:
      "Recent PulseX LP mint and burn events (optional pair filter). LP-oriented " +
      "read for add/remove liquidity flow — not a wallet LP position ledger. " +
      "source=pulsex-subgraph. Fail-soft. amountUSD can be noisy for junk pairs.",
    category: "analytics",
    inputSchema: {
      pair: addressSchema
        .optional()
        .describe("Optional pair address to scope events"),
      first: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe("Max events per mint/burn query (default 20)"),
      minUsd: z
        .number()
        .min(0)
        .default(0)
        .describe("Min amountUSD filter when pair omitted (default 0)"),
      includeMints: z.boolean().default(true),
      includeBurns: z.boolean().default(true),
      version: versionSchema,
    },
    handler: async (args, cfg) => {
      const result = await getLpEventsSoft(cfg, {
        pair: args.pair as string | undefined,
        first: (args.first as number | undefined) ?? 20,
        minUsd: (args.minUsd as number | undefined) ?? 0,
        includeMints: args.includeMints !== false,
        includeBurns: args.includeBurns !== false,
        version: (args.version as "v1" | "v2") ?? "v2",
      });
      return ok(result);
    },
  });

  // ── HEX global stake state ─────────────────────────────────────────────
  registerTool(server, config, {
    name: "hex_global_state",
    description:
      "On-chain HEX global stake state (currentDay, shareRate, lockedHeartsTotal, …) " +
      "via multi-RPC. Default contract=phex (state-fork stakeable HEX). " +
      "eHEX is bridged ERC-20 only — soft-fails with clear note. source=hex-rpc. " +
      "Not a price oracle. Read-only; never starts/ends stakes.",
    category: "analytics",
    inputSchema: {
      contract: z
        .string()
        .min(1)
        .max(66)
        .default("phex")
        .describe('phex | ehex | 0x address (default "phex")'),
    },
    handler: async (args, cfg) => {
      const result = await getHexGlobalState(
        cfg,
        (args.contract as string | undefined) ?? "phex",
      );
      return ok(result);
    },
  });

  // ── HEX stakes for address ─────────────────────────────────────────────
  registerTool(server, config, {
    name: "hex_stakes_for_address",
    description:
      "List on-chain HEX stakes for a staker address (stakeCount + stakeLists). " +
      "Default contract=phex. eHEX soft-fails (no stake interface). Hearts use 8 decimals. " +
      "source=hex-rpc. Advisory only — no price; no stake write. Fail-soft on RPC errors.",
    category: "analytics",
    inputSchema: {
      staker: addressSchema.describe("Staker EOA/contract address"),
      contract: z
        .string()
        .min(1)
        .max(66)
        .default("phex")
        .describe('phex | ehex | 0x address (default "phex")'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe("Max stakes to return (default 25)"),
    },
    handler: async (args, cfg) => {
      const result = await getHexStakesForAddress(cfg, String(args.staker), {
        contract: (args.contract as string | undefined) ?? "phex",
        limit: (args.limit as number | undefined) ?? 25,
      });
      return ok(result);
    },
  });
}
