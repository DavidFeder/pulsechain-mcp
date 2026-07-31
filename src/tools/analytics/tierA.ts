/**
 * Tier A public RO tools: BlockScout enrichment, DefiLlama summaries,
 * PulseSwap quotes, Piteas + Switch.win aggregator quote + prepare-intent.
 * Switch requires optional SWITCH_API_KEY env; fail-soft; wallets never
 * required for quote/prepare (no auto-broadcast).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  getAddressActivitySoft,
  getContractAbiSoft,
  getLogsSoft,
  getTokenOverviewSoft,
} from "../../data/explorer.js";
import {
  getPulseChainProtocols,
  getPulseChainTvl,
} from "../../data/defillama.js";
import {
  PULSESWAP_NATIVE_PLS,
  PULSESWAP_PLATFORMS,
  getPulseSwapQuote,
} from "../../data/pulseswap.js";
import {
  getPiteasQuote,
  preparePiteasSwap,
  type PiteasQuoteData,
} from "../../data/piteas.js";
import {
  getSwitchQuote,
  prepareSwitchSwap,
  type SwitchQuoteData,
} from "../../data/switch.js";
import { tokenLabelFields } from "../../constants.js";
import type { AppConfig } from "../../types.js";
import { ok } from "../../utils/result.js";
import { registerTool } from "../define.js";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Expected 0x + 40 hex chars");

const platformSchema = z
  .enum([
    "pulsex_v1",
    "pulsex_v2",
    "pulsex_stable",
    "9inch_v2",
    "9inch_v3",
    "9mm_v2",
    "9mm_v3",
    "phux_v2",
    "tide_v3",
    "mixed",
  ])
  .default("mixed")
  .describe(
    `PulseSwap platform (default mixed). One of: ${PULSESWAP_PLATFORMS.join(", ")}`,
  );

/**
 * Register Tier A analytics tools (BlockScout / DefiLlama / PulseSwap).
 */
