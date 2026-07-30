/**
 * Interactive / chain tools for PulseChain MCP.
 * Uses viem + BlockScout explorer only (no openpulsechain dependency).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PULSECHAIN_CHAIN_ID } from "../../constants.js";
import {
  estimateGas,
  ethCall,
  getBlock,
  getBlockNumber,
  getGasPrice,
  getNativeBalance,
  getTransaction,
  getTransactionReceipt,
} from "../../data/rpc.js";
import { tokenLabelFields } from "../../constants.js";
import {
  batchErc20Balances,
  getErc20Metadata,
  knownCoreToken,
} from "../../data/multicall.js";
import {
  getAccountTokenTransfers,
  getAccountTxList,
  getLogs,
  getTokenInfo,
  getTokenInfoV2,
} from "../../data/explorer.js";
import type { AppConfig } from "../../types.js";
import { ok } from "../../utils/result.js";
import { ExplorerError } from "../../utils/errors.js";
import { registerTool } from "../define.js";
import {
  PREPARE_SWAP_WARNINGS,
  PREPARE_UNSIGNED_WARNING,
  opEstimateGas,
  opGetBalance,
  opGetBlock,
  opGetGasPrice,
  opGetPortfolio,
  opGetTokenBalance,
  opGetTransaction,
  opGetTransactionHistory,
  opPrepareSwap,
  opPrepareTransaction,
  opPulsexQuote,
  opReadContract,
} from "./operations.js";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("0x-prefixed address");

const txHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .describe("Transaction hash");

const tokenRefSchema = z
  .string()
  .min(1)
  .describe(
    "Token address (0x…) or core symbol (WPLS, HEX, PLSX, INC, DAI, USDC, USDT). " +
    "DAI = bridged real stable only; use PDAI/FORK_DAI or address 0x6B17… for forked pDAI (not $1). " +
    "Use 'PLS'/'native' for native PLS (maps to WPLS in paths).",
  );

/**
 * Register interactive chain tools + legacy pulsechain_* scaffold tools.
 */
