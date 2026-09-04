/**
 * Encrypted agent wallet tools.
 *
 * - Private keys are AES-256-GCM encrypted at rest and NEVER returned.
 * - Write/signing tools require AGENT_WALLET_ENABLED=true.
 * - Funding the agent is authorization. No spend caps or allowlists.
 * - kill_switch / enabled=false stop signing.
 * - Transactions are simulated (estimateGas / eth_call) before broadcast.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AppConfig } from "../../types.js";
import {
  agentWalletSystemStatus,
  buildAgentIntentView,
  buildProposalReviewSummary,
  buildTxReviewSummary,
  createAgentWallet,
  executeAgentTx,
  getAgentWalletInfo,
  inspectTokenNotional,
  killSwitch,
  listAgentWallets,
  proposeAgentTx,
  revokeAgentWallet,
  setAgentPolicy,
  settleInterruptedBroadcast,
} from "../../wallet/index.js";
import { evaluatePolicy } from "../../wallet/policy.js";
import { loadWalletRecord } from "../../wallet/store.js";
import { PolicyError } from "../../utils/errors.js";
import { ok } from "../../utils/result.js";
import {
  assertAddress,
  assertPositiveAmount,
  neverReturnPrivateKey,
} from "../../utils/safety.js";
import { registerTool, type RegisterToolOptions } from "../define.js";
import { walletToolOutputSchema } from "../outputSchemas.js";
import { parsePlsToWei } from "../../wallet/value.js";

export const WALLET_SECURITY_WARNING =
  "Private keys are encrypted (AES-256-GCM) at rest and NEVER returned in " +
  "tool responses or logs. Funding the agent is authorization — there are no " +
  "spend caps or allowlists. Requires AGENT_WALLET_ENABLED=true. " +
  "Use kill_switch/revoke to stop signing.";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("0x-prefixed address");

const walletIdSchema = z
  .string()
  .regex(/^aw_[a-f0-9]{32}$/)
  .describe("Agent wallet id (aw_…)");

const proposalIdSchema = z
  .string()
  .regex(/^prop_[a-f0-9]{24}$/)
  .describe("Proposal id (prop_…)");

const plsAmountSchema = z
  .union([
    z.number().finite().nonnegative(),
    z
      .string()
      .min(1)
      .describe("Plain decimal string, e.g. \"0.1\" (preferred for exact fractions)"),
  ])
  .describe(
    "PLS amount as number or plain decimal string (no scientific notation). Prefer strings for exact fractions.",
  );

const plsAmountPositiveSchema = z
  .union([
    z.number().finite().positive(),
    z
      .string()
      .min(1)
      .describe("Plain decimal string, e.g. \"1.5\""),
  ])
  .describe(
    "Positive PLS amount as number or plain decimal string (no scientific notation).",
  );

function withWalletSecurity(description: string): string {
  return `${description}\n\n⚠️ ${WALLET_SECURITY_WARNING}`;
}

function registerWalletTool(
  server: McpServer,
  config: AppConfig,
  options: Omit<RegisterToolOptions, "outputSchema">,
): void {
  registerTool(server, config, {
    ...options,
    outputSchema: walletToolOutputSchema,
  });
}

/**
 * Register agent wallet MCP tools.
 */