export function registerTierATools(
  server: McpServer,
  config: AppConfig,
): void {
  // ── BlockScout: token overview ─────────────────────────────────────────
  registerTool(server, config, {
    name: "blockscout_token_overview",
    description:
      "Richer BlockScout token overview for a PRC-20: metadata, supply/holders counters, " +
      "and a top-holders sample when available. Public scan.pulsechain.com (v1+v2); " +
      "fail-soft with source labels. Not a price oracle.",
    category: "analytics",
    inputSchema: {
      contractAddress: addressSchema.describe("Token contract address"),
      holderLimit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Max top holders to include (default 10)"),
    },
    handler: async (args, cfg) => {
      const contractAddress = String(args.contractAddress);
      const result = await getTokenOverviewSoft(cfg, contractAddress, {
        holderLimit: (args.holderLimit as number | undefined) ?? 10,
      });
      const identity = tokenLabelFields(contractAddress) ?? {};
      return ok({ ...result, ...identity });
    },
  });

  // ── BlockScout: verified ABI ───────────────────────────────────────────
  registerTool(server, config, {
    name: "blockscout_contract_abi",
    description:
      "Fetch verified contract ABI (+ light verification meta) from BlockScout. " +
      "Fail-soft when unverified or explorer errors. source=blockscout.",
    category: "analytics",
    inputSchema: {
      address: addressSchema.describe("Contract address"),
    },
    handler: async (args, cfg) => {
      const result = await getContractAbiSoft(cfg, String(args.address));
      return ok(result);
    },
  });

  // ── BlockScout: address activity ───────────────────────────────────────
  registerTool(server, config, {
    name: "blockscout_address_activity",
    description:
      "Recent ERC-20 token transfers and internal transactions for an address " +
      "(BlockScout samples). Fail-soft; paginated. Prefer over scraping HTML.",
    category: "analytics",
    inputSchema: {
      address: addressSchema,
      contractAddress: addressSchema
        .optional()
        .describe("Optional token filter for transfers"),
      page: z.number().int().min(1).default(1),
      offset: z.number().int().min(1).max(50).default(10),
      includeInternal: z
        .boolean()
        .default(true)
        .describe("Include internal txs (default true)"),
    },
    handler: async (args, cfg) => {
      const result = await getAddressActivitySoft(cfg, String(args.address), {
        page: (args.page as number | undefined) ?? 1,
        offset: (args.offset as number | undefined) ?? 10,
        contractAddress: args.contractAddress as string | undefined,
        includeInternal: args.includeInternal !== false,
      });
      return ok(result);
    },
  });

  // ── BlockScout: logs (soft) ────────────────────────────────────────────
  registerTool(server, config, {
    name: "blockscout_event_logs",
    description:
      "Query event logs via BlockScout explorer API (address/topics/blocks) with " +
      "fail-soft envelope (source=blockscout). Prefer tight block ranges — wide " +
      "scans may time out or soft-fail upstream.",
    category: "analytics",
    inputSchema: {
      address: addressSchema.optional(),
      fromBlock: z.union([z.number(), z.string()]).optional(),
      toBlock: z.union([z.number(), z.string()]).optional(),
      topic0: z.string().optional(),
      page: z.number().int().min(1).default(1),
      offset: z.number().int().min(1).max(200).default(50),
    },
    handler: async (args, cfg) => {
      const result = await getLogsSoft(cfg, {
        address: args.address as string | undefined,
        fromBlock: args.fromBlock as number | string | undefined,
        toBlock: args.toBlock as number | string | undefined,
        topic0: args.topic0 as string | undefined,
        page: (args.page as number | undefined) ?? 1,
        offset: (args.offset as number | undefined) ?? 50,
      });
      return ok(result);
    },
  });

  // ── DefiLlama: chain TVL ───────────────────────────────────────────────
  registerTool(server, config, {
    name: "defillama_pulsechain_tvl",
    description:
      "DefiLlama high-level PulseChain chain TVL snapshot (keyless api.llama.fi). " +
      "Advisory third-party estimate; source=defillama. Fail-soft on upstream issues.",
    category: "analytics",
    inputSchema: {},
    handler: async (_args, cfg) => {
      const result = await getPulseChainTvl(cfg);
      return ok(result);
    },
  });

  // ── DefiLlama: top protocols ───────────────────────────────────────────
  registerTool(server, config, {
    name: "defillama_pulsechain_protocols",
    description:
      "Top DefiLlama protocols with PulseChain exposure (chain key usually \"Pulse\"). " +
      "Optional category filter (e.g. Dexs). Advisory; source=defillama; fail-soft.",
    category: "analytics",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max protocols to return (default 20)"),
      category: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('Optional category filter, e.g. "Dexs", "Lending", "CDP"'),
    },
    handler: async (args, cfg) => {
      const result = await getPulseChainProtocols(cfg, {
        limit: (args.limit as number | undefined) ?? 20,
        category: args.category as string | undefined,
      });
      return ok(result);
    },
  });

  // ── PulseSwap: multi-DEX quote ─────────────────────────────────────────
  registerTool(server, config, {
    name: "pulseswap_quote",
    description:
      "PulseSwap **multi-DEX** advisory quote on PulseChain (chainId 369). Prefer this over " +
      "pulsex_quote when comparing routes across DEXes. Public quotes.pulseswap.io. " +
      "Returns amountIn/amountOut (amountIn echoes request when upstream zeros it), platform, " +
      "gasEstimate when available. quoteReady = advisory amountOut only; priceUsdReady requires " +
      "positive amountOutUSD; executionReady is always false (this MCP does not broadcast). " +
      "Advisory only — does NOT execute swaps or require wallets. " +
      "Use 0x000…000 for native PLS. Fail-soft on validation/upstream. " +
      "Not a substitute for address-based identity (dexscreener_token_pairs / get_token_info).",
    category: "analytics",
    inputSchema: {
      fromToken: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .describe(
          `Source token (0x…). Use ${PULSESWAP_NATIVE_PLS} for native PLS`,
        ),
      toToken: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .describe(
          `Destination token (0x…). Use ${PULSESWAP_NATIVE_PLS} for native PLS`,
        ),
      amountIn: z
        .string()
        .regex(/^\d+$/)
        .describe("Amount in wei / smallest unit (integer string)"),
      platform: platformSchema.optional(),
      slippage: z
        .number()
        .min(0)
        .max(100)
        .default(0.5)
        .describe("Max slippage 0–100 (default 0.5)"),
      mode: z
        .enum(["standard", "advanced"])
        .default("standard")
        .describe("standard (fast) or advanced (deeper routes)"),
      userAddress: addressSchema
        .optional()
        .describe(
          "Optional — when set, upstream may return advisory tx calldata (not executed here)",
        ),
    },
    handler: async (args, cfg) => {
      const result = await getPulseSwapQuote(cfg, {
        fromToken: String(args.fromToken),
        toToken: String(args.toToken),
        amountIn: String(args.amountIn),
        platform: (args.platform as string | undefined) ?? "mixed",
        slippage: (args.slippage as number | undefined) ?? 0.5,
        mode: (args.mode as "standard" | "advanced" | undefined) ?? "standard",
        userAddress: args.userAddress as string | undefined,
      });
      return ok(result);
    },
  });

  // ── Piteas: aggregator quote (preferred assist) ────────────────────────
  registerTool(server, config, {
    name: "piteas_quote",
    description:
      "Piteas **DEX aggregator** advisory quote on PulseChain (public sdk.piteas.io). " +
      "Preferred aggregator assist for multi-hop routes — **not** a guaranteed best-price oracle. " +
      "Use **PLS** (or native/0x0) for native token. Accepts 0x addresses or catalogued symbols (e.g. eUSDC). " +
      "Returns expected/min out, PiteasRouter target, valueWei, gas estimate, route summary, " +
      "and exact methodParameters.calldata (never invented). Fail-soft on 429/5xx/malformed. " +
      "Advisory only — does NOT execute or require wallets. Prepare with piteas_prepare_swap, then wallet propose/execute.",
    category: "analytics",
    inputSchema: {
      tokenIn: z
        .string()
        .min(1)
        .describe(
          "Source token: PLS / native / 0x0 for native PLS, 0x address, or catalogued symbol (eUSDC, WPLS, …)",
        ),
      tokenOut: z
        .string()
        .min(1)
        .describe(
          "Destination token: PLS / native / 0x0, 0x address, or catalogued symbol",
        ),
      amount: z
        .string()
        .regex(/^\d+$/)
        .describe("Amount in wei / smallest units (integer string)"),
      allowedSlippage: z
        .number()
        .min(0)
        .max(100)
        .default(0.5)
        .describe("Max slippage 0–100 (default 0.5)"),
      account: addressSchema
        .optional()
        .describe(
          "Optional recipient/account (recommended for executable routes; defaults to msg.sender on-chain)",
        ),
    },
    handler: async (args, cfg) => {
      const result = await getPiteasQuote(cfg, {
        tokenIn: String(args.tokenIn),
        tokenOut: String(args.tokenOut),
        amount: String(args.amount),
        allowedSlippage: (args.allowedSlippage as number | undefined) ?? 0.5,
        account: args.account as string | undefined,
      });
      return ok(result);
    },
  });

  // ── Piteas: prepare non-broadcast swap intent ──────────────────────────
  registerTool(server, config, {
    name: "piteas_prepare_swap",
    description:
      "Turn a **successful** piteas_quote payload into an agent-ready **non-broadcast** tx intent: " +
      "to = PiteasRouter, data = exact upstream methodParameters.calldata, " +
      "intent.valueWei (wei) + intent.valuePls (human PLS for propose_agent_tx — never pass wei as valuePls). " +
      "Includes review fields (tokenIn/out, amountIn, amountOutMin, recipient, slippage). " +
      "Does NOT sign or broadcast — use propose_agent_tx({ valuePls: intent.valuePls, data, to }) → review → execute. " +
      "Local decode may show unknown selector; that is expected. Never invents routes/calldata.",
    category: "analytics",
    inputSchema: {
      quote: z
        .any()
        .describe(
          "Piteas quote `data` object from a successful piteas_quote (or full success envelope with data)",
        ),
      account: addressSchema
        .optional()
        .describe("Optional recipient override for review fields only (does not rewrite calldata)"),
    },
    handler: async (args) => {
      const raw = args.quote as unknown;
      let data: PiteasQuoteData | null = null;
      if (raw && typeof raw === "object") {
        const rec = raw as Record<string, unknown>;
        // Accept full success envelope { ok, data } or bare data
        if (rec.data && typeof rec.data === "object") {
          data = rec.data as PiteasQuoteData;
        } else if (rec.methodParameters || rec.router) {
          data = raw as PiteasQuoteData;
        }
      }
      if (!data) {
        return ok({
          ok: false,
          source: "piteas",
          advisory: true,
          broadcast: false,
          reason:
            "quote must be a successful piteas_quote data object (or { ok:true, data }) with methodParameters",
        });
      }
      const prepared = preparePiteasSwap(data, {
        account: args.account as string | undefined,
      });
      return ok(prepared);
    },
  });

  // ── Switch.win: aggregator quote ───────────────────────────────────────
  registerTool(server, config, {
    name: "switch_quote",
    description:
      "Switch.win **DEX aggregator** advisory quote on PulseChain (quote.switch.win). " +
      "**Operator-gated auth:** requires **SWITCH_API_KEY** in server env (x-api-key). " +
      "Public unauthenticated access returns HTTP 401. Key access is **not self-serve** for agents — " +
      "the human operator must request a key at https://docs.switch.win/aggregator/request-api-key " +
      "and configure SWITCH_API_KEY locally (never commit keys). " +
      "If authRequired/missing key: tell the operator; prefer **piteas_quote** (keyless) until configured. " +
      "Native PLS via sentinel 0xEeee…eEee (aliases: PLS / native / 0x0). " +
      "Accepts 0x addresses or catalogued symbols (e.g. eUSDC). " +
      "Returns expected/min out, taxes/fees when present, and raw tx fields (to/data/value) when sender is set. " +
      "**Never hardcodes router** — use upstream tx.to. Fail-soft on 401/403/429/5xx/malformed. " +
      "Advisory only — does NOT execute. Prepare with switch_prepare_swap, then wallet propose/execute. " +
      "Not a guaranteed best-price oracle.",
    category: "analytics",
    inputSchema: {
      tokenIn: z
        .string()
        .min(1)
        .describe(
          "Source token: PLS / native / 0x0 / Switch native sentinel for native PLS, 0x address, or catalogued symbol (eUSDC, WPLS, …)",
        ),
      tokenOut: z
        .string()
        .min(1)
        .describe(
          "Destination token: PLS / native / 0x0 / sentinel, 0x address, or catalogued symbol",
        ),
      amount: z
        .string()
        .regex(/^\d+$/)
        .describe("Amount in wei / smallest units (integer string)"),
      allowedSlippage: z
        .number()
        .min(0)
        .max(50)
        .default(0.5)
        .describe("Max slippage percent 0–50 (default 0.5 → 50 bps for Switch API)"),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe("Optional explicit slippage in basis points (overrides allowedSlippage)"),
      sender: addressSchema
        .optional()
        .describe(
          "Sender wallet — **required** for executable tx calldata in the response",
        ),
      account: addressSchema
        .optional()
        .describe("Alias for sender (if sender omitted)"),
      receiver: addressSchema
        .optional()
        .describe("Optional custom recipient (defaults to sender upstream)"),
      feeOnOutput: z
        .boolean()
        .optional()
        .describe("When true, prefer fee-on-output routing (txFeeOnOutput)"),
    },
    handler: async (args, cfg) => {
      const result = await getSwitchQuote(cfg, {
        tokenIn: String(args.tokenIn),
        tokenOut: String(args.tokenOut),
        amount: String(args.amount),
        allowedSlippage: (args.allowedSlippage as number | undefined) ?? 0.5,
        slippageBps: args.slippageBps as number | undefined,
        sender: args.sender as string | undefined,
        account: args.account as string | undefined,
        receiver: args.receiver as string | undefined,
        feeOnOutput: args.feeOnOutput as boolean | undefined,
      });
      return ok(result);
    },
  });

  // ── Switch.win: prepare non-broadcast swap intent ──────────────────────
  registerTool(server, config, {
    name: "switch_prepare_swap",
    description:
      "Turn a **successful** switch_quote payload into an agent-ready **non-broadcast** tx intent: " +
      "to = upstream tx.to (never hardcoded SwitchRouter), data = exact upstream tx.data, " +
      "intent.valueWei (wei) + intent.valuePls (human PLS for propose_agent_tx — never pass wei as valuePls). " +
      "Includes review fields (tokenIn/out, amountIn, minOut, recipient, slippage, taxes). " +
      "Does NOT sign or broadcast — use propose_agent_tx({ valuePls: intent.valuePls, data, to: intent.to }) → review → execute. " +
      "Depends on a prior switch_quote (operator SWITCH_API_KEY); if quote auth failed, ask the operator " +
      "(https://docs.switch.win/aggregator/request-api-key) or use piteas_quote / piteas_prepare_swap. " +
      "Local decode may show unknown selector; that is expected. Never invents routes/calldata.",
    category: "analytics",
    inputSchema: {
      quote: z
        .any()
        .describe(
          "Switch quote `data` object from a successful switch_quote (or full success envelope with data)",
        ),
      account: addressSchema
        .optional()
        .describe("Optional recipient override for review fields only (does not rewrite calldata)"),
      feeOnOutput: z
        .boolean()
        .optional()
        .describe("When true, use txFeeOnOutput if present on the quote"),
    },
    handler: async (args) => {
      const raw = args.quote as unknown;
      let data: SwitchQuoteData | null = null;
      if (raw && typeof raw === "object") {
        const rec = raw as Record<string, unknown>;
        if (rec.data && typeof rec.data === "object") {
          data = rec.data as SwitchQuoteData;
        } else if (rec.tx || rec.tokenInParam || rec.fromToken) {
          data = raw as SwitchQuoteData;
        }
      }
      if (!data) {
        return ok({
          ok: false,
          source: "switch",
          advisory: true,
          broadcast: false,
          reason:
            "quote must be a successful switch_quote data object (or { ok:true, data }) with upstream tx fields",
        });
      }
      const prepared = prepareSwitchSwap(data, {
        account: args.account as string | undefined,
        feeOnOutput: args.feeOnOutput as boolean | undefined,
      });
      return ok(prepared);
    },
  });
}