export function registerChainTools(
  server: McpServer,
  config: AppConfig,
): void {
  // -------------------------------------------------------------------------
  // Interactive tools (canonical names)
  // -------------------------------------------------------------------------

  registerTool(server, config, {
    name: "get_balance",
    description:
      "Get native PLS balance for an address on PulseChain (wei + formatted).",
    category: "chain",
    inputSchema: {
      address: addressSchema,
    },
    handler: async (args, cfg) =>
      ok(await opGetBalance(cfg, args.address as string)),
  });

  registerTool(server, config, {
    name: "get_token_balance",
    description:
      "Get a single ERC-20 token balance plus on-chain metadata (name, symbol, decimals).",
    category: "chain",
    inputSchema: {
      address: addressSchema.describe("Owner wallet address"),
      token: tokenRefSchema,
    },
    handler: async (args, cfg) =>
      ok(
        await opGetTokenBalance(
          cfg,
          args.address as string,
          args.token as string,
        ),
      ),
  });

  registerTool(server, config, {
    name: "get_portfolio",
    description:
      "Multi-token balances for an address via multicall. Defaults to core PulseChain tokens " +
      "(WPLS, HEX, PLSX, INC, bridged DAI, USDC, USDT) plus native PLS. " +
      "Symbol DAI is bridged stable only; forked pDAI is labeled when its address appears.",
    category: "chain",
    inputSchema: {
      address: addressSchema,
      tokens: z
        .array(tokenRefSchema)
        .max(50)
        .optional()
        .describe("Optional token list; defaults to core tokens"),
      includeNative: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include native PLS balance (default true)"),
    },
    handler: async (args, cfg) =>
      ok(
        await opGetPortfolio(
          cfg,
          args.address as string,
          args.tokens as string[] | undefined,
          args.includeNative !== false,
        ),
      ),
  });

  registerTool(server, config, {
    name: "get_transaction",
    description:
      "Fetch a transaction by hash from RPC, including receipt and status when available.",
    category: "chain",
    inputSchema: {
      hash: txHashSchema,
    },
    handler: async (args, cfg) =>
      ok(await opGetTransaction(cfg, args.hash as string)),
  });

  registerTool(server, config, {
    name: "get_transaction_history",
    description:
      "Recent transactions for an address via BlockScout explorer API (api.scan.pulsechain.com).",
    category: "chain",
    inputSchema: {
      address: addressSchema,
      page: z.number().int().min(1).optional().default(1),
      offset: z.number().int().min(1).max(100).optional().default(20),
    },
    handler: async (args, cfg) =>
      ok(
        await opGetTransactionHistory(
          cfg,
          args.address as string,
          (args.page as number) ?? 1,
          (args.offset as number) ?? 20,
        ),
      ),
  });

  registerTool(server, config, {
    name: "get_gas_price",
    description:
      "Current gas price and EIP-1559 fee data (maxFeePerGas / maxPriorityFeePerGas when available).",
    category: "chain",
    inputSchema: {},
    handler: async (_args, cfg) => ok(await opGetGasPrice(cfg)),
  });

  registerTool(server, config, {
    name: "estimate_gas",
    description:
      "Estimate gas for a prepared call (to / data / value / from).",
    category: "chain",
    inputSchema: {
      to: addressSchema.optional(),
      from: addressSchema.optional(),
      data: z.string().optional().describe("Hex calldata"),
      value: z
        .string()
        .optional()
        .describe("Value in wei as decimal string"),
    },
    handler: async (args, cfg) =>
      ok(
        await opEstimateGas(cfg, {
          to: args.to as string | undefined,
          from: args.from as string | undefined,
          data: args.data as string | undefined,
          value: args.value as string | undefined,
        }),
      ),
  });

  registerTool(server, config, {
    name: "get_block",
    description: "Fetch a block by number (decimal string) or latest.",
    category: "chain",
    inputSchema: {
      blockNumber: z
        .string()
        .optional()
        .describe("Block number as decimal string; omit for latest"),
    },
    handler: async (args, cfg) =>
      ok(await opGetBlock(cfg, args.blockNumber as string | undefined)),
  });

  registerTool(server, config, {
    name: "read_contract",
    description:
      "Read a contract via viem readContract (eth_call). Provide ABI (JSON or human-readable fragment), function name, and args.",
    category: "chain",
    inputSchema: {
      address: addressSchema.describe("Contract address"),
      abi: z
        .union([z.string(), z.array(z.unknown())])
        .describe(
          "JSON ABI array, array of ABI items, or human-readable fragment string/array",
        ),
      functionName: z.string().min(1).describe("Function to call"),
      args: z
        .union([z.array(z.unknown()), z.string()])
        .optional()
        .describe("Function args as array or JSON array string"),
      blockNumber: z
        .string()
        .optional()
        .describe("Optional block number (decimal string)"),
    },
    handler: async (args, cfg) =>
      ok(
        await opReadContract(cfg, {
          address: args.address as string,
          abi: args.abi,
          functionName: args.functionName as string,
          args: args.args,
          blockNumber: args.blockNumber as string | undefined,
        }),
      ),
  });

  registerTool(server, config, {
    name: "prepare_transaction",
    description:
      "Build an unsigned transaction object (to, data, value, gas/fee estimates). " +
      "NEVER signs or broadcasts. " +
      PREPARE_UNSIGNED_WARNING,
    category: "chain",
    inputSchema: {
      to: addressSchema,
      data: z.string().optional().describe("Hex calldata (default 0x)"),
      value: z
        .string()
        .optional()
        .describe("Value in wei as decimal string (default 0)"),
      from: addressSchema.optional().describe("Optional sender for gas estimate"),
      gas: z
        .string()
        .optional()
        .describe("Optional gas limit; estimated if omitted"),
    },
    handler: async (args, cfg) =>
      ok(
        await opPrepareTransaction(cfg, {
          to: args.to as string,
          data: args.data as string | undefined,
          value: args.value as string | undefined,
          from: args.from as string | undefined,
          gas: args.gas as string | undefined,
        }),
        [PREPARE_UNSIGNED_WARNING],
      ),
  });

  registerTool(server, config, {
    name: "pulsex_quote",
    description:
      "Quote an exact-in swap via **PulseX router only** (getAmountsOut V1/V2). " +
      "Not multi-DEX — prefer pulseswap_quote for cross-DEX routes. " +
      "Uses WPLS hop when needed. Advisory size check; does not execute. " +
      "Token symbols: DAI/USDC/USDT = bridged only; use addresses for identity-sensitive paths.",
    category: "chain",
    inputSchema: {
      tokenIn: tokenRefSchema,
      tokenOut: tokenRefSchema,
      amountIn: z
        .string()
        .regex(/^\d+$/)
        .describe("Amount in token base units (integer string)"),
      path: z
        .array(addressSchema)
        .min(2)
        .optional()
        .describe("Optional explicit path; default tokenIn→WPLS→tokenOut"),
      version: z
        .enum(["v1", "v2"])
        .optional()
        .default("v2")
        .describe("PulseX router version (default v2)"),
    },
    handler: async (args, cfg) =>
      ok(
        await opPulsexQuote(cfg, {
          tokenIn: args.tokenIn as string,
          tokenOut: args.tokenOut as string,
          amountIn: args.amountIn as string,
          path: args.path as string[] | undefined,
          version: (args.version as "v1" | "v2" | undefined) ?? "v2",
        }),
      ),
  });

  registerTool(server, config, {
    name: "prepare_swap",
    description:
      "Build unsigned PulseX exact-in swap calldata (swapExactTokensForTokens / ETH variants). " +
      "NEVER signs or broadcasts. " +
      PREPARE_SWAP_WARNINGS.join(" "),
    category: "chain",
    inputSchema: {
      tokenIn: tokenRefSchema,
      tokenOut: tokenRefSchema,
      amountIn: z
        .string()
        .regex(/^\d+$/)
        .describe("Amount in base units (integer string)"),
      recipient: addressSchema.describe("Recipient of output tokens"),
      path: z.array(addressSchema).min(2).optional(),
      version: z.enum(["v1", "v2"]).optional().default("v2"),
      slippageBps: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .default(50)
        .describe("Slippage in basis points (default 50 = 0.5%)"),
      amountOutMin: z
        .string()
        .regex(/^\d+$/)
        .optional()
        .describe("Explicit min out (overrides slippage)"),
      deadline: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Unix deadline seconds (default now+20m)"),
      from: addressSchema.optional(),
      nativeIn: z
        .boolean()
        .optional()
        .describe("Treat input as native PLS (swapExactETHForTokens)"),
      nativeOut: z
        .boolean()
        .optional()
        .describe("Treat output as native PLS (swapExactTokensForETH)"),
    },
    handler: async (args, cfg) =>
      ok(
        await opPrepareSwap(cfg, {
          tokenIn: args.tokenIn as string,
          tokenOut: args.tokenOut as string,
          amountIn: args.amountIn as string,
          recipient: args.recipient as string,
          path: args.path as string[] | undefined,
          version: (args.version as "v1" | "v2" | undefined) ?? "v2",
          slippageBps: (args.slippageBps as number | undefined) ?? 50,
          amountOutMin: args.amountOutMin as string | undefined,
          deadline: args.deadline as number | undefined,
          from: args.from as string | undefined,
          nativeIn: args.nativeIn as boolean | undefined,
          nativeOut: args.nativeOut as boolean | undefined,
        }),
        [...PREPARE_SWAP_WARNINGS],
      ),
  });

  // -------------------------------------------------------------------------
  // Legacy scaffold tools (pulsechain_* names — kept for compatibility)
  // -------------------------------------------------------------------------

  registerTool(server, config, {
    name: "pulsechain_chain_id",
    description: "Return the PulseChain chain ID and configured RPC URL.",
    category: "chain",
    inputSchema: {},
    handler: async (_args, cfg) =>
      ok({
        chainId: PULSECHAIN_CHAIN_ID,
        rpcUrl: cfg.rpcUrl,
      }),
  });

  registerTool(server, config, {
    name: "pulsechain_block_number",
    description: "Fetch the latest block number from PulseChain RPC.",
    category: "chain",
    inputSchema: {},
    handler: async (_args, cfg) => {
      const n = await getBlockNumber(cfg);
      return ok({ blockNumber: n.toString() });
    },
  });

  registerTool(server, config, {
    name: "pulsechain_get_block",
    description: "Fetch a block by number (or latest). Returns summary fields.",
    category: "chain",
    inputSchema: {
      blockNumber: z
        .string()
        .optional()
        .describe("Block number as decimal string; omit for latest"),
    },
    handler: async (args, cfg) => {
      const raw = args.blockNumber as string | undefined;
      const block =
        raw === undefined || raw === ""
          ? await getBlock(cfg, "latest")
          : await getBlock(cfg, BigInt(raw));
      return ok(block);
    },
  });

  registerTool(server, config, {
    name: "pulsechain_get_balance",
    description: "Get native PLS balance for an address.",
    category: "chain",
    inputSchema: {
      address: addressSchema,
    },
    handler: async (args, cfg) => {
      const data = await getNativeBalance(cfg, args.address as string);
      return ok(data);
    },
  });

  registerTool(server, config, {
    name: "pulsechain_get_transaction",
    description: "Fetch a transaction by hash from RPC.",
    category: "chain",
    inputSchema: {
      hash: txHashSchema,
    },
    handler: async (args, cfg) => {
      const data = await getTransaction(cfg, args.hash as string);
      return ok(data);
    },
  });

  registerTool(server, config, {
    name: "pulsechain_get_receipt",
    description: "Fetch a transaction receipt by hash from RPC.",
    category: "chain",
    inputSchema: {
      hash: txHashSchema,
    },
    handler: async (args, cfg) => {
      const data = await getTransactionReceipt(cfg, args.hash as string);
      return ok(data);
    },
  });

  registerTool(server, config, {
    name: "pulsechain_estimate_gas",
    description: "Estimate gas for a call (to/data/value/from).",
    category: "chain",
    inputSchema: {
      to: addressSchema.optional(),
      from: addressSchema.optional(),
      data: z.string().optional().describe("Hex calldata"),
      value: z.string().optional().describe("Value in wei as decimal string"),
    },
    handler: async (args, cfg) => {
      const data = await estimateGas(cfg, {
        to: args.to as string | undefined,
        from: args.from as string | undefined,
        data: args.data as string | undefined,
        value: args.value as string | undefined,
      });
      return ok(data);
    },
  });

  registerTool(server, config, {
    name: "pulsechain_eth_call",
    description: "Execute eth_call against a contract (read-only).",
    category: "chain",
    inputSchema: {
      to: addressSchema,
      data: z.string().describe("Hex calldata"),
      from: addressSchema.optional(),
      value: z.string().optional(),
    },
    handler: async (args, cfg) => {
      const data = await ethCall(cfg, {
        to: args.to as string,
        data: args.data as string,
        from: args.from as string | undefined,
        value: args.value as string | undefined,
      });
      return ok(data);
    },
  });

  registerTool(server, config, {
    name: "pulsechain_gas_price",
    description: "Current gas price from PulseChain RPC.",
    category: "chain",
    inputSchema: {},
    handler: async (_args, cfg) => ok(await getGasPrice(cfg)),
  });

  registerTool(server, config, {
    name: "pulsechain_erc20_metadata",
    description: "Read ERC-20 name/symbol/decimals via multicall.",
    category: "chain",
    inputSchema: {
      token: addressSchema,
    },
    handler: async (args, cfg) =>
      ok(await getErc20Metadata(cfg, args.token as string)),
  });

  registerTool(server, config, {
    name: "pulsechain_erc20_balances",
    description:
      "Batch ERC-20 balanceOf for multiple tokens owned by one address (multicall).",
    category: "chain",
    inputSchema: {
      owner: addressSchema,
      tokens: z
        .array(addressSchema)
        .min(1)
        .max(50),
    },
    handler: async (args, cfg) => {
      const balances = await batchErc20Balances(
        cfg,
        args.owner as string,
        args.tokens as string[],
        true,
      );
      return ok({ balances });
    },
  });

  registerTool(server, config, {
    name: "pulsechain_account_txlist",
    description:
      "List recent transactions for an address via BlockScout explorer API.",
    category: "chain",
    inputSchema: {
      address: addressSchema,
      page: z.number().int().min(1).default(1),
      offset: z.number().int().min(1).max(100).default(10),
    },
    handler: async (args, cfg) => {
      const data = await getAccountTxList(
        cfg,
        args.address as string,
        (args.page as number) ?? 1,
        (args.offset as number) ?? 10,
      );
      return ok(data);
    },
  });

  registerTool(server, config, {
    name: "pulsechain_token_transfers",
    description: "ERC-20 token transfers for an address (explorer).",
    category: "chain",
    inputSchema: {
      address: addressSchema,
      contractAddress: addressSchema.optional(),
      page: z.number().int().min(1).default(1),
      offset: z.number().int().min(1).max(100).default(10),
    },
    handler: async (args, cfg) => {
      const data = await getAccountTokenTransfers(cfg, args.address as string, {
        contractAddress: args.contractAddress as string | undefined,
        page: (args.page as number) ?? 1,
        offset: (args.offset as number) ?? 10,
      });
      return ok(data);
    },
  });

  registerTool(server, config, {
    name: "pulsechain_token_info",
    description:
      "Token metadata with soft-fail fallbacks: BlockScout getToken → v2 tokens " +
      "API → RPC ERC-20 name/symbol/decimals (and CORE_TOKENS for known assets). " +
      "Does not hard-fail when explorer returns HTTP 400/500.",
    category: "chain",
    inputSchema: {
      contractAddress: addressSchema,
    },
    handler: async (args, cfg) => {
      const contractAddress = args.contractAddress as string;
      const errors: string[] = [];

      const identity = tokenLabelFields(contractAddress) ?? {};

      // 1) Classic explorer getToken
      try {
        const info = await getTokenInfo(cfg, contractAddress);
        if (info && (typeof info !== "object" || Object.keys(info as object).length > 0)) {
          return ok({
            contractAddress,
            source: "explorer_getToken",
            partial: false,
            data: info,
            ...identity,
          });
        }
      } catch (err) {
        errors.push(
          err instanceof ExplorerError || err instanceof Error
            ? err.message
            : "getToken failed",
        );
      }

      // 2) BlockScout v2 token endpoint
      try {
        const v2 = await getTokenInfoV2(cfg, contractAddress);
        if (v2) {
          return ok({
            contractAddress,
            source: "explorer_v2",
            partial: true,
            data: v2,
            explorer_errors: errors.length ? errors : undefined,
            ...identity,
          });
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : "getTokenInfoV2 failed");
      }

      // 3) RPC multicall metadata (+ core registry)
      try {
        const meta = await getErc20Metadata(cfg, contractAddress);
        const known = knownCoreToken(contractAddress);
        return ok({
          contractAddress,
          source: known ? "rpc_core_registry" : "rpc_erc20",
          partial: true,
          data: {
            name: meta.name,
            symbol: meta.symbol,
            decimals: String(meta.decimals),
            contractAddress: meta.address,
          },
          note: "Explorer endpoints failed; metadata from live RPC (and CORE_TOKENS when known).",
          explorer_errors: errors.length ? errors : undefined,
          ...identity,
        });
      } catch (err) {
        errors.push(err instanceof Error ? err.message : "rpc metadata failed");
      }

      // Soft partial failure rather than uncaught throw
      return ok({
        contractAddress,
        source: "none",
        partial: true,
        data: null,
        error: "All token-info sources failed (explorer + RPC)",
        explorer_errors: errors,
        ...identity,
      });
    },
  });

  registerTool(server, config, {
    name: "pulsechain_get_logs",
    description: "Query event logs via explorer API (address/topics/blocks).",
    category: "chain",
    inputSchema: {
      address: addressSchema.optional(),
      fromBlock: z.union([z.number(), z.string()]).optional(),
      toBlock: z.union([z.number(), z.string()]).optional(),
      topic0: z.string().optional(),
      page: z.number().int().min(1).default(1),
      offset: z.number().int().min(1).max(1000).default(100),
    },
    handler: async (args, cfg) => {
      const data = await getLogs(cfg, {
        address: args.address as string | undefined,
        fromBlock: args.fromBlock as number | string | undefined,
        toBlock: args.toBlock as number | string | undefined,
        topic0: args.topic0 as string | undefined,
        page: (args.page as number) ?? 1,
        offset: (args.offset as number) ?? 100,
      });
      return ok(data);
    },
  });
}

export {
  PREPARE_SWAP_WARNINGS,
  PREPARE_UNSIGNED_WARNING,
  applySlippageBps,
  buildSwapPath,
  opGetBalance,
  opGetPortfolio,
  opGetTokenBalance,
  opPrepareSwap,
  opPrepareTransaction,
  opPulsexQuote,
  opReadContract,
  resolveTokenAddress,
} from "./operations.js";
