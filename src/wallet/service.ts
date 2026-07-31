/**
 * High-level agent wallet service: create, policy, propose, sign+send.
 * Private keys are decrypted only in memory for signing and never returned.
 *
 * Wallet-record mutations (kill, policy, day-roll, execute spend) run under
 * per-wallet withWalletLock so concurrent execute cannot last-write-wins a
 * stale full record over a kill or tightened policy.
 */

import {
  createWalletClient,
  formatEther,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { pulsechain } from "viem/chains";
import type { AppConfig } from "../types.js";
import {
  estimateGas,
  ethCall,
  getNativeBalance,
  getPublicClient,
  getRpcTransport,
} from "../data/rpc.js";
import { enrichSimulationWithApproxFee } from "./feeEstimate.js";
import { AppError, ConfigError, PolicyError, RpcError } from "../utils/errors.js";
import { assertAddress } from "../utils/safety.js";
import { logger } from "../logger.js";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  generateProposalId,
  generateWalletId,
} from "./crypto.js";
import { withWalletLock } from "./lock.js";
import {
  assertPolicyAllows,
  evaluatePolicy,
  isAllowlistExpired,
  mergePolicy,
  normalizeDailySpend,
  normalizeTokenDailySpend,
} from "./policy.js";
import {
  buildWalletDirOwnershipStatusView,
  ensureWalletDirClaimed,
  type MultiprocRiskLevel,
  type OwnershipResult,
  type WalletDirOwnershipStatusView,
} from "./owner.js";
import {
  appendAudit,
  listWalletRecords,
  loadProposal,
  loadWalletRecord,
  persistBroadcastBarrier,
  persistProposalExecuted,
  saveProposal,
  saveWalletRecord,
} from "./store.js";
import {
  buildProposalReviewSummary,
  WALLET_TX_ORDER_HINT,
  PLS_VALUE_VS_GAS_HINT,
  PULSECHAIN_GAS_OPERATOR_NOTE,
  SAFE_USAGE_PATTERN,
  type TxReviewSummary,
} from "./reviewSummary.js";
import {
  AGENT_WALLET_ENABLE_WARNING,
  APPLIED_SPEND_PROPOSAL_IDS_CAP,
  DEFAULT_POLICY,
  LEGACY_CAPS_DISPLAY_ONLY_NOTE,
  MULTIPROC_MODE_MEANINGS,
  MULTIPROC_POSTURE_SUMMARY,
  MULTIPROC_RECOMMENDED_MODEL,
  PROPOSAL_TTL_MS,
  TOKEN_ALLOWLIST_SEMANTICS,
  type AgentWalletPolicy,
  type AgentWalletPublicInfo,
  type AgentWalletRecord,
  type DailySpendLedger,
  type SimulationResult,
  type TxProposal,
  type TxProposalRequest,
} from "./types.js";
import {
  addSpendWei,
  parsePlsToWei,
  weiToPlsNumber,
} from "./value.js";
import { stripSecrets } from "../utils/safety.js";

/** Fail closed when agent wallets are not enabled. */
function requireEnabled(config: AppConfig): void {
  if (!config.agentWalletEnabled) {
    throw new PolicyError(
      "Agent wallets are disabled (fail closed). Set AGENT_WALLET_ENABLED=true " +
        "only if you accept signing risk with small amounts. " +
        "See agent_wallet_status and docs/SECURITY.md.",
    );
  }
}

/**
 * Gate for wallet **write** paths (create/policy/propose/execute/transfer/kill
 * and day-roll saves). Re-checks ownership so a peer that appeared after
 * startup is not missed.
 *
 * - multiproc strict + live foreign owner → PolicyError (no silent continue)
 * - multiproc warn-only + risk → loud warn, write still allowed
 * - Not a distributed lock; process-local mutexes still do not span processes
 */
function requireWritable(config: AppConfig): OwnershipResult {
  requireEnabled(config);
  const ownership = ensureWalletDirClaimed(config.agentWalletDir, {
    forceRecheck: true,
  });
  if (!ownership.multiProcessRisk) {
    return ownership;
  }

  const hostHint = ownership.owner.hostname
    ? `, host=${ownership.owner.hostname}`
    : "";
  if (config.agentWalletMultiprocStrict) {
    throw new PolicyError(
      "AGENT_WALLET_MULTIPROC_STRICT=true: wallet write refused — " +
        `AGENT_WALLET_DIR is shared with another live process ` +
        `(foreign pid=${ownership.owner.pid}${hostHint}, status=${ownership.status}). ` +
        "Recommended: stop the other MCP instance OR set a unique AGENT_WALLET_DIR " +
        `for this process (${MULTIPROC_RECOMMENDED_MODEL}). ` +
        "Setting AGENT_WALLET_MULTIPROC_STRICT=false reverts to warn-only (still unsafe). " +
        "This is NOT a distributed lock — see docs/SECURITY.md multi-process.",
    );
  }

  // Warn-only: keep single-process smooth, but make shared-dir writes obvious.
  logger.warn(
    "Wallet write proceeding despite multiProcessRisk (warn-only multiproc mode). " +
      `Foreign owner pid=${ownership.owner.pid}${hostHint}. ` +
      `Use unique AGENT_WALLET_DIR per process (${MULTIPROC_RECOMMENDED_MODEL}), ` +
      "or set AGENT_WALLET_MULTIPROC_STRICT=true to refuse writes on conflict.",
    {
      walletDir: config.agentWalletDir,
      foreignPid: ownership.owner.pid,
      multiprocMode: "warn-only",
      multiProcessRisk: true,
      recommendedModel: MULTIPROC_RECOMMENDED_MODEL,
    },
  );
  return ownership;
}

function requireMasterKey(config: AppConfig): string {
  if (!config.agentWalletMasterKey) {
    throw new ConfigError(
      "AGENT_WALLET_MASTER_KEY is required. Use a 64-char hex (32-byte) key " +
        "or a strong passphrase (scrypt-derived).",
    );
  }
  return config.agentWalletMasterKey;
}

function toPublic(
  record: AgentWalletRecord,
  balances?: { balanceWei: string; balancePls: string },
): AgentWalletPublicInfo {
  return {
    id: record.id,
    address: record.address,
    createdAt: record.createdAt,
    label: record.label,
    policy: record.policy,
    dailySpend: record.dailySpend,
    tokenDailySpend: record.tokenDailySpend ?? {},
    allowlistExpired: isAllowlistExpired(record.policy),
    // H2: every public wallet surface marks legacy maxPls* as display-only
    legacyCapsDisplayOnly: true,
    legacyCapsNote: LEGACY_CAPS_DISPLAY_ONLY_NOTE,
    balanceWei: balances?.balanceWei,
    balancePls: balances?.balancePls,
  };
}

