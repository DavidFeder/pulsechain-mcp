import { z } from "zod";
import {
  DEFAULT_EXPLORER_API,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PULSEX_SUBGRAPH_V1,
  DEFAULT_PULSEX_SUBGRAPH_V2,
  DEFAULT_RPC_URLS,
  DEFAULT_TESTNET_RPC_URLS,
} from "./constants.js";
import { logger } from "./logger.js";
import type { AppConfig, LogLevel, PulseNetwork } from "./types.js";
import { ConfigError } from "./utils/errors.js";
import { AGENT_WALLET_ENABLE_WARNING } from "./wallet/types.js";

const envSchema = z.object({
  /** Comma- or newline-separated ordered RPC list (preferred). */
  PULSECHAIN_RPC_URLS: z.string().optional(),
  /** Legacy single RPC — prepended when set (backward compatible). */
  PULSECHAIN_RPC_URL: z.string().optional(),
  /** mainnet (default) | testnet — selects default RPC list when none set. */
  PULSECHAIN_NETWORK: z.enum(["mainnet", "testnet"]).optional(),
  /** Optional explicit testnet list (used when network=testnet and no URLS/URL). */
  PULSECHAIN_TESTNET_RPC_URLS: z.string().optional(),
  PULSECHAIN_EXPLORER_API: z.string().url().optional(),
  PULSEX_SUBGRAPH_V1: z.string().url().optional().or(z.literal("")),
  PULSEX_SUBGRAPH_V2: z.string().url().optional().or(z.literal("")),
  AGENT_WALLET_ENABLED: z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .default("true"),
  AGENT_WALLET_MASTER_KEY: z.string().optional(),
  AGENT_WALLET_DIR: z.string().optional(),
  AGENT_WALLET_MRTR_SECRET: z.string().optional(),
  /**
   * When true, refuse wallet writes if another live process owns AGENT_WALLET_DIR.
   * Do not default here — wallets-on vs research-only is resolved in loadConfig
   * after AGENT_WALLET_ENABLED is known. Wallets-on: unset/empty → true.
   * Explicit false/0 stays warn-only. Research-only unset/empty stays false.
   */
  AGENT_WALLET_MULTIPROC_STRICT: z
    .enum(["true", "false", "1", "0", ""])
    .optional(),
  MAX_PLS_PER_TX: z.string().optional(),
  MAX_PLS_DAILY: z.string().optional(),
  HTTP_TRANSPORT_PORT: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  HTTP_TIMEOUT_MS: z.string().optional(),
});

