#!/usr/bin/env node
/**
 * Write-only .env.wallet ceremony (agent-safe).
 *
 *   node scripts/generate-wallet-env.mjs
 *
 * - Creates .env.wallet from .env.wallet.example if missing
 * - Refuses if .env.wallet already exists (no overwrite)
 * - Writes master key to the file only
 * - Prints success WITHOUT printing the key
 * - Sets file mode 600 / dir 700 where the OS supports it
 *
 * Do NOT: console.log the key, paste into chat, read_file to "verify".
 * Verify with: Test-Path / test -f .env.wallet, then post-reload agent_wallet_status.
 */
import { resolve } from "node:path";
import {
  createWalletEnvWriteOnly,
  looksLikeMasterKeyHex,
  defaultPackageRoot,
} from "./lib/wallet-env.mjs";

const cloneRoot =
  process.argv.includes("--clone-root")
    ? resolve(process.argv[process.argv.indexOf("--clone-root") + 1])
    : process.cwd();

// Allow running from package root even if cwd is elsewhere when invoked via path
const root =
  process.argv.includes("--package-root")
    ? resolve(process.argv[process.argv.indexOf("--package-root") + 1])
    : cloneRoot;

const result = createWalletEnvWriteOnly({ cloneRoot: root });

for (const m of result.messages) {
  if (looksLikeMasterKeyHex(m)) {
    process.stderr.write(
      JSON.stringify({ error: "internal: refused to print key-shaped message" }) +
        "\n",
    );
    process.exit(2);
  }
  process.stdout.write(m + "\n");
}

if (!result.ok) {
  process.stderr.write(
    JSON.stringify({ error: result.error, code: result.code }) + "\n",
  );
  process.exit(1);
}

process.exit(0);