/** Operator hint when a proposal is non-retryable for send. */
const NON_RETRYABLE_RECOVERY_HINT =
  "Do not re-broadcast. Verify txHash on the explorer. If status is broadcasting, " +
  "local spend may be incomplete — call settle_interrupted_broadcast (confirm=true) " +
  "to finish spend merge + executed without a second send.";

/**
 * Fail closed if proposal is not safely re-executable (broadcast path).
 * Any status other than pending, or any existing txHash, blocks re-broadcast.
 * Recovery of interrupted local settlement is settleInterruptedBroadcast only.
 */
export function assertProposalExecutable(proposal: TxProposal): void {
  if (proposal.txHash) {
    throw new PolicyError(
      `Proposal already broadcast (txHash=${proposal.txHash}); not retryable: ${proposal.id}. ` +
        `status=${proposal.status}. ${NON_RETRYABLE_RECOVERY_HINT}`,
    );
  }
  if (proposal.status === "executed") {
    throw new PolicyError(
      `Proposal already executed: ${proposal.id}. ${NON_RETRYABLE_RECOVERY_HINT}`,
    );
  }
  if (proposal.status === "broadcasting") {
    throw new PolicyError(
      `Proposal is in-flight (broadcasting); not retryable: ${proposal.id}. ` +
        NON_RETRYABLE_RECOVERY_HINT,
    );
  }
  if (proposal.status === "rejected") {
    throw new PolicyError(
      `Proposal was policy-rejected: ${proposal.policyCheck.reasons.join("; ")}`,
    );
  }
  if (proposal.status === "expired") {
    throw new PolicyError(`Proposal expired: ${proposal.id}`);
  }
  if (proposal.status !== "pending") {
    throw new PolicyError(
      `Proposal status ${proposal.status} is not executable: ${proposal.id}`,
    );
  }
}

/**
 * True when the proposal must never be re-broadcast (txHash or non-pending send states).
 */
export function isProposalNonRetryableForSend(proposal: TxProposal): boolean {
  if (proposal.txHash) return true;
  return (
    proposal.status === "broadcasting" ||
    proposal.status === "executed" ||
    proposal.status === "rejected" ||
    proposal.status === "expired"
  );
}

/**
 * Apply spend to a freshly loaded wallet record only (never overwrite policy
 * / kill flags from a stale in-memory snapshot).
 *
 * When `proposalId` is set, merge is **idempotent**: a second call for the same
 * id is a no-op (safe crash recovery after spend save but before executed).
 */
export function mergeSpendIntoWalletRecord(
  fresh: AgentWalletRecord,
  valueWei: bigint,
  to: `0x${string}`,
  proposalId?: string,
): AgentWalletRecord {
  fresh.dailySpend = normalizeDailySpend(fresh.dailySpend);
  fresh.tokenDailySpend = normalizeTokenDailySpend(fresh.tokenDailySpend);

  if (proposalId) {
    const applied = fresh.appliedSpendProposalIds ?? [];
    if (applied.includes(proposalId)) {
      return fresh;
    }
  }

  fresh.dailySpend = addSpendWei(fresh.dailySpend, valueWei);
  const toKey = to.toLowerCase();
  const prevTok: DailySpendLedger = fresh.tokenDailySpend[toKey] ?? {
    date: fresh.dailySpend.date,
    spentPls: 0,
    spentWei: "0",
  };
  fresh.tokenDailySpend[toKey] = addSpendWei(
    normalizeDailySpend(prevTok),
    valueWei,
  );

  if (proposalId) {
    const next = [...(fresh.appliedSpendProposalIds ?? []), proposalId];
    fresh.appliedSpendProposalIds =
      next.length > APPLIED_SPEND_PROPOSAL_IDS_CAP
        ? next.slice(-APPLIED_SPEND_PROPOSAL_IDS_CAP)
        : next;
  }
  return fresh;
}

/**
 * Post-barrier settlement only: re-load wallet → idempotent spend merge →
 * promote proposal to executed (fsync). Never broadcasts.
 * Safe to re-run for the same proposal id.
 */
export function completePostBroadcastSettlement(
  dir: string,
  proposal: TxProposal,
  valueWei: bigint,
): TxProposal {
  if (!proposal.txHash) {
    throw new PolicyError(
      `Cannot settle proposal without txHash: ${proposal.id}`,
    );
  }
  if (proposal.status === "executed") {
    return proposal;
  }

  const fresh = loadWalletRecord(dir, proposal.walletId);
  mergeSpendIntoWalletRecord(fresh, valueWei, proposal.to, proposal.id);
  saveWalletRecord(dir, fresh);

  return persistProposalExecuted(dir, proposal);
}

/**
 * Test-only broadcast override. When set, execute uses this instead of viem
 * walletClient.sendTransaction. Null restores production path.
 */
export type TestBroadcastFn = (args: {
  privateKey: `0x${string}`;
  to: `0x${string}`;
  valueWei: bigint;
  data: Hex;
  config: AppConfig;
}) => Promise<`0x${string}`>;

let testBroadcastFn: TestBroadcastFn | null = null;

/** @internal Vitest hook — do not use in production. */
export function setTestBroadcast(fn: TestBroadcastFn | null): void {
  testBroadcastFn = fn;
}

/** Audit a policy denial (success=false). Never logs secrets. */
export function auditPolicyDeny(
  config: AppConfig,
  params: {
    walletId: string;
    address?: string;
    to?: string;
    valuePls?: number;
    proposalId?: string;
    reasons: string[];
    action?: "policy_deny" | "propose_tx" | "execute_tx" | "transfer_pls";
  },
): void {
  appendAudit(config.agentWalletDir, {
    ts: new Date().toISOString(),
    action: params.action ?? "policy_deny",
    walletId: params.walletId,
    address: params.address,
    to: params.to,
    valuePls: params.valuePls,
    proposalId: params.proposalId,
    ok: false,
    detail: stripSecrets(params.reasons.join("; ")),
  });
}

/** Create a new EOA, encrypt private key at rest, return public info only. */
export async function createAgentWallet(
  config: AppConfig,
  options?: { label?: string },
): Promise<AgentWalletPublicInfo> {
  requireWritable(config);
  const masterKey = requireMasterKey(config);

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const id = generateWalletId();
  const encryptedKey = encryptPrivateKey(privateKey, masterKey);

  // Best-effort wipe of local reference (JS strings are immutable; key var shadowed)
  const record: AgentWalletRecord = {
    id,
    address: account.address,
    createdAt: new Date().toISOString(),
    encryptedKey,
    policy: DEFAULT_POLICY(config.maxPlsPerTx, config.maxPlsDaily),
    dailySpend: {
      date: new Date().toISOString().slice(0, 10),
      spentPls: 0,
      spentWei: "0",
    },
    tokenDailySpend: {},
    label: options?.label,
  };

  saveWalletRecord(config.agentWalletDir, record);
  appendAudit(config.agentWalletDir, {
    ts: new Date().toISOString(),
    action: "create_wallet",
    walletId: id,
    address: record.address,
    ok: true,
    detail: options?.label ? `label=${options.label}` : undefined,
  });

  logger.info("Created agent wallet", {
    walletId: id,
    address: record.address,
  });

  return toPublic(record);
}

