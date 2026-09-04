/**
 * Client-host compatibility helpers (Cursor, Grok Build, Claude Desktop).
 * Pure strings/checks only — no I/O. Used for startup messages and tests.
 */

/** Env keys that break stdio MCP hosts when set for Cursor/Grok/Claude. */
export const STDIO_HOST_FORBIDDEN_ENV = ["HTTP_TRANSPORT_PORT"] as const;

/**
 * Product-safe env keys for example client configs.
 * Agent install default is research-only; wallets-on uses launcher + .env.wallet.
 */
export const STDIO_HOST_SAFE_ENV_DEFAULTS = {
  AGENT_WALLET_ENABLED: "false",
  LOG_LEVEL: "info",
} as const;

/**
 * Human-readable fatal-start hint for stderr when loadConfig/startup fails.
 * Mentions common Cursor / Grok / Claude misconfigurations.
 */
export function formatFatalStartupHint(options?: {
  /** When true, mention that HTTP_TRANSPORT_PORT disables stdio */
  mentionHttpPort?: boolean;
}): string {
  const parts = [
    "Fix environment variables (see .env.example and examples/README.md).",
    "Common issues: missing npm run build (dist/index.js), non-absolute args path,",
    "invalid PULSECHAIN_RPC_URLS, wallets on without/short MASTER_KEY,",
    "bad LOG_LEVEL, or HTTP_TRANSPORT_PORT set on a stdio host.",
    "Cursor / Grok Build / Claude Desktop use stdio — do not set HTTP_TRANSPORT_PORT.",
    "Agent install default: research-only (AGENT_WALLET_ENABLED=false). For signing:",
    "scripts/start-wallet-mcp.mjs + gitignored .env.wallet (generate-wallet-env.mjs write-only).",
    "Never put AGENT_WALLET_MASTER_KEY in host config or chat.",
    "With wallets on: unique AGENT_WALLET_DIR per process; MULTIPROC_STRICT defaults true (explicit false stays warn-only); " +
      "then agent_wallet_status → create → fund → inspect/propose/review/execute.",
  ];
  if (options?.mentionHttpPort === false) {
    return parts.filter((p) => !p.includes("HTTP_TRANSPORT_PORT")).join(" ");
  }
  return parts.join(" ");
}

/**
 * Startup banner meta for logs (stderr). Helps operators confirm transport mode.
 */
export function describeTransportMode(httpTransportPort: number | undefined): {
  mode: "stdio" | "http";
  clientNote: string;
} {
  if (httpTransportPort !== undefined) {
    return {
      mode: "http",
      clientNote:
        `HTTP-only on 127.0.0.1:${httpTransportPort} — not for Cursor/Grok/Claude stdio hosts`,
    };
  }
  return {
    mode: "stdio",
    clientNote:
      "stdio dual-era MCP for Cursor / Grok Build / Claude Desktop (stdout = protocol only)",
  };
}

/**
 * True when example client config text is stdio-safe under:
 * - research-only (wallets off, no master key) — agent install default samples
 * - wallets-on via launcher (start-wallet-mcp.mjs, no master key in host config)
 * - discouraged wallets-on with REPLACE_ master-key placeholder still accepted if present
 *
 * Used by structural tests against files under examples/.
 */
