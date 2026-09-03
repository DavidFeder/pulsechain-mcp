/**
 * Best-effort AGENT_WALLET_DIR ownership marker for multi-process foot-gun detection.
 *
 * This is NOT a distributed lock. It only detects when another live process
 * appears to own the same wallet directory and surfaces warnings. Process-local
 * withWalletLock still does not serialize across processes.
 *
 * Stale markers (dead PID) are reclaimed. Residual: rare false positives if a
 * new process reuses a PID before the marker is rewritten (documented).
 */

import {
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { logger } from "../logger.js";
import { atomicWriteJson, ensureWalletDir } from "./store.js";
import {
  MULTIPROC_POSTURE_SUMMARY,
  MULTIPROC_RECOMMENDED_MODEL,
} from "./types.js";

/** Marker filename inside AGENT_WALLET_DIR (dotfile-ish; not a wallet record). */
export const WALLET_DIR_OWNER_FILENAME = ".mcp-wallet-owner.json";

export interface WalletDirOwner {
  /** Process id that claimed the directory */
  pid: number;
  /** Random per-process id (survives PID reuse within one process lifetime) */
  ownerId: string;
  /** ISO timestamp when this process claimed */
  startedAt: string;
  /** Best-effort host name for operator diagnostics */
  hostname?: string;
}

export type OwnershipStatus =
  | "acquired"
  | "reclaimed"
  | "ours"
  | "conflict";

export interface OwnershipResult {
  owner: WalletDirOwner;
  status: OwnershipStatus;
  previous?: WalletDirOwner;
  /** Operator-facing warning when multi-process risk is detected or reclaim happens */
  warning?: string;
  /** True when another live process appears to share this directory */
  multiProcessRisk: boolean;
}

/** Operator-visible multiproc risk level for status payloads. */
export type MultiprocRiskLevel = "none" | "warn" | "blocked";

/**
 * Structured ownership view for agent_wallet_status (and tests).
 * Honest about process-local locks — not multi-writer-safe.
 */
export interface WalletDirOwnershipStatusView {
  status: OwnershipStatus | "disabled" | "unavailable";
  multiProcessRisk: boolean;
  multiprocStrict: boolean;
  multiprocMode: "strict-fail-closed" | "warn-only";
  writesBlockedByMultiproc: boolean;
  riskLevel: MultiprocRiskLevel;
  thisProcessPid: number;
  ownerPid?: number;
  ownerIdPrefix?: string;
  foreignOwner?: {
    pid: number;
    ownerIdPrefix: string;
    startedAt: string;
    hostname?: string;
  };
  warning?: string;
  recommendedAction: string;
  recommendedModel: string;
  locksAreProcessLocalOnly: true;
  notADistributedLock: true;
  posture: string;
}

/**
 * Build operator-facing ownership status fields from a claim result.
 * Pure: no I/O. Used by agent_wallet_status and unit tests.
 */
export function buildWalletDirOwnershipStatusView(
  ownership: OwnershipResult | undefined,
  multiprocStrict: boolean,
  opts?: { disabled?: boolean; unavailable?: boolean },
): WalletDirOwnershipStatusView {
  const multiprocMode = multiprocStrict
    ? ("strict-fail-closed" as const)
    : ("warn-only" as const);
  const base = {
    multiprocStrict,
    multiprocMode,
    thisProcessPid: process.pid,
    recommendedModel: MULTIPROC_RECOMMENDED_MODEL,
    locksAreProcessLocalOnly: true as const,
    notADistributedLock: true as const,
    posture: MULTIPROC_POSTURE_SUMMARY,
  };

  if (opts?.disabled || !ownership) {
    return {
      ...base,
      status: opts?.unavailable ? "unavailable" : "disabled",
      multiProcessRisk: false,
      writesBlockedByMultiproc: false,
      riskLevel: "none",
      recommendedAction:
        "When enabling wallets: one MCP process → one unique AGENT_WALLET_DIR " +
        "(shared dir is NOT multi-writer-safe; locks are process-local only — not a distributed lock). " +
        "Wallets-on default is AGENT_WALLET_MULTIPROC_STRICT=true (unset/empty). " +
        "Explicit false or 0 stays warn-only (writes still allowed on conflict — easy to miss). " +
        "Strict is still not multi-writer-safe if you keep sharing the dir.",
    };
  }

  const multiProcessRisk = ownership.multiProcessRisk === true;
  const writesBlockedByMultiproc = multiprocStrict && multiProcessRisk;
  const riskLevel: MultiprocRiskLevel = writesBlockedByMultiproc
    ? "blocked"
    : multiProcessRisk
      ? "warn"
      : "none";

  let recommendedAction: string;
  if (writesBlockedByMultiproc) {
    recommendedAction =
      "STOP: wallet writes are refused. Use a unique AGENT_WALLET_DIR for this process " +
      "or stop the other live owner (foreign pid=" +
      ownership.owner.pid +
      "). " +
      "Strict mode is not a distributed lock — only unique dirs are multi-instance safe.";
  } else if (multiProcessRisk) {
    recommendedAction =
      "WARN (warn-only mode): another live process appears to own this AGENT_WALLET_DIR " +
      "(foreign pid=" +
      ownership.owner.pid +
      "). " +
      "Writes are STILL ALLOWED under explicit warn-only (AGENT_WALLET_MULTIPROC_STRICT=false or 0) — " +
      "double-spend / race risk is real. Use a unique dir per process now. " +
      "Wallets-on default is STRICT=true; this process opted out (strict is still not a distributed lock).";
  } else {
    recommendedAction =
      "OK: this process owns AGENT_WALLET_DIR. Keep one process per unique directory. " +
      "Locks remain process-local only — never share this dir with another MCP process.";
  }

  const foreignOwner = multiProcessRisk
    ? {
        pid: ownership.owner.pid,
        ownerIdPrefix: ownership.owner.ownerId.slice(0, 8),
        startedAt: ownership.owner.startedAt,
        hostname: ownership.owner.hostname,
      }
    : undefined;

  return {
    ...base,
    status: ownership.status,
    multiProcessRisk,
    writesBlockedByMultiproc,
    riskLevel,
    ownerPid: ownership.owner.pid,
    ownerIdPrefix: ownership.owner.ownerId.slice(0, 8),
    foreignOwner,
    warning: ownership.warning,
    recommendedAction,
  };
}

let processOwnerId: string | null = null;

/** Stable for this Node process (testable via reset). */
export function getProcessOwnerId(): string {
  if (!processOwnerId) {
    processOwnerId = randomBytes(8).toString("hex");
  }
  return processOwnerId;
}

/** @internal tests */
export function resetWalletDirOwnershipForTests(): void {
  processOwnerId = null;
  claimCache.clear();
  lastWarnedKey.clear();
}

/**
 * Portable liveness check: process.kill(pid, 0).
 * - ESRCH → dead
 * - EPERM → exists but not signalable (treat as alive)
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "EPERM") return true;
    return false;
  }
}

export function parseOwnerRecord(raw: unknown): WalletDirOwner | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const pid = o.pid;
  const ownerId = o.ownerId;
  const startedAt = o.startedAt;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof ownerId !== "string" || ownerId.length < 4) return null;
  if (typeof startedAt !== "string" || !startedAt) return null;
  const host =
    typeof o.hostname === "string" && o.hostname ? o.hostname : undefined;
  return { pid, ownerId, startedAt, hostname: host };
}

export function ownerMarkerPath(dir: string): string {
  return join(dir, WALLET_DIR_OWNER_FILENAME);
}

export function readOwnerMarker(dir: string): WalletDirOwner | null {
  const path = ownerMarkerPath(dir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseOwnerRecord(raw);
  } catch {
    return null;
  }
}

export function writeOwnerMarker(dir: string, owner: WalletDirOwner): void {
  ensureWalletDir(dir);
  atomicWriteJson(ownerMarkerPath(dir), owner, { fsync: true });
}

function buildOurs(): WalletDirOwner {
  return {
    pid: process.pid,
    ownerId: getProcessOwnerId(),
    startedAt: new Date().toISOString(),
    hostname: hostname(),
  };
}

/**
 * Claim or inspect ownership of AGENT_WALLET_DIR.
 * On conflict with a live foreign PID, does not overwrite the marker.
 */
export function claimWalletDirOwnership(dir: string): OwnershipResult {
  ensureWalletDir(dir);
  const ours = buildOurs();
  const existing = readOwnerMarker(dir);

  if (!existing) {
    writeOwnerMarker(dir, ours);
    return {
      owner: ours,
      status: "acquired",
      multiProcessRisk: false,
    };
  }

  // Same process (ownerId match or same pid)
  if (
    existing.ownerId === ours.ownerId ||
    existing.pid === process.pid
  ) {
    // Refresh marker (pid/timestamp) without changing ownerId
    const refreshed: WalletDirOwner = {
      ...ours,
      ownerId: existing.ownerId === ours.ownerId ? existing.ownerId : ours.ownerId,
      startedAt: existing.startedAt,
    };
    writeOwnerMarker(dir, refreshed);
    return {
      owner: refreshed,
      status: "ours",
      multiProcessRisk: false,
    };
  }

  if (isPidAlive(existing.pid)) {
    const hostHint = existing.hostname ? `, hostname=${existing.hostname}` : "";
    const warning =
      `SECURITY WARNING: AGENT_WALLET_DIR appears shared with another live process ` +
      `(foreign pid=${existing.pid}, ownerId=${existing.ownerId.slice(0, 8)}…${hostHint}). ` +
      `Wallet execute/kill/policy locks are process-local only — concurrent writers ` +
      `can double-broadcast, race daily caps, or undo kill/policy. ` +
      `Recommended model: one MCP process → one unique AGENT_WALLET_DIR. ` +
      `Wallets-on default is AGENT_WALLET_MULTIPROC_STRICT=true (writes refused on conflict). ` +
      `Explicit false or 0 is warn-only. See docs/SECURITY.md (multi-process). ` +
      `This is NOT a distributed lock.`;
    return {
      owner: existing,
      status: "conflict",
      previous: existing,
      warning,
      multiProcessRisk: true,
    };
  }

  // Stale PID — reclaim
  writeOwnerMarker(dir, ours);
  return {
    owner: ours,
    status: "reclaimed",
    previous: existing,
    multiProcessRisk: false,
    warning:
      `Reclaimed AGENT_WALLET_DIR ownership from stale process marker ` +
      `(dead pid=${existing.pid}). Process-local locks apply to this instance only.`,
  };
}

const claimCache = new Map<string, OwnershipResult>();
const lastWarnedKey = new Set<string>();

/**
 * Ensure ownership has been evaluated for this wallet dir.
 * Caches non-conflict results; re-checks conflicts so a dead peer can be reclaimed.
 * Logs a warning at most once per (dir, status, peer pid) key unless forceLog.
 */
export function ensureWalletDirClaimed(
  dir: string,
  opts?: { forceRecheck?: boolean; quiet?: boolean },
): OwnershipResult {
  const key = resolve(dir);
  const cached = claimCache.get(key);
  if (
    cached &&
    !opts?.forceRecheck &&
    cached.status !== "conflict"
  ) {
    return cached;
  }

  const result = claimWalletDirOwnership(dir);
  claimCache.set(key, result);

  if (result.warning && !opts?.quiet) {
    const warnKey = `${key}|${result.status}|${result.previous?.pid ?? result.owner.pid}`;
    if (!lastWarnedKey.has(warnKey)) {
      lastWarnedKey.add(warnKey);
      logger.warn(result.warning, {
        walletDir: dir,
        ownershipStatus: result.status,
        multiProcessRisk: result.multiProcessRisk,
        ownerPid: result.owner.pid,
      });
    }
  }

  return result;
}

/** Drop ownership marker file (tests / explicit release). Does not kill peers. */
export function clearOwnerMarker(dir: string): void {
  const path = ownerMarkerPath(dir);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // ignore
  }
  claimCache.delete(resolve(dir));
}