export async function getAgentWalletInfo(
  config: AppConfig,
  walletId: string,
  opts?: { includeBalance?: boolean },
): Promise<AgentWalletPublicInfo> {
  // Day-roll may save — treat as write path for multiproc strict.
  requireWritable(config);
  // Day-roll normalize + save under lock so concurrent execute cannot race
  const record = await withWalletLock(walletId, async () => {
    const rec = loadWalletRecord(config.agentWalletDir, walletId);
    rec.dailySpend = normalizeDailySpend(rec.dailySpend);
    rec.tokenDailySpend = normalizeTokenDailySpend(rec.tokenDailySpend);
    saveWalletRecord(config.agentWalletDir, rec);
    return rec;
  });

  let balances: { balanceWei: string; balancePls: string } | undefined;
  if (opts?.includeBalance !== false) {
    try {
      const b = await getNativeBalance(config, record.address);
      balances = { balanceWei: b.balanceWei, balancePls: b.balancePls };
    } catch {
      // balance optional on RPC failure
    }
  }
  return toPublic(record, balances);
}

/**
 * List wallets (read-only). Enabled-gate only — multiproc strict does not
 * block list so operators can still diagnose shared-dir risk via tools.
 */
export function listAgentWallets(config: AppConfig): AgentWalletPublicInfo[] {
  requireEnabled(config);
  // Soft ownership re-check for status/logs; does not refuse on conflict.
  ensureWalletDirClaimed(config.agentWalletDir, { forceRecheck: true });
  return listWalletRecords(config.agentWalletDir).map((r) =>
    toPublic({
      ...r,
      dailySpend: normalizeDailySpend(r.dailySpend),
      tokenDailySpend: normalizeTokenDailySpend(r.tokenDailySpend),
    }),
  );
}

export async function setAgentPolicy(
  config: AppConfig,
  walletId: string,
  patch: Partial<AgentWalletPolicy>,
): Promise<AgentWalletPublicInfo> {
  requireWritable(config);
  return withWalletLock(walletId, async () => {
    const record = loadWalletRecord(config.agentWalletDir, walletId);
    record.policy = mergePolicy(record.policy, patch);
    record.dailySpend = normalizeDailySpend(record.dailySpend);
    record.tokenDailySpend = normalizeTokenDailySpend(record.tokenDailySpend);
    saveWalletRecord(config.agentWalletDir, record);

    appendAudit(config.agentWalletDir, {
      ts: new Date().toISOString(),
      action: "set_policy",
      walletId,
      address: record.address,
      ok: true,
      detail: JSON.stringify({
        enabled: record.policy.enabled,
        killed: record.policy.killed,
        maxPlsPerTx: record.policy.maxPlsPerTx,
        maxPlsDaily: record.policy.maxPlsDaily,
        contractAllowlistLen: record.policy.contractAllowlist.length,
        tokenAllowlistLen: record.policy.tokenAllowlist.length,
        allowlistExpiresAt: record.policy.allowlistExpiresAt ?? null,
        tokenSpendCapsCount: Object.keys(record.policy.tokenSpendCaps ?? {}).length,
        tokenDailyCapsCount: Object.keys(record.policy.tokenDailyCaps ?? {}).length,
        erc20NotionalCapsCount: Object.keys(
          record.policy.erc20NotionalCaps ?? {},
        ).length,
        requireDecodableCalldata:
          record.policy.requireDecodableCalldata === true,
      }),
    });

    return toPublic(record);
  });
}

/**
 * Immediate kill switch — disable signing.
 * Idempotent if already killed. Does not need master key (offline-safe).
 * Serialized under withWalletLock so concurrent execute cannot overwrite kill.
 */
export async function killSwitch(
  config: AppConfig,
  walletId: string,
): Promise<AgentWalletPublicInfo> {
  requireWritable(config);
  return withWalletLock(walletId, async () => {
    const record = loadWalletRecord(config.agentWalletDir, walletId);
    const already = record.policy.killed && !record.policy.enabled;
    record.policy = {
      ...record.policy,
      enabled: false,
      killed: true,
    };
    // Clear legacy allowlist fields on kill (display/storage; not hard send gates)
    record.policy.contractAllowlist = [];
    record.policy.tokenAllowlist = [];
    record.policy.allowlistExpiresAt = null;
    saveWalletRecord(config.agentWalletDir, record);
    appendAudit(config.agentWalletDir, {
      ts: new Date().toISOString(),
      action: "kill_switch",
      walletId,
      address: record.address,
      ok: true,
      detail: already
        ? "Kill switch re-asserted (already killed); allowlists cleared"
        : "Signing disabled immediately; allowlists cleared",
    });
    logger.warn("Agent wallet kill switch activated", {
      walletId,
      address: record.address,
      alreadyKilled: already,
    });
    return toPublic(record);
  });
}

/** Alias: revoke = kill switch (same hard stop). */
export async function revokeAgentWallet(
  config: AppConfig,
  walletId: string,
): Promise<AgentWalletPublicInfo> {
  const info = await killSwitch(config, walletId);
  appendAudit(config.agentWalletDir, {
    ts: new Date().toISOString(),
    action: "revoke",
    walletId,
    address: info.address,
    ok: true,
    detail: "revoke → kill_switch",
  });
  return info;
}

async function detectIsContract(
  config: AppConfig,
  address: `0x${string}`,
): Promise<boolean> {
  try {
    const code = await getPublicClient(config).getBytecode({ address });
    return Boolean(code && code !== "0x" && code.length > 2);
  } catch {
    // Fail closed for unknown: treat as contract for destinationKind / review labeling
    return true;
  }
}

async function simulateTx(
  config: AppConfig,
  params: {
    from: `0x${string}`;
    to: `0x${string}`;
    valueWei: bigint;
    data: Hex;
  },
): Promise<SimulationResult> {
  let result: SimulationResult = { attempted: true, ok: false };
  try {
    const gas = await estimateGas(config, {
      from: params.from,
      to: params.to,
      value: params.valueWei.toString(),
      data: params.data,
    });
    result.gasEstimate = gas.gasEstimate;
  } catch (err) {
    result.error =
      err instanceof Error ? err.message : "estimateGas failed";
    // Still try eth_call for more detail
  }

  try {
    await ethCall(config, {
      from: params.from,
      to: params.to,
      data: params.data,
      value: params.valueWei.toString(),
    });
    result.ethCallOk = true;
    // estimateGas may have failed on some nodes while call succeeds
    if (!result.error) result.ok = true;
    else result.ok = true; // call succeeded
  } catch (err) {
    result.ethCallOk = false;
    const msg = err instanceof Error ? err.message : "eth_call failed";
    result.error = result.error ? `${result.error}; ${msg}` : msg;
    result.ok = false;
  }

  // Pure transfers: if estimateGas worked, ok
  if (result.gasEstimate && result.ethCallOk !== false) {
    result.ok = true;
  }

  // Best-effort approx PLS fee; never flips ok / never throws into deny path
  result = await enrichSimulationWithApproxFee(config, result);
  return result;
}

