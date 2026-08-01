#!/usr/bin/env node
/**
 * Agent-safe host installer for pulsechain-mcp.
 *
 *   node scripts/install-for-host.mjs --host grok --mode research
 *   node scripts/install-for-host.mjs --host grok --mode wallets
 *
 * Never prints master keys. Never embeds secrets in host config.
 * See docs/BOOTSTRAP.md.
 */
import { resolve } from "node:path";
import {
  installForHost,
  parseInstallArgs,
  installHelpText,
  HOSTS,
  MODES,
} from "./lib/install-for-host-core.mjs";

const args = parseInstallArgs(process.argv.slice(2));

if (args.help || !args.host || !args.mode) {
  process.stdout.write(installHelpText());
  process.exit(args.help ? 0 : 1);
}

const result = installForHost({
  cloneRoot: args.cloneRoot ? resolve(args.cloneRoot) : process.cwd(),
  host: args.host,
  mode: args.mode,
  outPath: args.outPath,
  writeHostConfig: !args.noWrite,
  createKeyIfMissing: !args.noKey,
});

for (const m of result.messages) {
  process.stdout.write(m + "\n");
}

if (!result.ok) {
  process.stderr.write(
    JSON.stringify({
      error: result.error ?? "install failed",
      code: result.code,
    }) + "\n",
  );
  process.exit(1);
}

process.exit(0);

// re-export metadata for discoverability
void HOSTS;
void MODES;
