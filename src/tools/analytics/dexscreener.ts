/**
 * PulseChain-first DexScreener market data tools (public API, no key).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  DEFAULT_DEXSCREENER_CHAIN,
  getDexScreenerBoostsLatest,
  getDexScreenerPair,
  getDexScreenerProfilesLatest,
  getDexScreenerTokenPairs,
  getDexScreenerTokens,
  searchDexScreenerPairs,
} from "../../data/dexscreener.js";
import type { AppConfig } from "../../types.js";
import { ok } from "../../utils/result.js";
import { registerTool } from "../define.js";

const chainIdSchema = z
  .string()
  .min(1)
  .default(DEFAULT_DEXSCREENER_CHAIN)
  .describe(
    `DexScreener chain id (default: ${DEFAULT_DEXSCREENER_CHAIN}). Override only for cross-chain lookups.`,
  );

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Expected 0x + 40 hex chars");

/**
 * Register DexScreener analytics tools. All read-only; fail-soft on upstream issues.
 */
export function registerDexScreenerTools(
  server: McpServer,
  config: AppConfig,
): void {
  registerTool(server, config, {
    name: "dexscreener_search",
    description:
      "Search DexScreener pairs/tokens — **discovery-only** (defaults PulseChain-only). " +
      "Upstream may return empty or spoof-dominated sets; always read catalog_coverage and " +
      "recommended_address_followups (token and/or known major pair → dexscreener_pair). " +
      "Never invent pairs from guidance. Catalogued addresses rank ahead of same-ticker unknowns; " +
      "search_flags annotate spoofs (no invented origin). " +
      "For identity prefer dexscreener_token_pairs / dexscreener_pair / get_token_info with a verified 0x. " +
      "For price/size prefer get_token_price or address DexScreener. Fail-soft on rate limits.",
    category: "analytics",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .max(200)
        .describe("Search text: symbol, name, or 0x address (symbol is discovery-only)"),
      chainId: chainIdSchema.optional(),
      pulsechainOnly: z
        .boolean()
        .default(true)
        .describe("When true (default), keep only pairs on the selected chain"),
    },
    handler: async (args, cfg) => {
      const result = await searchDexScreenerPairs(cfg, String(args.query), {
        chainId: (args.chainId as string | undefined) ?? DEFAULT_DEXSCREENER_CHAIN,
        pulsechainOnly: args.pulsechainOnly !== false,
      });
      return ok(result);
    },
  });

  registerTool(server, config, {
    name: "dexscreener_pair",
    description:
      "Get a single DexScreener pair by pair address. chainId defaults to pulsechain. " +
      "Returns price, liquidity, volume, and origin labels on known tokens.",
    category: "analytics",
    inputSchema: {
      pairAddress: addressSchema.describe("LP / pair contract address"),
      chainId: chainIdSchema.optional(),
    },
    handler: async (args, cfg) => {
      const result = await getDexScreenerPair(cfg, String(args.pairAddress), {
        chainId: (args.chainId as string | undefined) ?? DEFAULT_DEXSCREENER_CHAIN,
      });
      return ok(result);
    },
  });

  registerTool(server, config, {
    name: "dexscreener_token_pairs",
    description:
      "List DexScreener pools/pairs for a token address on PulseChain (default). " +
      "Useful market overview for PLSX, HEX, bridged DAI, etc. Origin labels attached when known.",
    category: "analytics",
    inputSchema: {
      tokenAddress: addressSchema.describe("PRC-20 token contract address"),
      chainId: chainIdSchema.optional(),
    },
    handler: async (args, cfg) => {
      const result = await getDexScreenerTokenPairs(
        cfg,
        String(args.tokenAddress),
        {
          chainId:
            (args.chainId as string | undefined) ?? DEFAULT_DEXSCREENER_CHAIN,
        },
      );
      return ok(result);
    },
  });

  registerTool(server, config, {
    name: "dexscreener_tokens",
    description:
      "Get DexScreener pairs for one or more token addresses (comma-separated or array, max 30). " +
      "chainId defaults to pulsechain.",
    category: "analytics",
    inputSchema: {
      tokenAddresses: z
        .union([
          z.array(addressSchema).min(1).max(30),
          z.string().min(42),
        ])
        .describe("Token address(es): array or comma-separated 0x strings"),
      chainId: chainIdSchema.optional(),
    },
    handler: async (args, cfg) => {
      let tokens: string[];
      const raw = args.tokenAddresses;
      if (Array.isArray(raw)) {
        tokens = raw.map(String);
      } else {
        tokens = String(raw)
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const result = await getDexScreenerTokens(cfg, tokens, {
        chainId: (args.chainId as string | undefined) ?? DEFAULT_DEXSCREENER_CHAIN,
      });
      return ok(result);
    },
  });

  registerTool(server, config, {
    name: "dexscreener_boosts_latest",
    description:
      "Latest DexScreener token boosts (promoted tokens). Defaults to PulseChain-only. " +
      "Optional market-intel signal; not a recommendation. Fail-soft on upstream errors.",
    category: "analytics",
    inputSchema: {
      chainId: chainIdSchema.optional(),
      pulsechainOnly: z.boolean().default(true),
    },
    handler: async (args, cfg) => {
      const result = await getDexScreenerBoostsLatest(cfg, {
        chainId: (args.chainId as string | undefined) ?? DEFAULT_DEXSCREENER_CHAIN,
        pulsechainOnly: args.pulsechainOnly !== false,
      });
      return ok(result);
    },
  });

  registerTool(server, config, {
    name: "dexscreener_profiles_latest",
    description:
      "Latest DexScreener token profiles. Defaults to PulseChain-only. " +
      "Fail-soft on upstream errors.",
    category: "analytics",
    inputSchema: {
      chainId: chainIdSchema.optional(),
      pulsechainOnly: z.boolean().default(true),
    },
    handler: async (args, cfg) => {
      const result = await getDexScreenerProfilesLatest(cfg, {
        chainId: (args.chainId as string | undefined) ?? DEFAULT_DEXSCREENER_CHAIN,
        pulsechainOnly: args.pulsechainOnly !== false,
      });
      return ok(result);
    },
  });
}