/** Proposal plus operator-readable review summary (no secrets). */
export type TxProposalWithReview = TxProposal & {
  reviewSummary: TxReviewSummary;
};

export async function proposeAgentTx(
  config: AppConfig,
  req: TxProposalRequest,
): Promise<TxProposalWithReview> {
  requireWritable(config);
  const record = loadWalletRecord(config.agentWalletDir, req.walletId);
  record.dailySpend = normalizeDailySpend(record.dailySpend);
  record.tokenDailySpend = normalizeTokenDailySpend(record.tokenDailySpend);

  const to = assertAddress(req.to);
  // Precise wei conversion — rejects scientific notation / invalid decimals
  const valueWei = parsePlsToWei(req.valuePls ?? 0);
  const valuePls = weiToPlsNumber(valueWei);
  const data = (req.data && req.data !== "0x"
    ? (req.data as Hex)
    : "0x") as Hex;

  // Operator-trust: only kill/disabled/invalid blocks. Caps/allowlists are not gates.
  const destinationIsContract = await detectIsContract(config, to);
  const policyCheck = evaluatePolicy({
    policy: record.policy,
    dailySpend: record.dailySpend,
    tokenDailySpend: record.tokenDailySpend,
    to,
    valueWei,
    valuePls,
    data,
    destinationIsContract,
  });

  let simulation: SimulationResult = {
    attempted: false,
    ok: false,
    error: policyCheck.allowed
      ? undefined
      : "Simulation skipped: wallet write blocked (kill/disabled/invalid)",
  };
  if (policyCheck.allowed) {
    simulation = await simulateTx(config, {
      from: record.address,
      to,
      valueWei,
      data,
    });
  }

  const now = Date.now();
  const proposal: TxProposal = {
    id: generateProposalId(),
    walletId: record.id,
    from: record.address,
    to,
    valueWei: valueWei.toString(),
    valuePls,
    data,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    simulation,
    policyCheck,
    status: policyCheck.allowed ? "pending" : "rejected",
  };

  saveProposal(config.agentWalletDir, proposal);
  appendAudit(config.agentWalletDir, {
    ts: proposal.createdAt,
    action: "propose_tx",
    walletId: record.id,
    address: record.address,
    to,
    valuePls,
    proposalId: proposal.id,
    ok: policyCheck.allowed,
    detail: policyCheck.allowed
      ? `simulation.ok=${simulation.ok}; valueWei=${valueWei}`
      : stripSecrets(policyCheck.reasons.join("; ")),
  });

  const reviewSummary = buildProposalReviewSummary(proposal, "propose");
  return { ...proposal, reviewSummary };
}

/**
 * Sign and broadcast a previously proposed tx (or inline params via transfer).
 * Private key is decrypted only for signing and never returned.
 * Serialized per walletId to prevent concurrent double-broadcast / cap races.
 */
export async function executeAgentTx(
  config: AppConfig,
  proposalId: string,
  confirm: boolean,
): Promise<{
  txHash: `0x${string}`;
  proposalId: string;
  walletId: string;
  from: `0x${string}`;
  to: `0x${string}`;
  valuePls: number;
  valueWei: string;
  simulation: SimulationResult;
  /** Operator-readable decision summary (recomputed from proposal; no secrets) */
  reviewSummary: TxReviewSummary;
}> {
  requireWritable(config);
  if (confirm !== true) {
    throw new PolicyError(
      "execute_agent_tx requires confirm=true. Review the proposal reviewSummary " +
        "(destination, PLS value, decoded movements) and simulation first. " +
        "Operator-trust mode: funding the agent is authorization; confirm is host UX only.",
    );
  }

  // Resolve wallet id first (outside lock) so we can serialize by wallet
  const peek = loadProposal(config.agentWalletDir, proposalId);
  const result = await withWalletLock(peek.walletId, () =>
    executeAgentTxLocked(config, proposalId),
  );
  // Re-load for final policy snapshot on the proposal (post-execute status)
  let reviewSummary: TxReviewSummary;
  try {
    const finalProp = loadProposal(config.agentWalletDir, proposalId);
    reviewSummary = buildProposalReviewSummary(finalProp, "execute");
  } catch {
    reviewSummary = buildProposalReviewSummary(peek, "execute");
  }
  return {
    ...result,
    valueWei: peek.valueWei,
    reviewSummary,
  };
}

