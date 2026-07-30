/**
 * Compatibility entry → scripts/start-wallet-mcp.mjs
 *
 * Prefer start-wallet-mcp.mjs in new host configs. This file remains so
 * existing operator host entries keep working without a forced rewrite.
 */
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const walletLauncher = resolve(root, "start-wallet-mcp.mjs");

// stderr only
console.error(
  JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    msg: "start-lab-mcp.mjs is a compatibility alias; prefer scripts/start-wallet-mcp.mjs",
    walletLauncher: true,
  }),
);

await import(pathToFileURL(walletLauncher).href);