function parseBool(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/**
 * Wallets-on: unset/empty → strict (true). Explicit false/0 → warn-only.
 * Research-only: unset/empty → false (historic). Explicit true/1 still strict.
 */
function resolveAgentWalletMultiprocStrict(
  raw: string | undefined,
  agentWalletEnabled: boolean,
): boolean {
  if (raw === undefined || raw === "") {
    return agentWalletEnabled;
  }
  return parseBool(raw);
}

/**
 * Parse a non-negative finite number from env (empty/missing → fallback).
 * Rejects scientific notation and hex-looking strings for clearer misconfig errors
 * (aligned with wallet PLS parsing posture — prefer plain decimals).
 */
function parseNonNegNumber(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const trimmed = value.trim();
  if (/[eE]/.test(trimmed) || /^0[xX]/.test(trimmed)) {
    throw new ConfigError(
      `${name} must be a plain decimal number (no scientific notation or hex); got "${value}". ` +
        `Example: ${fallback}`,
    );
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    throw new ConfigError(
      `${name} must be a finite number (got "${value}"). Example: ${fallback}`,
    );
  }
  if (n < 0) {
    throw new ConfigError(`${name} must be >= 0 (got ${n})`);
  }
  return n;
}

/**
 * Validate AGENT_WALLET_MASTER_KEY when wallets are enabled.
 * Prefer 64-char hex (raw AES); passphrase form must be long enough to be intentional.
 */
export function assertMasterKeyConfigured(masterKey: string): void {
  const key = masterKey.trim();
  if (key.length === 0) {
    throw new ConfigError(
      "AGENT_WALLET_MASTER_KEY is empty after trim. Prefer write-only: " +
        "node scripts/generate-wallet-env.mjs (never prints the key) or " +
        "node scripts/install-for-host.mjs --host <grok|cursor|claude|codex> --mode wallets " +
        "(launcher + gitignored .env.wallet; do not embed AGENT_WALLET_MASTER_KEY in host config). " +
        "Or set AGENT_WALLET_ENABLED=false for research-only.",
    );
  }
  const hexBody = key.startsWith("0x") || key.startsWith("0X") ? key.slice(2) : key;
  const isRawHex = /^[0-9a-fA-F]{64}$/.test(hexBody);
  if (isRawHex) return;
  if (key.length < 16) {
    throw new ConfigError(
      `AGENT_WALLET_MASTER_KEY passphrase is too short (${key.length} chars). ` +
        `Use a 64-char hex AES key (preferred) or at least 16 characters. ` +
        `Write-only (never prints the key): node scripts/generate-wallet-env.mjs ` +
        `or node scripts/install-for-host.mjs --mode wallets (launcher + .env.wallet; ` +
        `do not embed the key in host config). Or set AGENT_WALLET_ENABLED=false.`,
    );
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return value;
}

/**
 * Format zod issues into a short actionable message.
 */
export function formatEnvValidationError(error: z.ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  return (
    `Invalid environment configuration:\n  - ${parts.join("\n  - ")}\n` +
    `See .env.example for valid variables (PULSECHAIN_RPC_URLS, AGENT_WALLET_*, LOG_LEVEL, …).`
  );
}

/**
 * Split a multi-URL env string on commas and/or newlines; trim; drop empties.
 * Validates each entry as an absolute http(s) URL.
 */
export function parseRpcUrlList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const parts = raw
    .split(/[,\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: string[] = [];
  for (const p of parts) {
    let url: URL;
    try {
      url = new URL(p);
    } catch {
      throw new ConfigError(
        `Invalid RPC URL in list: "${p}". Use absolute http(s) URLs, comma-separated. ` +
          `Example: http://127.0.0.1:8545,https://rpc-pulsechain.g4mm4.io`,
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigError(
        `RPC URL must use http or https (got "${url.protocol}" in ${p})`,
      );
    }
    // Normalize: drop trailing slash for stable comparison (except root-only)
    const normalized =
      url.pathname === "/" && !url.search && !url.hash
        ? `${url.origin}`
        : p.replace(/\/+$/, "");
    out.push(normalized === "" ? p : normalized);
  }
  return out;
}

/**
 * Build ordered RPC list:
 * 1. URLs from PULSECHAIN_RPC_URLS (or testnet list when applicable)
 * 2. Prepend PULSECHAIN_RPC_URL if set and not already first
 * 3. If still empty → network defaults (mainnet g4mm4+public, or testnet g4mm4)
 *
 * Deduplicates case-sensitively after normalization while preserving order.
 */
export function resolveRpcUrls(options: {
  rpcUrlsRaw?: string;
  rpcUrlSingle?: string;
  network?: PulseNetwork;
  testnetRpcUrlsRaw?: string;
}): string[] {
  const network: PulseNetwork = options.network ?? "mainnet";
  let fromList = parseRpcUrlList(options.rpcUrlsRaw);

  // If only testnet list provided while on testnet and main list empty
  if (fromList.length === 0 && network === "testnet") {
    fromList = parseRpcUrlList(options.testnetRpcUrlsRaw);
  }

  const single = emptyToUndefined(options.rpcUrlSingle);
  if (single) {
    const [normalized] = parseRpcUrlList(single);
    if (!normalized) {
      throw new ConfigError(
        `Invalid PULSECHAIN_RPC_URL: "${single}". Use an absolute http(s) URL.`,
      );
    }
    if (fromList.length === 0) {
      fromList = [normalized];
    } else if (fromList[0] !== normalized) {
      // Prepend legacy single URL so it keeps highest priority
      fromList = [normalized, ...fromList.filter((u) => u !== normalized)];
    }
  }

  if (fromList.length === 0) {
    fromList =
      network === "testnet"
        ? [...DEFAULT_TESTNET_RPC_URLS]
        : [...DEFAULT_RPC_URLS];
  }

  // Dedupe preserving order
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const u of fromList) {
    if (!seen.has(u)) {
      seen.add(u);
      deduped.push(u);
    }
  }
  if (deduped.length === 0) {
    throw new ConfigError(
      "No RPC URLs configured. Set PULSECHAIN_RPC_URLS or PULSECHAIN_RPC_URL.",
    );
  }
  return deduped;
}

/**
 * Parse environment into AppConfig.
 * AGENT_WALLET_ENABLED defaults to true (product default). Encryption stays
 * required: enabled without a master key fails startup. Set
 * AGENT_WALLET_ENABLED=false for pure research / read-only.
 * Throws ConfigError on invalid env (fail early, clear message).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(formatEnvValidationError(parsed.error));
  }
  const e = parsed.data;

  const portRaw = emptyToUndefined(e.HTTP_TRANSPORT_PORT);
  let httpTransportPort: number | undefined;
  if (portRaw !== undefined) {
    const p = Number(portRaw);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new ConfigError(
        `HTTP_TRANSPORT_PORT must be an integer 1–65535 (got "${portRaw}"). ` +
          `Leave empty for stdio (Claude Desktop / Cursor).`,
      );
    }
    httpTransportPort = p;
  }

  // Zod already enums mainnet|testnet; default mainnet when unset.
  const network: PulseNetwork = e.PULSECHAIN_NETWORK ?? "mainnet";

  let rpcUrls: string[];
  try {
    rpcUrls = resolveRpcUrls({
      rpcUrlsRaw: e.PULSECHAIN_RPC_URLS,
      rpcUrlSingle: e.PULSECHAIN_RPC_URL,
      network,
      testnetRpcUrlsRaw: e.PULSECHAIN_TESTNET_RPC_URLS,
    });
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(
      err instanceof Error ? err.message : String(err),
    );
  }
  const rpcUrl = rpcUrls[0]!;

  const agentWalletEnabled = parseBool(e.AGENT_WALLET_ENABLED);
  const agentWalletMasterKey = emptyToUndefined(
    e.AGENT_WALLET_MASTER_KEY?.trim(),
  );

  // Fail early: wallets on (including product default) without master key
  if (agentWalletEnabled && !agentWalletMasterKey) {
    throw new ConfigError(
      "Agent wallets are on by default and require AGENT_WALLET_MASTER_KEY. " +
        "Write-only (never prints the key): node scripts/generate-wallet-env.mjs " +
        "or node scripts/install-for-host.mjs --host <grok|cursor|claude|codex> --mode wallets " +
        "(host entry = scripts/start-wallet-mcp.mjs + gitignored .env.wallet; " +
        "do not embed AGENT_WALLET_MASTER_KEY in host config or chat). " +
        "For research-only (no signing): set AGENT_WALLET_ENABLED=false. " +
        "One MCP process → one unique AGENT_WALLET_DIR. See docs/BOOTSTRAP.md.",
    );
  }
  if (agentWalletEnabled && agentWalletMasterKey) {
    assertMasterKeyConfigured(agentWalletMasterKey);
  }

  // Optional MRTR secret: when set, must be long enough for HMAC use.
  // Wallets + HTTP require a stable secret — process-local HMAC cannot resume
  // after restart or on a second instance. Stdio may omit it.
  const mrtr = emptyToUndefined(e.AGENT_WALLET_MRTR_SECRET?.trim());
  if (mrtr && Buffer.byteLength(mrtr, "utf8") < 32) {
    throw new ConfigError(
      "AGENT_WALLET_MRTR_SECRET must be at least 32 bytes UTF-8 when set " +
        `(got ${Buffer.byteLength(mrtr, "utf8")} bytes). ` +
        "Stdio wallets-on may omit it to use a process-local HMAC secret; " +
        "HTTP + wallets requires ≥32 bytes. Do not reuse AGENT_WALLET_MASTER_KEY.",
    );
  }
  if (agentWalletEnabled && httpTransportPort !== undefined && !mrtr) {
    throw new ConfigError(
      "AGENT_WALLET_MRTR_SECRET is required when agent wallets are enabled and HTTP_TRANSPORT_PORT is set " +
        "(≥32 bytes UTF-8). HTTP restarts and a second instance cannot resume MRTR confirmations with the " +
        "process-local HMAC fallback used for stdio. Leave HTTP_TRANSPORT_PORT unset for stdio, or set a " +
        "stable AGENT_WALLET_MRTR_SECRET. Do not reuse AGENT_WALLET_MASTER_KEY.",
    );
  }

  const walletDirRaw = e.AGENT_WALLET_DIR;
  const agentWalletDir =
    walletDirRaw === undefined || walletDirRaw.trim() === ""
      ? "./data/wallets"
      : walletDirRaw.trim();
  if (agentWalletEnabled && agentWalletDir.includes("\0")) {
    throw new ConfigError(
      "AGENT_WALLET_DIR contains an invalid null character. Use a normal filesystem path.",
    );
  }

  const maxPlsPerTx = parseNonNegNumber(e.MAX_PLS_PER_TX, 100, "MAX_PLS_PER_TX");
  const maxPlsDaily = parseNonNegNumber(e.MAX_PLS_DAILY, 1000, "MAX_PLS_DAILY");
  if (maxPlsPerTx > maxPlsDaily) {
    throw new ConfigError(
      `MAX_PLS_PER_TX (${maxPlsPerTx}) cannot exceed MAX_PLS_DAILY (${maxPlsDaily}). ` +
        `Lower per-tx or raise daily (both are default native PLS caps for new agent wallets).`,
    );
  }

  const httpTimeoutMs = parseNonNegNumber(
    e.HTTP_TIMEOUT_MS,
    DEFAULT_HTTP_TIMEOUT_MS,
    "HTTP_TIMEOUT_MS",
  );
  if (httpTimeoutMs < 1000) {
    throw new ConfigError(
      `HTTP_TIMEOUT_MS must be at least 1000ms (got ${httpTimeoutMs})`,
    );
  }

  const agentWalletMultiprocStrict = resolveAgentWalletMultiprocStrict(
    e.AGENT_WALLET_MULTIPROC_STRICT,
    agentWalletEnabled,
  );

  // Loud, fail-closed posture reminder when signing is enabled
  if (agentWalletEnabled) {
    logger.warn(AGENT_WALLET_ENABLE_WARNING, {
      maxPlsPerTx,
      maxPlsDaily,
      masterKeyConfigured: true,
      rpcCount: rpcUrls.length,
      multiprocStrict: agentWalletMultiprocStrict,
    });
  }

  return {
    rpcUrls,
    rpcUrl,
    network,
    explorerApi: e.PULSECHAIN_EXPLORER_API ?? DEFAULT_EXPLORER_API,
    pulseXSubgraphV1:
      emptyToUndefined(e.PULSEX_SUBGRAPH_V1) ?? DEFAULT_PULSEX_SUBGRAPH_V1,
    pulseXSubgraphV2:
      emptyToUndefined(e.PULSEX_SUBGRAPH_V2) ?? DEFAULT_PULSEX_SUBGRAPH_V2,
    agentWalletEnabled,
    agentWalletMasterKey,
    agentWalletDir,
    agentWalletMultiprocStrict,
    maxPlsPerTx,
    maxPlsDaily,
    httpTransportPort,
    logLevel: (e.LOG_LEVEL ?? DEFAULT_LOG_LEVEL) as LogLevel,
    httpTimeoutMs,
  };
}