async function executeAgentTxLocked(
  config: AppConfig,
  proposalId: string,
): Promise<{
  txHash: `0x${string}`;
  proposalId: string;
  walletId: string;
  from: `0x${string}`;
  to: `0x${string}`;
  valuePls: number;
  simulation: SimulationResult;
}> {
  const masterKey = requireMasterKey(config);
  // Re-load under lock (CAS: status may have changed while waiting)
  const proposal = loadProposal(config.agentWalletDir, proposalId);

  if (new Date(proposal.expiresAt).getTime() < Date.now()) {
    if (proposal.status === "pending") {
      proposal.status = "expired";
      saveProposal(config.agentWalletDir, proposal);
    }
    throw new PolicyError(`Proposal expired: ${proposalId}`);
  }

  assertProposalExecutable(proposal);

  let record = loadWalletRecord(config.agentWalletDir, proposal.walletId);
  record.dailySpend = normalizeDailySpend(record.dailySpend);
  record.tokenDailySpend = normalizeTokenDailySpend(record.tokenDailySpend);

  let valueWei: bigint;
  try {
    valueWei = BigInt(proposal.valueWei);
  } catch {
    throw new PolicyError(
      `Proposal ${proposalId} has invalid valueWei (expected integer string)`,
    );
  }
  if (valueWei < 0n) {
    throw new PolicyError(`Proposal ${proposalId} has negative valueWei`);
  }

  // Re-check operator-trust gates at execution (kill/disabled/invalid only)
  const destinationIsContract = await detectIsContract(config, proposal.to);
  const policyCheck = evaluatePolicy({
    policy: record.policy,
    dailySpend: record.dailySpend,
    tokenDailySpend: record.tokenDailySpend,
    to: proposal.to,
    valueWei,
    valuePls: proposal.valuePls,
    data: proposal.data,
    destinationIsContract,
  });
  if (!policyCheck.allowed) {
    auditPolicyDeny(config, {
      walletId: record.id,
      address: record.address,
      to: proposal.to,
      valuePls: proposal.valuePls,
      proposalId: proposal.id,
      reasons: policyCheck.reasons,
      action: "execute_tx",
    });
  }
  assertPolicyAllows(policyCheck);

  // Re-simulate before broadcast
  const simulation = await simulateTx(config, {
    from: record.address,
    to: proposal.to,
    valueWei,
    data: proposal.data as Hex,
  });
  if (!simulation.ok) {
    throw new RpcError(
      `Pre-broadcast simulation failed: ${simulation.error ?? "unknown"}`,
    );
  }

  // Pre-send re-load: kill / policy may have changed (multi-process residual;
  // also defense if future code loads earlier). Same-process kill waits on lock.
  record = loadWalletRecord(config.agentWalletDir, proposal.walletId);
  record.dailySpend = normalizeDailySpend(record.dailySpend);
  record.tokenDailySpend = normalizeTokenDailySpend(record.tokenDailySpend);
  if (record.policy.killed || !record.policy.enabled) {
    throw new PolicyError(
      record.policy.killed
        ? "Wallet kill switch is active — signing blocked"
        : "Wallet signing is disabled (policy.enabled=false)",
    );
  }
  const preSendPolicy = evaluatePolicy({
    policy: record.policy,
    dailySpend: record.dailySpend,
    tokenDailySpend: record.tokenDailySpend,
    to: proposal.to,
    valueWei,
    valuePls: proposal.valuePls,
    data: proposal.data,
    destinationIsContract,
  });
  if (!preSendPolicy.allowed) {
    auditPolicyDeny(config, {
      walletId: record.id,
      address: record.address,
      to: proposal.to,
      valuePls: proposal.valuePls,
      proposalId: proposal.id,
      reasons: preSendPolicy.reasons,
      action: "execute_tx",
    });
    assertPolicyAllows(preSendPolicy);
  }

  let privateKey: `0x${string}` | undefined;
  try {
    privateKey = decryptPrivateKey(record.encryptedKey, masterKey);
    const account = privateKeyToAccount(privateKey);
    if (account.address.toLowerCase() !== record.address.toLowerCase()) {
      throw new ConfigError(
        "Decrypted key does not match stored wallet address",
      );
    }

    // Attach sim/policy before send so post-send work is only barrier write
    proposal.simulation = simulation;
    proposal.policyCheck = preSendPolicy.allowed ? preSendPolicy : policyCheck;

    let txHash: `0x${string}`;
    if (testBroadcastFn) {
      txHash = await testBroadcastFn({
        privateKey,
        to: proposal.to,
        valueWei,
        data: proposal.data as Hex,
        config,
      });
    } else {
      const walletClient = createWalletClient({
        account,
        chain: pulsechain,
        transport: getRpcTransport(config),
      });
      txHash = await walletClient.sendTransaction({
        to: proposal.to,
        value: valueWei,
        data: proposal.data as Hex,
        chain: pulsechain,
      });
    }

    // --- Post-broadcast durability (minimal critical section) ---
    // 1) Barrier ONLY: fsync'd broadcasting + txHash. No spend/audit/wallet I/O first.
    persistBroadcastBarrier(config.agentWalletDir, proposal, txHash);

    // 2) Best-effort audit that chain accepted (after barrier so hash is durable first).
    //    Crash here still leaves non-retryable proposal on disk.
    try {
      appendAudit(config.agentWalletDir, {
        ts: new Date().toISOString(),
        action: "broadcast_accepted",
        walletId: record.id,
        address: record.address,
        to: proposal.to,
        valuePls: proposal.valuePls,
        txHash,
        proposalId: proposal.id,
        ok: true,
        detail: "barrier=broadcasting+txHash; settlement pending",
      });
    } catch {
      // Audit must not block settlement
    }

    // 3) Re-load wallet, idempotent spend merge, promote executed (fsync).
    try {
      completePostBroadcastSettlement(
        config.agentWalletDir,
        proposal,
        valueWei,
      );
    } catch (settleErr) {
      const msg = stripSecrets(
        settleErr instanceof Error ? settleErr.message : String(settleErr),
      );
      try {
        appendAudit(config.agentWalletDir, {
          ts: new Date().toISOString(),
          action: "broadcast_settled",
          walletId: record.id,
          address: record.address,
          to: proposal.to,
          valuePls: proposal.valuePls,
          txHash,
          proposalId: proposal.id,
          ok: false,
          detail: `settlement failed after barrier: ${msg}`,
        });
      } catch {
        // ignore
      }
      throw new PolicyError(
        `Transaction accepted by chain (txHash=${txHash}) but local settlement ` +
          `failed for proposal ${proposal.id}: ${msg}. ` +
          `Proposal is non-retryable (status broadcasting). ${NON_RETRYABLE_RECOVERY_HINT}`,
      );
    }

    appendAudit(config.agentWalletDir, {
      ts: new Date().toISOString(),
      action: "execute_tx",
      walletId: record.id,
      address: record.address,
      to: proposal.to,
      valuePls: proposal.valuePls,
      txHash,
      proposalId: proposal.id,
      ok: true,
      detail: `valueWei=${valueWei}; settled=executed`,
    });

    logger.info("Agent tx executed", {
      walletId: record.id,
      txHash,
      to: proposal.to,
      valuePls: proposal.valuePls,
      valueWei: valueWei.toString(),
    });

    return {
      txHash,
      proposalId: proposal.id,
      walletId: record.id,
      from: record.address,
      to: proposal.to,
      valuePls: proposal.valuePls,
      simulation,
    };
  } catch (err) {
    // If barrier already wrote txHash, surface it on failure audit for operators.
    const knownHash = proposal.txHash;
    appendAudit(config.agentWalletDir, {
      ts: new Date().toISOString(),
      action: "execute_tx",
      walletId: record.id,
      address: record.address,
      to: proposal.to,
      valuePls: proposal.valuePls,
      txHash: knownHash,
      proposalId: proposal.id,
      ok: false,
      detail: stripSecrets(
        err instanceof Error ? err.message : String(err),
      ),
    });
    if (err instanceof AppError) throw err;
    throw new RpcError(
      err instanceof Error ? err.message : "Failed to sign/send transaction",
    );
  } finally {
    // Drop reference; cannot truly wipe immutable JS strings
    privateKey = undefined;
  }
}

/**
 * Finish local settlement for a proposal that already has a durable barrier
 * (broadcasting + txHash) without re-broadcasting. Idempotent on spend via
 * appliedSpendProposalIds. Fail-closed if there is no txHash.
 */