export function isStdioClientConfigSafe(source: string): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  // Strip # comments so docs lines (e.g. research-only false) do not confuse TOML samples
  const text = source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");

  if (/HTTP_TRANSPORT_PORT\s*[=:]/.test(text)) {
    reasons.push("must not set HTTP_TRANSPORT_PORT for stdio hosts");
  }

  const walletOff =
    /AGENT_WALLET_ENABLED"\s*:\s*"false"/i.test(text) ||
    /AGENT_WALLET_ENABLED\s*=\s*"false"/i.test(text);
  const walletOn =
    /AGENT_WALLET_ENABLED"\s*:\s*"true"/i.test(text) ||
    /AGENT_WALLET_ENABLED\s*=\s*"true"/i.test(text);
  const usesLauncher =
    /start-wallet-mcp\.mjs/.test(text) || /start-lab-mcp\.mjs/.test(text);

  const hasMasterKeyAssign =
    /AGENT_WALLET_MASTER_KEY"\s*:\s*"/i.test(text) ||
    /AGENT_WALLET_MASTER_KEY\s*=\s*"/i.test(text);
  const hasReplaceMasterKey =
    /AGENT_WALLET_MASTER_KEY"\s*:\s*"REPLACE_/i.test(text) ||
    /AGENT_WALLET_MASTER_KEY\s*=\s*"REPLACE_/i.test(text);
  const hasRealHexMasterKey =
    /AGENT_WALLET_MASTER_KEY"\s*:\s*"[0-9a-fA-F]{64}"/i.test(text) ||
    /AGENT_WALLET_MASTER_KEY\s*=\s*"[0-9a-fA-F]{64}"/i.test(text);

  if (hasRealHexMasterKey) {
    reasons.push("examples must not embed a real 64-char hex master key");
  }

  if (walletOn && walletOff) {
    reasons.push("AGENT_WALLET_ENABLED cannot be both true and false");
  } else if (usesLauncher) {
    // Recommended wallets-on: launcher loads .env.wallet — host must not embed real keys.
    // REPLACE_ placeholder is also discouraged but still accepted for legacy samples.
    if (hasMasterKeyAssign && !hasReplaceMasterKey && !hasRealHexMasterKey) {
      // empty or non-REPLACE value
      const emptyOrOther =
        /AGENT_WALLET_MASTER_KEY"\s*:\s*""/i.test(text) ||
        /AGENT_WALLET_MASTER_KEY\s*=\s*""/i.test(text);
      if (!emptyOrOther && hasMasterKeyAssign && !hasReplaceMasterKey) {
        reasons.push(
          "launcher host configs should omit AGENT_WALLET_MASTER_KEY (use .env.wallet)",
        );
      }
    }
  } else if (walletOn) {
    // Discouraged alternate: inline master key must be REPLACE_ placeholder only
    if (!hasMasterKeyAssign) {
      reasons.push(
        'wallets-on host configs without launcher must set AGENT_WALLET_MASTER_KEY to a REPLACE_ placeholder, or use scripts/start-wallet-mcp.mjs',
      );
    } else if (!hasReplaceMasterKey) {
      reasons.push(
        "AGENT_WALLET_MASTER_KEY in examples must be a REPLACE_ placeholder (never a real key)",
      );
    }
  } else if (walletOff) {
    // Research-only samples: omit master key
    if (hasMasterKeyAssign) {
      reasons.push("research-only examples should omit AGENT_WALLET_MASTER_KEY");
    }
  } else if (!usesLauncher) {
    reasons.push(
      'AGENT_WALLET_ENABLED must be "false" (research-only default) or "true" (wallets), or use start-wallet-mcp.mjs',
    );
  }

  // Prefer placeholders over a single developer's home path
  if (/Users[/\\]admxn[/\\]/i.test(text) || /C:\\\\Users\\\\admxn/i.test(text)) {
    reasons.push("must not hard-code personal absolute home path; use placeholders");
  }

  // Placeholder is clone root only; paths must be REPLACE.../dist or REPLACE.../scripts
  // (not REPLACE.../SomeFolder/dist — that double-nests when users paste the full clone path)
  if (
    /REPLACE_WITH_ABSOLUTE_PATH[/\\][^/\s"'\\\]]+[/\\]dist[/\\]index\.js/.test(
      text,
    )
  ) {
    reasons.push(
      "args must be REPLACE_WITH_ABSOLUTE_PATH/dist/index.js (no intermediate folder name)",
    );
  }
  if (
    /REPLACE_WITH_ABSOLUTE_PATH[/\\][^/\s"'\\\]]+[/\\]scripts[/\\]start-wallet-mcp\.mjs/.test(
      text,
    )
  ) {
    reasons.push(
      "launcher args must be REPLACE_WITH_ABSOLUTE_PATH/scripts/start-wallet-mcp.mjs (no intermediate folder name)",
    );
  }
  if (
    /REPLACE_WITH_ABSOLUTE_PATH[/\\][^/\s"'\\\]]+[/\\]data[/\\]wallets/.test(
      text,
    )
  ) {
    reasons.push(
      "AGENT_WALLET_DIR must be REPLACE_WITH_ABSOLUTE_PATH/data/wallets (no intermediate folder name)",
    );
  }
  if (text.includes("REPLACE_WITH_ABSOLUTE_PATH")) {
    const hasDist = /REPLACE_WITH_ABSOLUTE_PATH\/dist\/index\.js/.test(text);
    const hasLauncher =
      /REPLACE_WITH_ABSOLUTE_PATH\/scripts\/start-wallet-mcp\.mjs/.test(text) ||
      /REPLACE_WITH_ABSOLUTE_PATH\/scripts\/start-lab-mcp\.mjs/.test(text);
    if (!hasDist && !hasLauncher) {
      reasons.push(
        "must include REPLACE_WITH_ABSOLUTE_PATH/dist/index.js or .../scripts/start-wallet-mcp.mjs",
      );
    }
  }

  return { ok: reasons.length === 0, reasons };
}
