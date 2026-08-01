/**
 * Wallet-mode MCP entry (preferred host path when agent wallets are enabled).
 *
 * Loads a local wallet env file (gitignored), forces a unique wallet data dir
 * + multiproc strict, then starts `dist/index.js`.
 *
 * Host config (Grok / Claude / Cursor):
 *   command = node
 *   args    = ["<ABS_CLONE_ROOT>/scripts/start-wallet-mcp.mjs"]
 *
 * Env file resolution (first match wins):
 *   1. .env.wallet
 *   2. .env.lab   (compatibility filename for existing local installs only)
 *
 * Read-only / research hosts should keep pointing at dist/index.js with
 * AGENT_WALLET_ENABLED=false (see examples/*).
 *
 * Prerequisites: npm run build (dist/index.js must exist); create .env.wallet
 * with write-only ceremony (never prints the key; never commit):
 *   node scripts/generate-wallet-env.mjs
 * Prefer host entry via scripts/install-for-host.mjs --mode wallets.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const walletEnvPath = resolve(root, ".env.wallet");
const labEnvPath = resolve(root, ".env.lab");
const envPath = existsSync(walletEnvPath)
  ? walletEnvPath
  : existsSync(labEnvPath)
    ? labEnvPath
    : null;
const distEntry = resolve(root, "dist/index.js");

if (!envPath) {
  console.error(
    JSON.stringify({
      error: "Wallet env missing",
      hint: "Run: node scripts/generate-wallet-env.mjs (write-only; never prints the key)",
      tried: [walletEnvPath, labEnvPath],
    }),
  );
  process.exit(1);
}

if (!existsSync(distEntry)) {
  console.error(
    JSON.stringify({
      error: "dist/index.js missing",
      hint: "Run npm run build from the clone root before starting the wallet MCP",
      path: distEntry,
    }),
  );
  process.exit(1);
}

for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
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
  if (key) process.env[key] = val;
}

// Prefer env-specified dir; otherwise dedicated wallet data path (absolute).
const configuredDir = process.env.AGENT_WALLET_DIR?.trim();
process.env.AGENT_WALLET_DIR = configuredDir
  ? resolve(root, configuredDir)
  : resolve(root, "data/wallets");
process.env.AGENT_WALLET_ENABLED = process.env.AGENT_WALLET_ENABLED ?? "true";
process.env.AGENT_WALLET_MULTIPROC_STRICT =
  process.env.AGENT_WALLET_MULTIPROC_STRICT ?? "true";
// Mark launcher for status / logs (no secrets). Product + legacy env names.
process.env.PULSECHAIN_WALLET_LAUNCHER = "true";
process.env.PULSECHAIN_LAB_LAUNCHER = "true";

// stderr only — never stdout (MCP stdio reserves stdout for JSON-RPC)
console.error(
  JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    msg: "wallet launcher: loading dist/index.js with agent wallets enabled",
    walletLauncher: true,
    envFile: envPath,
    walletDir: process.env.AGENT_WALLET_DIR,
    multiprocStrict: process.env.AGENT_WALLET_MULTIPROC_STRICT === "true",
    walletsEnabled: process.env.AGENT_WALLET_ENABLED === "true",
  }),
);

await import(pathToFileURL(distEntry).href);
