/**
 * Encrypted agent wallet tools (operator-trust model, v0.1.38+).
 *
 * SECURITY:
 * - Private keys are AES-256-GCM encrypted at rest and NEVER returned in
 *   tool responses, logs, or error messages.
 * - All write/signing tools require AGENT_WALLET_ENABLED=true.
 * - Operator-trust: funding the agent is authorization. Hard spend caps and
 *   deny-by-default allowlists are NOT safety backstops.
 * - Optional kill_switch / enabled=false remain emergency operator controls.
 * - Transactions are simulated (estimateGas / eth_call) before broadcast.
 * - Confirm is dual-path: confirm=true arg (legacy/scripts) OR MRTR
 *   InputRequiredResult elicitation with HMAC-signed requestState (host UX).
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
  formatConfirmPrompt,
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
import { loadProposal, loadWalletRecord } from "../../wallet/store.js";
import { PolicyError } from "../../utils/errors.js";
import { ok } from "../../utils/result.js";
import {
  assertAddress,
  assertPositiveAmount,
  neverReturnPrivateKey,
} from "../../utils/safety.js";
import {
  policySnapshotId,
  proposalExecutionIntentArgs,
  readVerifiedConfirmState,
  requireConfirmOrInput,
} from "../../utils/confirm.js";
import { registerTool } from "../define.js";

/** Extra security banner for every wallet write tool description. */
export const WALLET_SECURITY_WARNING =
  "SECURITY WARNING: Private keys are encrypted (AES-256-GCM) at rest and " +
  "NEVER returned in tool responses or logs. Operator-trust mode: funding the " +
  "agent is authorization — there is no hard spend-cap or deny-by-default " +
  "allowlist safety backstop. Requires AGENT_WALLET_ENABLED=true. Confirm via " +
  "confirm=true (legacy/scripts) or modern MRTR InputRequiredResult elicitation " +
  "(host UX only). Optional kill_switch/revoke immediately disable signing.";

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

/** Dual-protocol confirm: arg path or MRTR elicitation. */
const confirmSchema = z
  .boolean()
  .optional()
  .describe(
    "Pass true to authorize (legacy/script path). Modern MRTR clients may omit " +
      "this and complete the server's confirm elicitation (InputRequiredResult) instead.",
  );

/**
 * PLS amount for tool args: number (JSON decimals like 0.1) or plain decimal string.
 * Parsed via parsePlsToWei (rejects scientific notation).
 */
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
  // WRITE_TOOL_WARNING is appended by registerTool when write=true
  return `${description}\n\n⚠️ ${WALLET_SECURITY_WARNING}`;
}

function snapshotForWallet(
  cfg: AppConfig,
  walletId: string | undefined,
): string {
  if (!walletId) return "none";
  try {
    const record = loadWalletRecord(cfg.agentWalletDir, walletId);
    return policySnapshotId(record.policy);
  } catch {
    return "none";
  }
}

/**
 * Register agent wallet MCP tools.
 */
