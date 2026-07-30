/**
 * Client-host compatibility helpers (Cursor, Grok Build, Claude Desktop).
 * Pure strings/checks only — no I/O. Used for startup messages and tests.
 */

/** Env keys that break stdio MCP hosts when set for Cursor/Grok/Claude. */
export const STDIO_HOST_FORBIDDEN_ENV = ["HTTP_TRANSPORT_PORT"] as const;

/**
 * Product-default env keys for example client configs (wallets on).
 * Master key is required at runtime — examples use a REPLACE_ placeholder.
 */
export const STDIO_HOST_SAFE_ENV_DEFAULTS = {
  AGENT_WALLET_ENABLED: "true",
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
    "invalid PULSECHAIN_RPC_URLS, wallets on without/short MASTER_KEY (default is on),",
    "MAX_PLS_PER_TX > MAX_PLS_DAILY, short AGENT_WALLET_MRTR_SECRET, bad LOG_LEVEL.",
    "Cursor / Grok Build / Claude Desktop use stdio — do not set HTTP_TRANSPORT_PORT.",
    "First run: set AGENT_WALLET_MASTER_KEY (64-char hex preferred), or set AGENT_WALLET_ENABLED=false for research-only.",
    "With wallets on: unique AGENT_WALLET_DIR per process; optional MULTIPROC_STRICT=true; " +
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
 * True when example client config text is stdio-safe under the product default
 * (wallets on + master-key placeholder) or explicit research-only (wallets off).
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

  if (walletOn && walletOff) {
    reasons.push("AGENT_WALLET_ENABLED cannot be both true and false");
  } else if (walletOn) {
    // Product default samples: master key must be a REPLACE_ placeholder, never a real secret
    const hasMasterKeyAssign =
      /AGENT_WALLET_MASTER_KEY"\s*:\s*"/i.test(text) ||
      /AGENT_WALLET_MASTER_KEY\s*=\s*"/i.test(text);
    if (!hasMasterKeyAssign) {
      reasons.push(
        'wallets-on examples must set AGENT_WALLET_MASTER_KEY to a REPLACE_ placeholder',
      );
    } else if (
      !/AGENT_WALLET_MASTER_KEY"\s*:\s*"REPLACE_/i.test(text) &&
      !/AGENT_WALLET_MASTER_KEY\s*=\s*"REPLACE_/i.test(text)
    ) {
      reasons.push(
        "AGENT_WALLET_MASTER_KEY in examples must be a REPLACE_ placeholder (never a real key)",
      );
    }
    // Reject committed-looking 64-char hex secrets in examples
    if (
      /AGENT_WALLET_MASTER_KEY"\s*:\s*"[0-9a-fA-F]{64}"/i.test(text) ||
      /AGENT_WALLET_MASTER_KEY\s*=\s*"[0-9a-fA-F]{64}"/i.test(text)
    ) {
      reasons.push("examples must not embed a real 64-char hex master key");
    }
  } else if (walletOff) {
    // Research-only samples: omit master key
    if (
      /AGENT_WALLET_MASTER_KEY"\s*:\s*"[^"]+"/i.test(text) ||
      /AGENT_WALLET_MASTER_KEY\s*=\s*"[^"]+"/i.test(text)
    ) {
      reasons.push("research-only examples should omit AGENT_WALLET_MASTER_KEY");
    }
  } else {
    reasons.push(
      'AGENT_WALLET_ENABLED must be "true" (product default) or "false" (research-only) in examples',
    );
  }

  // Prefer placeholders over a single developer's home path
  if (/Users[/\\]admxn[/\\]/i.test(text) || /C:\\\\Users\\\\admxn/i.test(text)) {
    reasons.push("must not hard-code personal absolute home path; use placeholders");
  }

  // Placeholder is clone root only; paths must be REPLACE.../dist and REPLACE.../data
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
    /REPLACE_WITH_ABSOLUTE_PATH[/\\][^/\s"'\\\]]+[/\\]data[/\\]wallets/.test(
      text,
    )
  ) {
    reasons.push(
      "AGENT_WALLET_DIR must be REPLACE_WITH_ABSOLUTE_PATH/data/wallets (no intermediate folder name)",
    );
  }
  if (
    text.includes("REPLACE_WITH_ABSOLUTE_PATH") &&
    !/REPLACE_WITH_ABSOLUTE_PATH\/dist\/index\.js/.test(text)
  ) {
    reasons.push("must include REPLACE_WITH_ABSOLUTE_PATH/dist/index.js entry path");
  }

  return { ok: reasons.length === 0, reasons };
}
