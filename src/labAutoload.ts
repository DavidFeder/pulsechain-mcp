/**
 * Optional wallet-env bootstrap for hosts that sticky-spawn bare dist/index.js.
 *
 * Preferred wallet path remains scripts/start-wallet-mcp.mjs (loads env always).
 * This module only runs when the operator opts in via a gitignored marker plus
 * a present gitignored wallet env file. Prefer scripts/start-wallet-mcp.mjs;
 * product default is wallets-on when AGENT_WALLET_ENABLED is unset (master key required).
 *
 * Markers (either):
 *   data/wallets/.enable-wallet-autoload
 *   data/wallets-lab/.enable-lab-autoload   (compat path for existing installs)
 * Env files (either):
 *   .env.wallet
 *   .env.lab   (compat filename for existing installs)
 *
 * Never logs secret values. Survives clean tsc rebuild (lives in src/).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WALLET_MARKER = ".enable-wallet-autoload";
const LEGACY_MARKER = ".enable-lab-autoload";

/** Resolve repo root from this module (src/ or dist/). */
function repoRoot(): string {
  // dist/labAutoload.js → .. ; src/labAutoload.ts compiled similarly under dist/
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function loadEnvFile(path: string): void {
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // Do not override host-provided env (dotenv default). A sticky host that
    // set AGENT_WALLET_ENABLED=false must stay research-only.
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/**
 * If wallet autoload marker + env file exist, apply wallet env
 * (same rules as start-wallet-mcp). Idempotent; no-op when marker absent
 * (RO default preserved).
 */
export function applyLabAutoloadIfEnabled(rootDir?: string): {
  applied: boolean;
  reason: string;
  walletDir?: string;
} {
  // start-wallet-mcp / start-lab-mcp already applied env
  if (
    process.env.PULSECHAIN_WALLET_LAUNCHER === "true" ||
    process.env.PULSECHAIN_LAB_LAUNCHER === "true"
  ) {
    return { applied: false, reason: "already_wallet_launcher" };
  }

  const root = rootDir ?? repoRoot();
  const walletEnv = resolve(root, ".env.wallet");
  const labEnv = resolve(root, ".env.lab");
  const envPath = existsSync(walletEnv)
    ? walletEnv
    : existsSync(labEnv)
      ? labEnv
      : null;

  const markers = [
    {
      path: resolve(root, "data", "wallets", WALLET_MARKER),
      dir: resolve(root, "data", "wallets"),
    },
    {
      path: resolve(root, "data", "wallets-lab", LEGACY_MARKER),
      dir: resolve(root, "data", "wallets-lab"),
    },
  ];
  const hit = markers.find((m) => existsSync(m.path));

  if (!hit) {
    return { applied: false, reason: "no_marker" };
  }
  if (!envPath) {
    return { applied: false, reason: "marker_without_wallet_env" };
  }

  loadEnvFile(envPath);

  const configuredDir = process.env.AGENT_WALLET_DIR?.trim();
  const walletDir = configuredDir
    ? resolve(root, configuredDir)
    : hit.dir;
  process.env.AGENT_WALLET_DIR = walletDir;
  process.env.AGENT_WALLET_ENABLED = process.env.AGENT_WALLET_ENABLED ?? "true";
  process.env.AGENT_WALLET_MULTIPROC_STRICT =
    process.env.AGENT_WALLET_MULTIPROC_STRICT ?? "true";
  process.env.PULSECHAIN_WALLET_LAUNCHER = "true";
  process.env.PULSECHAIN_LAB_LAUNCHER = "true";

  return { applied: true, reason: "marker_and_wallet_env", walletDir };
}

/** @deprecated Prefer wallet marker; kept for internal/compat references. */
export const LAB_AUTOLOAD_MARKER = LEGACY_MARKER;
export const WALLET_AUTOLOAD_MARKER = WALLET_MARKER;