export async function settleInterruptedBroadcast(
  config: AppConfig,
  proposalId: string,
  confirm: boolean,
): Promise<{
  proposalId: string;
  walletId: string;
  txHash: `0x${string}`;
  status: "executed";
  alreadySettled: boolean;
  spendApplied: boolean;
  note: string;
}> {
  requireWritable(config);
  if (confirm !== true) {
    throw new PolicyError(
      "settle_interrupted_broadcast requires confirm=true. This never re-broadcasts; " +
        "it only merges local spend (idempotent) and marks executed when txHash is known.",
    );
  }

  const peek = loadProposal(config.agentWalletDir, proposalId);
  return withWalletLock(peek.walletId, async () => {
    const proposal = loadProposal(config.agentWalletDir, proposalId);

    if (proposal.status === "executed" && proposal.txHash) {
      return {
        proposalId: proposal.id,
        walletId: proposal.walletId,
        txHash: proposal.txHash,
        status: "executed" as const,
        alreadySettled: true,
        spendApplied: true,
        note:
          "Proposal already executed; no broadcast and no spend change.",
      };
    }

    if (!proposal.txHash) {
      throw new PolicyError(
        `Cannot settle without txHash (chain accept not recorded): ${proposalId}. ` +
          "If the process crashed after RPC accept but before the barrier, check the " +
          "explorer by from-address/nonce; do not blindly re-execute.",
      );
    }

    if (
      proposal.status !== "broadcasting" &&
      !(proposal.status === "pending" && proposal.txHash)
    ) {
      throw new PolicyError(
        `Proposal status ${proposal.status} is not settleable (need broadcasting + txHash): ${proposalId}`,
      );
    }

    let valueWei: bigint;
    try {
      valueWei = BigInt(proposal.valueWei);
    } catch {
      throw new PolicyError(
        `Proposal ${proposalId} has invalid valueWei (expected integer string)`,
      );
    }

    const before = loadWalletRecord(
      config.agentWalletDir,
      proposal.walletId,
    );
    const alreadyApplied = (before.appliedSpendProposalIds ?? []).includes(
      proposal.id,
    );

    completePostBroadcastSettlement(
      config.agentWalletDir,
      proposal,
      valueWei,
    );

    appendAudit(config.agentWalletDir, {
      ts: new Date().toISOString(),
      action: "broadcast_settled",
      walletId: proposal.walletId,
      address: proposal.from,
      to: proposal.to,
      valuePls: proposal.valuePls,
      txHash: proposal.txHash,
      proposalId: proposal.id,
      ok: true,
      detail: alreadyApplied
        ? "recovery settle; spend already applied (idempotent)"
        : "recovery settle; spend merged + executed",
    });

    return {
      proposalId: proposal.id,
      walletId: proposal.walletId,
      txHash: proposal.txHash,
      status: "executed" as const,
      alreadySettled: false,
      spendApplied: !alreadyApplied,
      note:
        "Local settlement completed without re-broadcast. Verify txHash on explorer.",
    };
  });
}

/**
 * Native PLS transfer: propose + execute in one path with policy + simulation.
 * Entire path is serialized per wallet so propose→execute cannot interleave
 * with a concurrent execute on the same wallet.
 */
export async function transferPls(
  config: AppConfig,
  params: {
    walletId: string;
    to: string;
    amountPls: number | string;
    confirm: boolean;
  },
): Promise<{
  txHash: `0x${string}`;
  proposalId: string;
  walletId: string;
  from: `0x${string}`;
  to: `0x${string}`;
  valuePls: number;
  valueWei: string;
  simulation: SimulationResult;
  policyCheck: ReturnType<typeof evaluatePolicy>;
  reviewSummary: TxReviewSummary;
}> {
  requireWritable(config);
  if (params.confirm !== true) {
    throw new PolicyError(
      "transfer_pls requires confirm=true after reviewing amount and recipient " +
        "(prefer propose_agent_tx → review reviewSummary → execute). " +
        "Operator-trust: funding authorizes; confirm is host UX only.",
    );
  }

  // Validate amount early (clear error before lock work)
  parsePlsToWei(params.amountPls);

  return withWalletLock(params.walletId, async () => {
    const proposal = await proposeAgentTx(config, {
      walletId: params.walletId,
      to: assertAddress(params.to),
      valuePls: params.amountPls,
      data: "0x",
    });

    if (!proposal.policyCheck.allowed) {
      auditPolicyDeny(config, {
        walletId: params.walletId,
        to: proposal.to,
        valuePls: proposal.valuePls,
        proposalId: proposal.id,
        reasons: proposal.policyCheck.reasons,
        action: "transfer_pls",
      });
      const denySummary = proposal.reviewSummary;
      throw new PolicyError(
        `transfer_pls denied: ${proposal.policyCheck.reasons.join("; ")} ` +
          `[${denySummary.headline}]`,
      );
    }

    // Already holding wallet lock — call locked path to avoid re-entrant deadlock
    // (executeAgentTx would wait on the same lock forever).
    const result = await executeAgentTxLocked(config, proposal.id);
    appendAudit(config.agentWalletDir, {
      ts: new Date().toISOString(),
      action: "transfer_pls",
      walletId: result.walletId,
      address: result.from,
      to: result.to,
      valuePls: result.valuePls,
      txHash: result.txHash,
      proposalId: result.proposalId,
      ok: true,
    });

    return {
      ...result,
      valueWei: proposal.valueWei,
      policyCheck: proposal.policyCheck,
      reviewSummary: buildProposalReviewSummary(
        {
          ...proposal,
          // proposal from propose may include reviewSummary; strip for TxProposal shape
          id: proposal.id,
          walletId: proposal.walletId,
          from: proposal.from,
          to: proposal.to,
          valueWei: proposal.valueWei,
          valuePls: proposal.valuePls,
          data: proposal.data,
          createdAt: proposal.createdAt,
          expiresAt: proposal.expiresAt,
          simulation: result.simulation,
          policyCheck: proposal.policyCheck,
          status: "executed",
          txHash: result.txHash,
        },
        "transfer",
      ),
    };
  });
}

/**
 * Scannable operator snapshot for agent_wallet_status (no secrets).
 * Pure: derived from config + ownership view + wallet counts.
 */
export type OperatorPolicyPosture =
  | "disabled"
  | "operator_trust"
  | "tight_defaults"
  | "moderate_defaults"
  | "loose_defaults";

export interface OperatorAtAGlance {
  /** One-line scan result */
  headline: string;
  walletsEnabled: boolean;
  masterKeyConfigured: boolean;
  walletCount: number;
  killedWalletCount: number;
  multiprocRisk: boolean;
  multiprocRiskLevel: MultiprocRiskLevel;
  writesBlocked: boolean;
  multiprocMode: "strict-fail-closed" | "warn-only";
  /**
   * Stored legacy MAX_PLS_* defaults (display only under operator-trust —
   * not hard send gates). See defaultCapsDisplayOnly.
   */
  defaultCaps: { maxPlsPerTx: number; maxPlsDaily: number };
  /** Always true under OT: defaultCaps / maxPls* are non-blocking. */
  defaultCapsDisplayOnly: true;
  /**
   * Trust posture for agent wallets (v0.1.38+: operator_trust when enabled).
   * Legacy tight/moderate/loose labels may still appear in older tests only.
   */
  policyPosture: OperatorPolicyPosture;
  policyPostureNote: string;
  /** Short bullets for agents/operators */
  bullets: string[];
  /** Recommended careful flow */
  safeFlow: string;
  /** Single next action for the operator right now */
  nextAction: string;
}