export function registerWalletTools(
  server: McpServer,
  config: AppConfig,
): void {
  registerWalletTool(server, config, {
    name: "agent_wallet_status",
    description:
      "Operator snapshot: wallets on/off, multiproc risk, writes blocked, " +
      "funding-authorizes-spend, kill switch counts. " +
      "Flow: inspect_tx_intent → propose_agent_tx → reviewSummary → execute_agent_tx. " +
      "Does NOT return secrets or private keys. Not a distributed lock.",
    category: "wallet",
    inputSchema: {},
    handler: async (_args, cfg) =>
      ok(neverReturnPrivateKey(agentWalletSystemStatus(cfg))),
  });

  registerWalletTool(server, config, {
    name: "inspect_tx_intent",
    description:
      "Decode a transaction intent (no signing, no chain I/O). " +
      "Returns token-notional pattern/confidence, movement explanations, and decodeKnowledge. " +
      "Does not block propose/execute. Covers ERC-20, WPLS wrap/unwrap, PulseX-style swaps, " +
      "add/remove liquidity, one-level multicall. Not full EVM simulation. " +
      "Does NOT return secrets.",
    category: "wallet",
    inputSchema: {
      to: addressSchema.describe("Destination contract or EOA"),
      data: z
        .string()
        .regex(/^0x[a-fA-F0-9]*$/)
        .optional()
        .default("0x")
        .describe("Calldata hex (0x for native-only)"),
      valueWei: z
        .string()
        .regex(/^\d+$/)
        .optional()
        .default("0")
        .describe("Native value in wei as decimal integer string"),
    },
    handler: async (args) => {
      const to = args.to as string;
      const data = (args.data as string | undefined) ?? "0x";
      const valueWei = (args.valueWei as string | undefined) ?? "0";
      const inspection = inspectTokenNotional({ to, data, valueWei });
      const intent = buildAgentIntentView({ to, data, valueWei, inspection });
      return ok(
        neverReturnPrivateKey({
          ...intent,
          note:
            "Decode only. Funding the agent is authorization — this tool does not block sends.",
        }),
      );
    },
  });

  registerWalletTool(server, config, {
    name: "agent_wallet_check_policy",
    description:
      "Dry-run: would this wallet sign a native PLS amount? " +
      "Blocks only when killed, disabled, or the amount is invalid. " +
      "No spend caps. Prefer propose_agent_tx for a real destination.",
    category: "wallet",
    inputSchema: {
      walletId: walletIdSchema
        .optional()
        .describe("When set, uses that wallet's kill/enabled state"),
      amountPls: plsAmountPositiveSchema.describe("Amount of PLS to send"),
    },
    handler: async (args, cfg) => {
      if (!cfg.agentWalletEnabled) {
        throw new PolicyError(
          "Agent wallets are disabled (set AGENT_WALLET_ENABLED=true)",
        );
      }
      const amountPls = args.amountPls as number | string;
      if (typeof amountPls === "number") {
        assertPositiveAmount(amountPls, "amountPls");
      }
      const walletId = args.walletId as string | undefined;
      let enabled = true;
      let killed = false;
      let dailySpend = {
        date: new Date().toISOString().slice(0, 10),
        spentPls: 0,
      };
      if (walletId) {
        const record = loadWalletRecord(cfg.agentWalletDir, walletId);
        enabled = record.policy.enabled;
        killed = record.policy.killed;
        if (record.dailySpend) {
          dailySpend = {
            date: record.dailySpend.date,
            spentPls: record.dailySpend.spentPls,
          };
        }
      }
      const toPlaceholder =
        "0x0000000000000000000000000000000000000001" as const;
      const check = evaluatePolicy({
        policy: { enabled, killed },
        dailySpend,
        tokenDailySpend: {},
        to: toPlaceholder,
        valuePls: amountPls,
        data: "0x",
        destinationIsContract: false,
      });
      const reviewSummary = buildTxReviewSummary({
        to: toPlaceholder,
        valuePls: check.valuePls,
        valueWei: check.valueWei,
        data: "0x",
        policyCheck: check,
        context: "check",
      });
      return ok(
        neverReturnPrivateKey({
          allowed: check.allowed,
          reasons: check.reasons,
          decisionTrace: reviewSummary.decisionTrace,
          amountPls,
          walletId: walletId ?? null,
          killed,
          enabled,
          fundingAuthorizesSpend: true,
          reviewSummary,
          note:
            "Dry-run uses a placeholder destination. Kill/disabled/invalid only. " +
            "For a real to/calldata, use propose_agent_tx.",
        }),
      );
    },
  });

  registerWalletTool(server, config, {
    name: "create_agent_wallet",
    description: withWalletSecurity(
      "Generate a new agent EOA (viem), encrypt the private key with " +
        "AES-256-GCM under AGENT_WALLET_MASTER_KEY, and store under AGENT_WALLET_DIR. " +
        "Returns ONLY public address, wallet id, and enabled/killed — never the private key.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      label: z
        .string()
        .max(64)
        .optional()
        .describe("Optional human label for the wallet"),
    },
    handler: async (args, cfg) => {
      const info = await createAgentWallet(cfg, {
        label: args.label as string | undefined,
      });
      return ok(
        neverReturnPrivateKey({
          ...info,
          note:
            "Private key encrypted at rest. Funding this address authorizes the agent to spend it.",
        }),
      );
    },
  });

  registerWalletTool(server, config, {
    name: "get_agent_wallet_info",
    description:
      "Return public agent wallet info: address, enabled/killed, balances, " +
      "created_at, daily spend. Never returns private keys or encrypted blobs.",
    category: "wallet",
    inputSchema: {
      walletId: walletIdSchema,
      includeBalance: z
        .boolean()
        .default(true)
        .describe("Fetch on-chain PLS balance (default true)"),
    },
    handler: async (args, cfg) => {
      const info = await getAgentWalletInfo(cfg, args.walletId as string, {
        includeBalance: (args.includeBalance as boolean | undefined) !== false,
      });
      return ok(neverReturnPrivateKey(info));
    },
  });

  registerWalletTool(server, config, {
    name: "list_agent_wallets",
    description:
      "List all agent wallets (public fields only: id, address, enabled/killed, daily spend).",
    category: "wallet",
    inputSchema: {},
    handler: async (_args, cfg) => {
      const list = listAgentWallets(cfg);
      return ok(neverReturnPrivateKey({ wallets: list, count: list.length }));
    },
  });

  registerWalletTool(server, config, {
    name: "set_agent_policy",
    description: withWalletSecurity(
      "Update enabled/killed only. To clear kill switch: set killed=false AND enabled=true together.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
      enabled: z
        .boolean()
        .optional()
        .describe("Soft enable/disable signing"),
      killed: z
        .boolean()
        .optional()
        .describe("Hard kill flag; clear only with enabled=true"),
    },
    handler: async (args, cfg) => {
      const walletId = args.walletId as string;
      const patch: Parameters<typeof setAgentPolicy>[2] = {};
      if (args.enabled !== undefined) patch.enabled = args.enabled as boolean;
      if (args.killed !== undefined) patch.killed = args.killed as boolean;
      const info = await setAgentPolicy(cfg, walletId, patch);
      return ok(neverReturnPrivateKey(info));
    },
  });

  registerWalletTool(server, config, {
    name: "propose_agent_tx",
    description: withWalletSecurity(
      "Prepare an unsigned transaction proposal with simulation (estimateGas/eth_call) " +
        "and reviewSummary (destination, PLS, decoded token movements, gas hints). " +
        "Does not sign or broadcast. Hard blocks are kill/disabled/invalid only. " +
        "Then execute_agent_tx with the proposalId.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
      to: addressSchema.describe("Recipient or contract address"),
      valuePls: plsAmountSchema
        .optional()
        .default(0)
        .describe("Native PLS value to send (number or plain decimal string)"),
      data: z
        .string()
        .regex(/^0x[a-fA-F0-9]*$/)
        .optional()
        .describe("Optional calldata hex (contract call)"),
    },
    handler: async (args, cfg) => {
      const proposal = await proposeAgentTx(cfg, {
        walletId: args.walletId as string,
        to: args.to as `0x${string}`,
        valuePls: (args.valuePls as number | string | undefined) ?? 0,
        data: args.data as `0x${string}` | undefined,
      });
      return ok(
        neverReturnPrivateKey({
          ...proposal,
          nextStep: proposal.reviewSummary.nextStep,
        }),
      );
    },
  });

  registerWalletTool(server, config, {
    name: "execute_agent_tx",
    description: withWalletSecurity(
      "Sign and broadcast a pending proposal. Re-checks kill/enabled and re-simulates before send. " +
        "Private key never returned. Funding the agent is authorization.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      proposalId: proposalIdSchema,
    },
    handler: async (args, cfg) => {
      const proposalId = args.proposalId as string;
      const result = await executeAgentTx(cfg, proposalId);
      return ok(neverReturnPrivateKey(result));
    },
  });

  registerWalletTool(server, config, {
    name: "sign_and_send",
    description: withWalletSecurity(
      "Alias of execute_agent_tx: sign + broadcast a pending proposal. " +
        "Private key never returned.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      proposalId: proposalIdSchema,
    },
    handler: async (args, cfg) => {
      const result = await executeAgentTx(cfg, args.proposalId as string);
      return ok(neverReturnPrivateKey(result));
    },
  });

  registerWalletTool(server, config, {
    name: "settle_interrupted_broadcast",
    description: withWalletSecurity(
      "Recover local state after chain accept when proposal is broadcasting+txHash " +
        "but not yet executed. NEVER re-broadcasts. Idempotent spend merge. " +
        "Fails closed if no txHash. Verify txHash on explorer first.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      proposalId: proposalIdSchema,
    },
    handler: async (args, cfg) => {
      const result = await settleInterruptedBroadcast(
        cfg,
        args.proposalId as string,
      );
      return ok(neverReturnPrivateKey(result));
    },
  });

  registerWalletTool(server, config, {
    name: "transfer_pls",
    description: withWalletSecurity(
      "Native PLS transfer: simulate, then broadcast. " +
        "Prefer propose_agent_tx → reviewSummary → execute_agent_tx for a two-step review. " +
        "Funding the agent is authorization.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
      to: addressSchema.describe("Recipient address"),
      amountPls: plsAmountPositiveSchema.describe(
        "PLS amount to transfer (number or plain decimal string)",
      ),
    },
    handler: async (args, cfg) => {
      const walletId = args.walletId as string;
      const amountPls = args.amountPls as number | string;
      const to = assertAddress(args.to as string);
      void parsePlsToWei(amountPls);

      const proposal = await proposeAgentTx(cfg, {
        walletId,
        to,
        valuePls: amountPls,
        data: "0x",
      });
      const summary = buildProposalReviewSummary(proposal, "execute");
      const result = await executeAgentTx(cfg, proposal.id);
      return ok(
        neverReturnPrivateKey({
          ...result,
          valueWei: proposal.valueWei,
          policyCheck: proposal.policyCheck,
          reviewSummary: summary,
        }),
      );
    },
  });

  registerWalletTool(server, config, {
    name: "kill_switch",
    description: withWalletSecurity(
      "EMERGENCY: Immediately disable wallet signing (enabled=false, killed=true). " +
        "Idempotent if already killed. To resume: set_agent_policy with killed=false AND enabled=true.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
    },
    handler: async (args, cfg) => {
      const info = await killSwitch(cfg, args.walletId as string);
      return ok(
        neverReturnPrivateKey({
          ...info,
          message: "Kill switch active — all signing disabled for this wallet",
        }),
      );
    },
  });

  registerWalletTool(server, config, {
    name: "revoke",
    description: withWalletSecurity(
      "Revoke agent wallet signing immediately (same as kill_switch). " +
        "Sets enabled=false and killed=true.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
    },
    handler: async (args, cfg) => {
      const info = await revokeAgentWallet(cfg, args.walletId as string);
      return ok(
        neverReturnPrivateKey({
          ...info,
          message: "Wallet revoked — signing disabled",
        }),
      );
    },
  });
}