export function registerWalletTools(
  server: McpServer,
  config: AppConfig,
): void {
  // -------------------------------------------------------------------------
  // Status / diagnostics (no secrets; works when disabled)
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "agent_wallet_status",
    description:
      "Operator snapshot first: operatorAtAGlance (wallets on/off, multiproc risk, writes blocked, " +
      "policy posture, safeFlow, nextAction). Also default PLS limits, master-key configured flag, " +
      "walletDirOwnership (riskLevel none|warn|blocked), and security posture notes " +
      "(tokenAllowlist = tx.to only; token-notional / WPLS / multicall). " +
      "Safe flow: inspect_tx_intent → propose → reviewSummary → execute. " +
      "Does NOT return secrets or private keys. Not a distributed lock.",
    category: "wallet",
    inputSchema: {},
    handler: async (_args, cfg) =>
      ok(neverReturnPrivateKey(agentWalletSystemStatus(cfg))),
  });

  // -------------------------------------------------------------------------
  // inspect_tx_intent — pure local decode for agents (no wallet required)
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "inspect_tx_intent",
    description:
      "Decode a transaction intent for agent safety judgment (no signing, no chain I/O). " +
      "Returns token-notional pattern/confidence, movement explanations, decodeKnowledge " +
      "(known vs unknown), agentGuidance (proceed_with_confirm | review_carefully | refuse), " +
      "and residualUncertainty. Covers ERC-20, WPLS wrap/unwrap, PulseX-style swaps, " +
      "add/remove liquidity, one-level multicall. Not full EVM simulation. " +
      "Does NOT return secrets. Preferred first step when calldata is unclear: " +
      "inspect_tx_intent → propose_agent_tx → read reviewSummary → execute_agent_tx.",
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
          safeUsage:
            "If agentGuidance is refuse → do not propose/execute (kill/disabled/invalid only hard-block under OT). " +
            "If review_carefully → human review of destination/calldata (advisory decode; not a hard gate). " +
            "If proceed_with_confirm → still propose_agent_tx and read reviewSummary before confirm. " +
            "Operator-trust: funding authorizes; confirm is host UX only.",
        }),
      );
    },
  });

  registerTool(server, config, {
    name: "agent_wallet_check_policy",
    description:
      "Dry-run wallet write check for a native PLS amount (no send, no signing). " +
      "Operator-trust: hard caps/allowlists are not gates; kill/disabled still block " +
      "when walletId is supplied. Returns allow/deny, reasons, and reviewSummary. " +
      "Prefer propose_agent_tx for real destinations.",
    category: "wallet",
    inputSchema: {
      walletId: walletIdSchema
        .optional()
        .describe("When set, uses that wallet's kill/enabled state (not a synthetic always-on policy)"),
      amountPls: plsAmountPositiveSchema.describe("Amount of PLS to send"),
      dailySpentPls: z
        .number()
        .min(0)
        .default(0)
        .describe("PLS already spent today (caller-supplied override)"),
      maxPlsPerTx: z
        .number()
        .positive()
        .optional()
        .describe("Override max per tx (defaults to config)"),
      maxPlsDaily: z
        .number()
        .positive()
        .optional()
        .describe("Override max daily (defaults to config)"),
    },
    handler: async (args, cfg) => {
      if (!cfg.agentWalletEnabled) {
        throw new PolicyError(
          "Agent wallets are disabled (set AGENT_WALLET_ENABLED=true)",
        );
      }
      const amountPls = args.amountPls as number | string;
      const dailySpentPls = (args.dailySpentPls as number) ?? 0;
      // Validate via policy path (parsePlsToWei inside evaluatePolicy)
      if (typeof amountPls === "number") {
        assertPositiveAmount(amountPls, "amountPls");
      }
      const walletId = args.walletId as string | undefined;
      let enabled = true;
      let killed = false;
      let maxPer = (args.maxPlsPerTx as number | undefined) ?? cfg.maxPlsPerTx;
      let maxDaily =
        (args.maxPlsDaily as number | undefined) ?? cfg.maxPlsDaily;
      let dailySpend = {
        date: new Date().toISOString().slice(0, 10),
        spentPls: dailySpentPls,
      };
      if (walletId) {
        const record = loadWalletRecord(cfg.agentWalletDir, walletId);
        enabled = record.policy.enabled;
        killed = record.policy.killed;
        maxPer = (args.maxPlsPerTx as number | undefined) ?? record.policy.maxPlsPerTx;
        maxDaily =
          (args.maxPlsDaily as number | undefined) ?? record.policy.maxPlsDaily;
        if (dailySpentPls === 0 && record.dailySpend) {
          dailySpend = {
            date: record.dailySpend.date,
            spentPls: record.dailySpend.spentPls,
          };
        }
      }
      const toPlaceholder =
        "0x0000000000000000000000000000000000000001" as const;
      const check = evaluatePolicy({
        policy: {
          enabled,
          killed,
          maxPlsPerTx: maxPer,
          maxPlsDaily: maxDaily,
          contractAllowlist: [],
          tokenAllowlist: [],
          allowlistExpiresAt: null,
          tokenSpendCaps: {},
          tokenDailyCaps: {},
          erc20NotionalCaps: {},
          requireDecodableCalldata: false,
          allowNativeTransfers: true,
        },
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
          remainingDaily: check.remainingDaily,
          maxPlsPerTx: maxPer,
          maxPlsDaily: maxDaily,
          tokenNotional: check.tokenNotional,
          reviewSummary,
          note:
            "Dry-run uses a placeholder destination. Pass walletId to include " +
            "that wallet's kill/enabled state. For real to/calldata/token-notional, " +
            "use propose_agent_tx and read reviewSummary before execute.",
        }),
      );
    },
  });

  // -------------------------------------------------------------------------
  // create_agent_wallet
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "create_agent_wallet",
    description: withWalletSecurity(
      "Generate a new agent EOA (viem), encrypt the private key with " +
        "AES-256-GCM under AGENT_WALLET_MASTER_KEY, and store under AGENT_WALLET_DIR. " +
        "Returns ONLY public address, wallet id, and default policy — never the private key.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      label: z
        .string()
        .max(64)
        .optional()
        .describe("Optional human label for the wallet"),
      confirm: confirmSchema,
    },
    handler: async (args, cfg, ctx) => {
      const gate = await requireConfirmOrInput({
        tool: "create_agent_wallet",
        message:
          "Create a new encrypted agent wallet (operator-trust when funded)? " +
          "Private key will be generated and encrypted at rest (AES-256-GCM). " +
          "Confirm only if you intend to create a new EOA under AGENT_WALLET_DIR.",
        args,
        ctx,
        policySnapshotId: "none",
      });
      if (gate !== true) return gate;

      const info = await createAgentWallet(cfg, {
        label: args.label as string | undefined,
      });
      return ok(
        neverReturnPrivateKey({
          ...info,
          note:
            "Private key encrypted at rest. Operator-trust: funding this address " +
            "authorizes the agent to spend it. Optional kill_switch for emergencies.",
        }),
      );
    },
  });

  // -------------------------------------------------------------------------
  // get_agent_wallet_info / list
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "get_agent_wallet_info",
    description:
      "Return public agent wallet info: address, policy, balances summary, " +
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

  registerTool(server, config, {
    name: "list_agent_wallets",
    description:
      "List all agent wallets (public fields only: id, address, policy, daily spend).",
    category: "wallet",
    inputSchema: {},
    handler: async (_args, cfg) => {
      const list = listAgentWallets(cfg);
      return ok(neverReturnPrivateKey({ wallets: list, count: list.length }));
    },
  });

  // -------------------------------------------------------------------------
  // set_agent_policy
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "set_agent_policy",
    description: withWalletSecurity(
      "Update per-wallet policy record. Operator-trust (v0.1.38+): maxPls*, allowlists, " +
        "and token-notional fields are legacy/storage only — NOT hard send gates. " +
        "Hard controls: enabled and killed. To clear kill switch: set killed=false AND enabled=true together.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
      maxPlsPerTx: z
        .number()
        .min(0)
        .optional()
        .describe(
          "Legacy max PLS value per transaction (storage/display only; not a hard send gate v0.1.38+)",
        ),
      maxPlsDaily: z
        .number()
        .min(0)
        .optional()
        .describe(
          "Legacy max PLS value per UTC day (storage/display only; not a hard send gate v0.1.38+)",
        ),
      contractAllowlist: z
        .array(addressSchema)
        .optional()
        .describe(
          "Legacy contract address list (storage/display only). Empty/omit-to-keep; " +
            "empty array does NOT deny contracts under operator-trust (v0.1.38+).",
        ),
      tokenAllowlist: z
        .array(addressSchema)
        .optional()
        .describe(
          "Legacy destination list (storage/display only; not a hard send gate v0.1.38+). " +
            "When non-empty historically filtered tx.to only — no longer enforced as a block.",
        ),
      enabled: z
        .boolean()
        .optional()
        .describe("Soft enable/disable signing (hard control)"),
      killed: z
        .boolean()
        .optional()
        .describe("Hard kill flag; clear only with enabled=true (hard control)"),
      allowNativeTransfers: z
        .boolean()
        .optional()
        .describe(
          "Legacy native-transfer flag (storage/display only; not a hard send gate v0.1.38+)",
        ),
      allowlistExpiresAt: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Legacy ISO-8601 UTC allowlist display field; null clears. Not a hard send gate (v0.1.38+).",
        ),
      tokenSpendCaps: z
        .record(z.string(), z.number().min(0))
        .optional()
        .describe(
          "Legacy map of 0x address → max native PLS (display/storage only; not a hard gate v0.1.38+)",
        ),
      tokenDailyCaps: z
        .record(z.string(), z.number().min(0))
        .optional()
        .describe(
          "Legacy map of 0x address → max daily native PLS (display/storage only; not a hard gate v0.1.38+)",
        ),
      erc20NotionalCaps: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Legacy map of token 0x address (or "native") → raw amount string. ' +
            "Storage/display only — not a hard send gate (v0.1.38+).",
        ),
      requireDecodableCalldata: z
        .boolean()
        .optional()
        .describe(
          "Legacy flag (v0.1.38+: not a hard send gate). Calldata decode remains advisory only.",
        ),
      confirm: confirmSchema,
    },
    handler: async (args, cfg, ctx) => {
      const walletId = args.walletId as string;
      const gate = await requireConfirmOrInput({
        tool: "set_agent_policy",
        message:
          `Apply policy-record changes to wallet ${walletId}? Hard controls are enabled/killed only. ` +
          "Legacy allowlist/cap fields are storage/display only under operator-trust (not hard send gates).",
        args,
        ctx,
        walletId,
        policySnapshotId: snapshotForWallet(cfg, walletId),
      });
      if (gate !== true) return gate;

      const patch: Parameters<typeof setAgentPolicy>[2] = {};
      if (args.maxPlsPerTx !== undefined) {
        patch.maxPlsPerTx = args.maxPlsPerTx as number;
      }
      if (args.maxPlsDaily !== undefined) {
        patch.maxPlsDaily = args.maxPlsDaily as number;
      }
      if (args.contractAllowlist !== undefined) {
        patch.contractAllowlist = args.contractAllowlist as `0x${string}`[];
      }
      if (args.tokenAllowlist !== undefined) {
        patch.tokenAllowlist = args.tokenAllowlist as `0x${string}`[];
      }
      if (args.enabled !== undefined) patch.enabled = args.enabled as boolean;
      if (args.killed !== undefined) patch.killed = args.killed as boolean;
      if (args.allowNativeTransfers !== undefined) {
        patch.allowNativeTransfers = args.allowNativeTransfers as boolean;
      }
      if (args.allowlistExpiresAt !== undefined) {
        patch.allowlistExpiresAt = args.allowlistExpiresAt as string | null;
      }
      if (args.tokenSpendCaps !== undefined) {
        patch.tokenSpendCaps = args.tokenSpendCaps as Record<string, number>;
      }
      if (args.tokenDailyCaps !== undefined) {
        patch.tokenDailyCaps = args.tokenDailyCaps as Record<string, number>;
      }
      if (args.erc20NotionalCaps !== undefined) {
        patch.erc20NotionalCaps = args.erc20NotionalCaps as Record<
          string,
          string
        >;
      }
      if (args.requireDecodableCalldata !== undefined) {
        patch.requireDecodableCalldata =
          args.requireDecodableCalldata as boolean;
      }
      const info = await setAgentPolicy(cfg, walletId, patch);
      return ok(neverReturnPrivateKey(info));
    },
  });

  // -------------------------------------------------------------------------
  // propose_agent_tx
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "propose_agent_tx",
    description: withWalletSecurity(
      "Prepare an unsigned transaction proposal with simulation (estimateGas/eth_call) " +
        "and operator-readable reviewSummary (destination, PLS, token movements, checksApplied). " +
        "Does not sign or broadcast. Operator-trust: funding authorizes; hard blocks are kill/disabled only. " +
        "Safe pattern: propose → review reviewSummary → execute_agent_tx with confirm=true (or MRTR). " +
        "Confirm is host UX only.",
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
          // reviewSummary already attached by proposeAgentTx
          nextStep: proposal.reviewSummary.nextStep,
          safeUsage:
            "propose_agent_tx → review reviewSummary + policyCheck → execute_agent_tx with confirm",
        }),
      );
    },
  });

  // -------------------------------------------------------------------------
  // execute_agent_tx / sign_and_send
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "execute_agent_tx",
    description: withWalletSecurity(
      "Sign and broadcast a pending proposal. Re-checks kill/enabled and re-simulates before send. " +
        "Confirm message includes proposal reviewSummary. Requires confirm=true or MRTR confirm. " +
        "Private key never returned. Operator-trust: funding authorizes; confirm is host UX only.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      proposalId: proposalIdSchema,
      confirm: confirmSchema,
    },
    handler: async (args, cfg, ctx) => {
      const proposalId = args.proposalId as string;
      const peek = loadProposal(cfg.agentWalletDir, proposalId);
      const summary = buildProposalReviewSummary(peek, "execute");
      const confirmMessage = formatConfirmPrompt(summary);
      const gate = await requireConfirmOrInput({
        tool: "execute_agent_tx",
        message: confirmMessage,
        args: { ...args, ...proposalExecutionIntentArgs(peek) },
        ctx,
        walletId: peek.walletId,
        policySnapshotId: "none",
      });
      if (gate !== true) return gate;

      // Service re-checks AGENT_WALLET_ENABLED + kill/enabled + simulate before sign.
      const result = await executeAgentTx(cfg, proposalId, true);
      return ok(neverReturnPrivateKey(result));
    },
  });

  // Alias name for discoverability
  registerTool(server, config, {
    name: "sign_and_send",
    description: withWalletSecurity(
      "Alias of execute_agent_tx: sign + broadcast of a pending proposal. " +
        "Confirm includes reviewSummary. Requires confirm=true or MRTR confirm. " +
        "Private key never returned.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      proposalId: proposalIdSchema,
      confirm: confirmSchema,
    },
    handler: async (args, cfg, ctx) => {
      const proposalId = args.proposalId as string;
      const peek = loadProposal(cfg.agentWalletDir, proposalId);
      const confirmMessage = formatConfirmPrompt(
        buildProposalReviewSummary(peek, "execute"),
      );
      const gate = await requireConfirmOrInput({
        tool: "sign_and_send",
        message: confirmMessage,
        args: { ...args, ...proposalExecutionIntentArgs(peek) },
        ctx,
        walletId: peek.walletId,
        policySnapshotId: "none",
      });
      if (gate !== true) return gate;

      const result = await executeAgentTx(cfg, proposalId, true);
      return ok(neverReturnPrivateKey(result));
    },
  });

  // -------------------------------------------------------------------------
  // settle_interrupted_broadcast — local recovery only (no re-broadcast)
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "settle_interrupted_broadcast",
    description: withWalletSecurity(
      "Recover local state after chain accept when proposal is broadcasting+txHash " +
        "but not yet executed (crash between barrier and spend merge). NEVER re-broadcasts. " +
        "Idempotent spend merge via appliedSpendProposalIds. Requires confirm=true (host-strength). " +
        "Gated by multiproc write rules (same requireWritable as execute). " +
        "Fails closed if no txHash. Verify txHash on explorer first. " +
        "Do not use to re-send; execute_agent_tx stays fail-closed on broadcasting/txHash.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      proposalId: proposalIdSchema,
      confirm: confirmSchema,
    },
    handler: async (args, cfg, ctx) => {
      const proposalId = args.proposalId as string;
      const peek = loadProposal(cfg.agentWalletDir, proposalId);
      const confirmMessage =
        `Settle interrupted proposal ${proposalId}? status=${peek.status} ` +
        `txHash=${peek.txHash ?? "(none)"}. No re-broadcast; local spend merge only.`;
      const gate = await requireConfirmOrInput({
        tool: "settle_interrupted_broadcast",
        message: confirmMessage,
        args: { ...args, ...proposalExecutionIntentArgs(peek) },
        ctx,
        walletId: peek.walletId,
        policySnapshotId: "none",
      });
      if (gate !== true) return gate;

      const result = await settleInterruptedBroadcast(cfg, proposalId, true);
      return ok(neverReturnPrivateKey(result));
    },
  });

  // -------------------------------------------------------------------------
  // transfer_pls
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "transfer_pls",
    description: withWalletSecurity(
      "Native PLS transfer: simulate first, then confirm with fee/review, then broadcast. " +
        "Requires confirm=true or MRTR confirm after the simulated proposal is shown. " +
        "Prefer propose → review reviewSummary → execute for a two-step audit. " +
        "Operator-trust: EOAs and contracts are not blocked by allowlists/caps; " +
        "kill/disabled still stop signing. Confirm is host UX only.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
      to: addressSchema.describe("Recipient address"),
      amountPls: plsAmountPositiveSchema.describe(
        "PLS amount to transfer (number or plain decimal string)",
      ),
      confirm: confirmSchema,
    },
    handler: async (args, cfg, ctx) => {
      const walletId = args.walletId as string;
      const amountPls = args.amountPls as number | string;
      const to = assertAddress(args.to as string);

      // Reuse a proposal sealed into MRTR requestState so resume does not
      // create a second pending transfer.
      const prior = await readVerifiedConfirmState(ctx);
      let proposal;
      if (
        prior?.proposalId &&
        prior.tool === "transfer_pls" &&
        prior.walletId === walletId
      ) {
        proposal = loadProposal(cfg.agentWalletDir, prior.proposalId);
        if (proposal.to.toLowerCase() !== to.toLowerCase()) {
          throw new PolicyError(
            "Sealed transfer_pls proposal destination does not match args; re-issue the tool call.",
          );
        }
      } else {
        proposal = await proposeAgentTx(cfg, {
          walletId,
          to,
          valuePls: amountPls,
          data: "0x",
        });
      }

      const summary = buildProposalReviewSummary(proposal, "execute");
      const gate = await requireConfirmOrInput({
        tool: "transfer_pls",
        message: formatConfirmPrompt(summary),
        args: {
          ...args,
          ...proposalExecutionIntentArgs(proposal),
          amountPls,
        },
        ctx,
        walletId,
        policySnapshotId: snapshotForWallet(cfg, walletId),
        sealedProposalId: proposal.id,
      });
      if (gate !== true) return gate;

      const fresh = loadProposal(cfg.agentWalletDir, proposal.id);
      if (
        fresh.to.toLowerCase() !== to.toLowerCase() ||
        fresh.valueWei !== proposal.valueWei
      ) {
        throw new PolicyError(
          "Proposal changed after confirmation; re-issue transfer_pls.",
        );
      }

      const result = await executeAgentTx(cfg, proposal.id, true);
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

  // -------------------------------------------------------------------------
  // revoke / kill_switch
  // -------------------------------------------------------------------------
  registerTool(server, config, {
    name: "kill_switch",
    description: withWalletSecurity(
      "EMERGENCY: Immediately disable wallet signing (enabled=false, killed=true). " +
        "Also clears legacy allowlist fields on disk (display only; not hard send gates). " +
        "Idempotent if already killed. To resume: set_agent_policy with killed=false AND enabled=true.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
      confirm: confirmSchema,
    },
    handler: async (args, cfg, ctx) => {
      const walletId = args.walletId as string;
      const gate = await requireConfirmOrInput({
        tool: "kill_switch",
        message:
          `Activate kill switch for wallet ${walletId}? This immediately disables ` +
          "all signing until policy is re-enabled.",
        args,
        ctx,
        walletId,
        policySnapshotId: snapshotForWallet(cfg, walletId),
      });
      if (gate !== true) return gate;

      const info = await killSwitch(cfg, walletId);
      return ok(
        neverReturnPrivateKey({
          ...info,
          message: "Kill switch active — all signing disabled for this wallet",
        }),
      );
    },
  });

  registerTool(server, config, {
    name: "revoke",
    description: withWalletSecurity(
      "Revoke agent wallet signing immediately (same as kill_switch). " +
        "Sets enabled=false and killed=true.",
    ),
    category: "wallet",
    write: true,
    inputSchema: {
      walletId: walletIdSchema,
      confirm: confirmSchema,
    },
    handler: async (args, cfg, ctx) => {
      const walletId = args.walletId as string;
      const gate = await requireConfirmOrInput({
        tool: "revoke",
        message:
          `Revoke signing for wallet ${walletId}? This immediately disables all signing.`,
        args,
        ctx,
        walletId,
        policySnapshotId: snapshotForWallet(cfg, walletId),
      });
      if (gate !== true) return gate;

      const info = await revokeAgentWallet(cfg, walletId);
      return ok(
        neverReturnPrivateKey({
          ...info,
          message: "Wallet revoked — signing disabled",
        }),
      );
    },
  });
}