/**
 * Build concise operator-facing status (pure helper; unit-testable).
 */
export function buildOperatorAtAGlance(params: {
  enabled: boolean;
  masterKeyConfigured: boolean;
  maxPlsPerTx: number;
  maxPlsDaily: number;
  walletCount: number;
  killedWalletCount: number;
  ownership: WalletDirOwnershipStatusView;
}): OperatorAtAGlance {
  const {
    enabled,
    masterKeyConfigured,
    maxPlsPerTx,
    maxPlsDaily,
    walletCount,
    killedWalletCount,
    ownership,
  } = params;

  let policyPosture: OperatorPolicyPosture;
  let policyPostureNote: string;
  if (!enabled) {
    policyPosture = "disabled";
    policyPostureNote =
      "Signing off until AGENT_WALLET_ENABLED=true. " +
      "Operator-trust model when enabled: funding the agent is authorization.";
  } else {
    // Stored MAX_PLS_* / allowlist fields are legacy display only — not hard gates.
    policyPosture = "operator_trust";
    policyPostureNote =
      "Operator-trust mode (v0.1.38+): no hard spend-cap or deny-by-default allowlist gate. " +
      "Funding the agent is authorization. Kill switch remains for emergencies. " +
      `Legacy stored defaults shown as ${maxPlsPerTx}/${maxPlsDaily} PLS (not enforced as backstops).`;
  }

  const multiprocRisk = ownership.multiProcessRisk === true;
  const writesBlocked = ownership.writesBlockedByMultiproc === true;
  const riskLevel = ownership.riskLevel;

  const bullets: string[] = [];
  bullets.push(
    enabled
      ? `Wallets ENABLED (${walletCount} wallet(s)${killedWalletCount ? `, ${killedWalletCount} killed` : ""})`
      : "Wallets DISABLED (read-only status; write tools refuse)",
  );
  bullets.push(
    masterKeyConfigured
      ? "Master key configured (flag only — key never returned)"
      : "Master key NOT configured (required before enable)",
  );
  if (writesBlocked) {
    bullets.push(
      `WRITES BLOCKED by multiproc strict (foreign pid risk) — ${ownership.recommendedAction}`,
    );
  } else if (multiprocRisk) {
    bullets.push(
      `Multiproc WARN (warn-only): shared AGENT_WALLET_DIR risk (level=${riskLevel}) — ` +
        `writes STILL ALLOWED; NOT multi-writer-safe; locks process-local only (not a distributed lock)`,
    );
  } else {
    bullets.push(
      enabled
        ? "Multiproc: OK for this process (owns dir) — still NOT multi-writer-safe if shared; locks process-local only / not a distributed lock"
        : "Multiproc: N/A while wallets disabled — if enabling, use unique AGENT_WALLET_DIR per process (shared dir not multi-writer-safe)",
    );
  }
  bullets.push(
    `Multiproc mode=${ownership.multiprocMode}: ` +
      (ownership.multiprocMode === "strict-fail-closed"
        ? "writes refused on live foreign owner (still not a distributed lock)"
        : "warn-only default — risk is loud but writes proceed unless MULTIPROC_STRICT=true"),
  );
  bullets.push(`Policy posture: ${policyPosture} — ${policyPostureNote}`);
  bullets.push(`Safe flow: ${SAFE_USAGE_PATTERN}`);
  if (enabled) {
    bullets.push(PULSECHAIN_GAS_OPERATOR_NOTE);
    bullets.push(PLS_VALUE_VS_GAS_HINT);
    bullets.push(WALLET_TX_ORDER_HINT);
  }
  bullets.push(
    "confirm=true / MRTR is host UX only; operator-trust: funding the agent is authorization " +
      "(no hard spend-cap/allowlist policy theater). Protect MASTER_KEY; use kill_switch if needed.",
  );

  let headline: string;
  if (!enabled) {
    headline = "Wallets OFF · signing disabled · safe for read-only MCP use";
  } else if (writesBlocked) {
    headline =
      "Wallets ON · WRITES BLOCKED (multiproc strict) · fix unique AGENT_WALLET_DIR";
  } else if (multiprocRisk) {
    headline =
      "Wallets ON · multiproc WARN (shared dir) · prefer unique dir or MULTIPROC_STRICT";
  } else {
    headline = "Wallets ON · multiproc OK · operator-trust (fund = authorize)";
  }

  let nextAction: string;
  if (!enabled) {
    nextAction =
      "Research-only mode (AGENT_WALLET_ENABLED=false). To enable signing: set AGENT_WALLET_ENABLED=true, " +
      "strong MASTER_KEY, unique AGENT_WALLET_DIR per process, MULTIPROC_STRICT=true recommended, " +
      "create_agent_wallet, fund only what you accept the agent may spend (operator-trust).";
  } else if (writesBlocked) {
    nextAction =
      "Stop the other MCP process or switch this process to a unique AGENT_WALLET_DIR; re-check status before any write. " +
      "Strict mode is not a distributed lock — only unique dirs are multi-instance safe.";
  } else if (multiprocRisk) {
    nextAction =
      "STOP sharing this dir: use a unique AGENT_WALLET_DIR now. " +
      "Warn-only still allows writes (easy foot-gun). Prefer AGENT_WALLET_MULTIPROC_STRICT=true " +
      "(refuses writes on conflict; still not a distributed lock).";
  } else if (walletCount === 0) {
    nextAction =
      "create_agent_wallet → fund PLS (value + gas) → " +
      SAFE_USAGE_PATTERN +
      " (operator-trust: funding authorizes; confirm is host UX; kill_switch for emergencies)";
  } else {
    nextAction =
      "Daily: " +
      SAFE_USAGE_PATTERN +
      " (operator-trust; confirm is host UX). " +
      "Ensure in-wallet PLS covers value + PulseChain gas. " +
      "On crash after barrier: settle_interrupted_broadcast (never re-send).";
  }

  return {
    headline,
    walletsEnabled: enabled,
    masterKeyConfigured,
    walletCount,
    killedWalletCount,
    multiprocRisk,
    multiprocRiskLevel: riskLevel,
    writesBlocked,
    multiprocMode: ownership.multiprocMode,
    defaultCaps: { maxPlsPerTx, maxPlsDaily },
    defaultCapsDisplayOnly: true,
    policyPosture,
    policyPostureNote,
    bullets,
    safeFlow: SAFE_USAGE_PATTERN,
    nextAction,
  };
}

