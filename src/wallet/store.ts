/**
 * Encrypted wallet file store + append-only audit log.
 * Default dir: ./data/wallets (gitignored via data/wallets/).
 * Wallet/proposal JSON uses temp-file + rename for best-effort atomic writes.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AppError, ConfigError } from "../utils/errors.js";
import { stripSecrets } from "../utils/safety.js";
import {
  normalizeDailySpend,
  normalizePolicy,
  normalizeTokenDailySpend,
} from "./policy.js";
import type {
  AgentWalletRecord,
  AuditEntry,
  TxProposal,
} from "./types.js";

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function walletPath(dir: string, id: string): string {
  // Prevent path traversal
  if (!/^aw_[a-f0-9]{32}$/.test(id)) {
    throw new AppError(`Invalid wallet id: ${id}`, "VALIDATION_ERROR");
  }
  return join(dir, `${id}.json`);
}

function proposalPath(dir: string, id: string): string {
  if (!/^prop_[a-f0-9]{24}$/.test(id)) {
    throw new AppError(`Invalid proposal id: ${id}`, "VALIDATION_ERROR");
  }
  return join(dir, "proposals", `${id}.json`);
}

/**
 * Best-effort fsync of a file path (durability for post-broadcast barriers).
 * No-op on failure — never blocks progress for optional fsync.
 */
export function fsyncPathBestEffort(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // ignore — platform / FS may not support
  }
}

/**
 * Best-effort atomic write: same-directory temp file + optional fsync + rename.
 * On Windows, rename-over-existing may fail — falls back to unlink+rename
 * or direct write (still same-process last-write-wins under withWalletLock).
 *
 * @param opts.fsync when true (default for barrier writes), fsync temp before rename
 */
export function atomicWriteJson(
  path: string,
  value: unknown,
  opts?: { fsync?: boolean },
): void {
  const data = JSON.stringify(value, null, 2);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  if (opts?.fsync) {
    fsyncPathBestEffort(tmp);
  }
  try {
    renameSync(tmp, path);
  } catch {
    try {
      if (existsSync(path)) {
        unlinkSync(path);
      }
      renameSync(tmp, path);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // ignore cleanup
      }
      // Last resort: direct write (non-atomic)
      writeFileSync(path, data, { mode: 0o600 });
      if (opts?.fsync) {
        fsyncPathBestEffort(path);
      }
    }
  }
}

export function ensureWalletDir(dir: string): void {
  ensureDir(dir);
  ensureDir(join(dir, "proposals"));
}

export function saveWalletRecord(
  dir: string,
  record: AgentWalletRecord,
): void {
  ensureWalletDir(dir);
  const path = walletPath(dir, record.id);
  // Never include plaintext keys — record.encryptedKey only
  atomicWriteJson(path, record);
}

export function loadWalletRecord(
  dir: string,
  id: string,
): AgentWalletRecord {
  const path = walletPath(dir, id);
  if (!existsSync(path)) {
    throw new AppError(`Wallet not found: ${id}`, "NOT_FOUND");
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as AgentWalletRecord;
    // Migrate older records missing hardened policy fields / wei ledgers
    parsed.policy = normalizePolicy(parsed.policy);
    parsed.dailySpend = normalizeDailySpend(
      parsed.dailySpend ?? { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
    );
    parsed.tokenDailySpend = normalizeTokenDailySpend(
      parsed.tokenDailySpend ?? {},
    );
    return parsed;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new ConfigError(
      `Failed to load wallet ${id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function listWalletRecords(dir: string): AgentWalletRecord[] {
  ensureWalletDir(dir);
  const files = readdirSync(dir).filter(
    (f) => f.startsWith("aw_") && f.endsWith(".json"),
  );
  const out: AgentWalletRecord[] = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    try {
      out.push(loadWalletRecord(dir, id));
    } catch {
      // skip corrupt
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function saveProposal(
  dir: string,
  proposal: TxProposal,
  opts?: { fsync?: boolean },
): void {
  ensureWalletDir(dir);
  atomicWriteJson(proposalPath(dir, proposal.id), proposal, opts);
}

/**
 * Persist non-retryable post-broadcast barrier as quickly as practical:
 * status broadcasting + txHash + broadcastAcceptedAt (+ existing proposal fields),
 * fsync'd. Call immediately after sendTransaction returns — no other I/O first
 * (no spend merge, no audit, no wallet reload before this returns).
 */
export function persistBroadcastBarrier(
  dir: string,
  proposal: TxProposal,
  txHash: `0x${string}`,
): TxProposal {
  proposal.status = "broadcasting";
  proposal.txHash = txHash;
  proposal.broadcastAcceptedAt =
    proposal.broadcastAcceptedAt ?? new Date().toISOString();
  saveProposal(dir, proposal, { fsync: true });
  return proposal;
}

/**
 * Promote a barrier'd proposal to executed (fsync). Does not touch spend.
 * Prefer completePostBroadcastSettlement in service for the full path.
 */
export function persistProposalExecuted(
  dir: string,
  proposal: TxProposal,
): TxProposal {
  if (!proposal.txHash) {
    throw new AppError(
      `Cannot mark executed without txHash: ${proposal.id}`,
      "VALIDATION_ERROR",
    );
  }
  proposal.status = "executed";
  saveProposal(dir, proposal, { fsync: true });
  return proposal;
}

export function loadProposal(dir: string, id: string): TxProposal {
  const path = proposalPath(dir, id);
  if (!existsSync(path)) {
    throw new AppError(`Proposal not found: ${id}`, "NOT_FOUND");
  }
  return JSON.parse(readFileSync(path, "utf8")) as TxProposal;
}

/** Append-only audit log (JSON lines). Never includes private keys. */
export function appendAudit(dir: string, entry: AuditEntry): void {
  ensureWalletDir(dir);
  const path = join(dir, "audit.jsonl");
  // Defense: strip any accidental secret fields from detail and known keys
  const scrubbed = stripSecrets({
    ts: entry.ts,
    action: entry.action,
    walletId: entry.walletId,
    address: entry.address,
    to: entry.to,
    valuePls: entry.valuePls,
    txHash: entry.txHash,
    proposalId: entry.proposalId,
    ok: entry.ok,
    detail: entry.detail,
  }) as AuditEntry;
  appendFileSync(path, `${JSON.stringify(scrubbed)}\n`, { mode: 0o600 });
}

export function readAuditLog(dir: string, limit = 100): AuditEntry[] {
  const path = join(dir, "audit.jsonl");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const slice = lines.slice(-limit);
  return slice.map((l) => JSON.parse(l) as AuditEntry);
}