/** Status summary without secrets (works even when disabled for diagnostics). */
export function agentWalletSystemStatus(config: AppConfig): Record<string, unknown> {
  let walletCount = 0;
  let killedCount = 0;
  let ownership: OwnershipResult | undefined;
  let ownershipUnavailable = false;
  try {
    if (config.agentWalletEnabled) {
      ownership = ensureWalletDirClaimed(config.agentWalletDir, {
        forceRecheck: true,
      });
      const records = listWalletRecords(config.agentWalletDir);
      walletCount = records.length;
      killedCount = records.filter((r) => r.policy.killed).length;
    }
  } catch {
    walletCount = 0;
    if (config.agentWalletEnabled) ownershipUnavailable = true;
  }
  const multiprocStrict = config.agentWalletMultiprocStrict === true;
  const walletDirOwnership = buildWalletDirOwnershipStatusView(
    ownership,
    multiprocStrict,
    {
      disabled: !config.agentWalletEnabled,
      unavailable: ownershipUnavailable,
    },
  );
  const operatorAtAGlance = buildOperatorAtAGlance({
    enabled: config.agentWalletEnabled,
    masterKeyConfigured: Boolean(config.agentWalletMasterKey),
    maxPlsPerTx: config.maxPlsPerTx,
    maxPlsDaily: config.maxPlsDaily,
    walletCount,
    killedWalletCount: killedCount,
    ownership: walletDirOwnership,
  });
  return {
    enabled: config.agentWalletEnabled,
    walletDir: config.agentWalletDir,
    maxPlsPerTxDefault: config.maxPlsPerTx,
    maxPlsDailyDefault: config.maxPlsDaily,
    /** Operator-trust: maxPls* defaults are display/accounting only — not hard gates. */
    maxPlsDefaultsDisplayOnly: true as const,
    masterKeyConfigured: Boolean(config.agentWalletMasterKey),
    walletCount,
    killedWalletCount: killedCount,
    /**
     * Scannable operator snapshot (read this first).
     * wallets on/off, multiproc risk, writes blocked, policy posture, safe flow.
     */
    operatorAtAGlance,
    /** Present only when enabled — loud operator warning */
    enableWarning: config.agentWalletEnabled
      ? AGENT_WALLET_ENABLE_WARNING
      : undefined,
    /**
     * Ownership marker for multi-process foot-gun detection (not a distributed lock).
     * riskLevel: none | warn | blocked; multiprocStrict refuses writes on conflict.
     */
    walletDirOwnership,
    security: {
      encryption: "AES-256-GCM",
      privateKeysInResponses: false,
      privateKeysInLogs: false,
      trustModel:
        "operator-trust (v0.1.38+): funding the agent is authorization; " +
        "no hard spend-cap or deny-by-default allowlist safety backstop",
      contractDefault:
        "legacy allowlist fields may still be stored but are NOT hard gates",
      tokenAllowlistSemantics: TOKEN_ALLOWLIST_SEMANTICS,
      tokenNotional:
        "advisory decode for reviewSummary only — not a hard deny path; " +
        "priority patterns still decoded for operator visibility",
      agentIntelligence:
        "reviewSummary includes agentGuidance, decodeKnowledge, movementExplanations, safetyHints; " +
        "inspect_tx_intent decodes calldata without wallet (local only, advisory)",
      pulsechainGas:
        PULSECHAIN_GAS_OPERATOR_NOTE +
        " " +
        PLS_VALUE_VS_GAS_HINT +
        " " +
        WALLET_TX_ORDER_HINT,
      spendAccounting:
        "integer wei ledgers (spentWei) for audit visibility; not IEEE-754 float sums; not a hard daily gate",
      executeSerialization:
        "per-wallet async mutex in-process only (NOT cross-process); covers execute, transfer, settle, kill, set_policy, day-roll",
      multiProcessSharedDir: MULTIPROC_POSTURE_SUMMARY,
      multiprocRecommendedModel: MULTIPROC_RECOMMENDED_MODEL,
      multiprocModeMeanings: MULTIPROC_MODE_MEANINGS,
      multiprocStrictDefault: false,
      multiprocStrictDoesNot:
        "does not implement a distributed lock; does not make shared AGENT_WALLET_DIR multi-writer-safe; " +
        "does not serialize writers across processes; " +
        "PID liveness is best-effort (EPERM treated alive; rare PID-reuse residual)",
      walletFileWrites: "temp-file + rename + optional fsync best-effort atomic JSON",
      postBroadcastDurability:
        "1) fsync barrier broadcasting+txHash+broadcastAcceptedAt immediately after send (no other I/O first); " +
        "2) audit broadcast_accepted; 3) re-load wallet + idempotent spend merge (appliedSpendProposalIds) + " +
        "executed fsync; settle_interrupted_broadcast recovers incomplete settlement without re-broadcast",
      residualCrashWindow:
        "after RPC accept before barrier: may leave pending (check explorer by from/nonce; no exactly-once). " +
        "after barrier before settle: non-retryable broadcasting+txHash; spend may undercount until " +
        "settle_interrupted_broadcast. after executed: durable. not distributed exactly-once",
      eoaNativeTransfers:
        "allowed when wallet enabled and not killed (operator-trust)",
      killSwitch:
        "optional emergency: sets killed=true, enabled=false (under wallet lock)",
      confirmRequired:
        "confirm=true or MRTR elicitation for writes (host UX only — not cryptographic operator intent)",
      confirmHostStrengthOnly: true,
      recommendation:
        "Wallets are on by default (master key required). For research-only set AGENT_WALLET_ENABLED=false. " +
        "When enabled: fund only what you accept the agent may spend (operator-trust). " +
        `${MULTIPROC_RECOMMENDED_MODEL}; ` +
        "set AGENT_WALLET_MULTIPROC_STRICT=true when multiple hosts might share a path. " +
        `Safe flow: ${SAFE_USAGE_PATTERN}. Protect MASTER_KEY; use kill_switch if compromised.`,
      safeFlow: SAFE_USAGE_PATTERN,
      reviewSummary:
        "propose/check/execute/transfer attach reviewSummary: destination, native PLS value, " +
        "token movements, safetyHints (PulseChain gas / value vs gas / total available), " +
        "checksApplied, decisionTrace, confirmRationale, policyBackstop (operator-trust note), nextStep, " +
        "simulation.gasEstimate (units) + optional simulation.estimatedFeePlsApprox (approx PLS fee; non-blocking), " +
        "remainingDailyIsDisplayOnly / legacyCapsDisplayOnly (maxPls* not hard gates)",
    },
  };
}

/** Format wei for display helpers */
export function formatPlsFromWei(wei: string): string {
  return formatEther(BigInt(wei));
}
