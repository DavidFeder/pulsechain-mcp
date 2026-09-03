import { PolicyError } from "./errors.js";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

/** Hex private key patterns that must never appear in tool output. */
const PRIVATE_KEY_PATTERNS = [
  /(?:^|[^a-fA-F0-9])(0x[a-fA-F0-9]{64})(?:$|[^a-fA-F0-9])/,
  /"privateKey"\s*:\s*"([^"]+)"/i,
  /"private_key"\s*:\s*"([^"]+)"/i,
  /"mnemonic"\s*:\s*"([^"]+)"/i,
  /"seed"\s*:\s*"([^"]+)"/i,
];

export function isAddress(value: string): value is `0x${string}` {
  return ADDRESS_RE.test(value);
}

export function assertAddress(value: string): `0x${string}` {
  if (!isAddress(value)) {
    throw new PolicyError(
      `Invalid address: ${value}. Expected 0x-prefixed 40 hex chars.`,
    );
  }
  return value;
}

export function isTxHash(value: string): value is `0x${string}` {
  return TX_HASH_RE.test(value);
}

export function assertTxHash(value: string): `0x${string}` {
  if (!isTxHash(value)) {
    throw new PolicyError(
      `Invalid transaction hash: ${value}. Expected 0x-prefixed 64 hex chars.`,
    );
  }
  return value;
}

export function assertPositiveAmount(amount: number, label = "amount"): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PolicyError(`${label} must be a positive number`);
  }
}

export function assertWithinLimit(
  amount: number,
  max: number,
  label: string,
): void {
  if (amount > max) {
    throw new PolicyError(`${label} ${amount} exceeds policy max ${max}`);
  }
}

/** Redact secrets for logs (never full keys). */
export function redact(value: string | undefined, keep = 4): string {
  if (!value) return "";
  if (value.length <= keep * 2) return "***";
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/**
 * Standard warning attached to any write / signing tool description or result.
 * Confirm / MRTR is host UX only (not a cryptographic lock) — matches confirm.ts.
 */
export const WRITE_TOOL_WARNING =
  "WRITE OPERATION: This tool may submit transactions or mutate wallet state. " +
  "Requires AGENT_WALLET_ENABLED=true. Authorize with confirm=true, or omit confirm " +
  "on a capable client for modern MRTR elicitation (InputRequiredResult). " +
  "confirm=true / MRTR is host UX only — not a cryptographic lock. " +
  "Double-check recipient, amount, and gas before confirming.";

/**
 * Gate write tools: wallet must be enabled and caller must pass confirm=true.
 */
export function assertWriteAllowed(
  agentWalletEnabled: boolean,
  confirm: boolean | undefined,
  toolName: string,
): void {
  if (!agentWalletEnabled) {
    throw new PolicyError(
      `Write tool "${toolName}" is disabled. Set AGENT_WALLET_ENABLED=true to enable ` +
        `encrypted agent wallets (operator-trust when funded). Set AGENT_WALLET_ENABLED=false for research-only.`,
    );
  }
  if (confirm !== true) {
    throw new PolicyError(
      `Write tool "${toolName}" requires confirm=true. ${WRITE_TOOL_WARNING}`,
    );
  }
}

/** Object keys that must never leave the process boundary. */
const SECRET_KEY_NAMES = new Set([
  "privatekey",
  "private_key",
  "mnemonic",
  "seed",
  "secret",
  "agentwalletmasterkey",
  "encryptedkey",
  "encrypted_key",
  "ciphertext",
  "masterkey",
  "master_key",
  "agent_wallet_master_key",
  "signingkey",
  "signing_key",
]);

/**
 * Strip private keys / mnemonics from objects before returning to MCP clients.
 * Never return private material in tool results, logs, or error envelopes.
 */
export function stripSecrets<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return scrubSecretString(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripSecrets(v)) as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyLower = k.toLowerCase().replace(/[-]/g, "_");
      if (SECRET_KEY_NAMES.has(keyLower)) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = stripSecrets(v);
    }
    return out as T;
  }
  return value;
}

function scrubSecretString(s: string): string {
  let result = s;
  for (const re of PRIVATE_KEY_PATTERNS) {
    // Reset lastIndex for global safety if patterns are ever made /g
    re.lastIndex = 0;
    result = result.replace(re, (match) => {
      if (
        match.toLowerCase().includes("private") ||
        match.toLowerCase().includes("mnemonic") ||
        match.toLowerCase().includes("seed")
      ) {
        return match.replace(/:\s*"[^"]+"/, ': "[REDACTED]"');
      }
      // bare 0x64-hex: leave tx hashes alone (they are public); only scrub if labeled
      return match;
    });
  }
  // Labeled secret values in free-form error text: privateKey=0x…, masterKey: …
  result = result.replace(
    /\b(private[_-]?key|mnemonic|seed|master[_-]?key|ciphertext|encrypted[_-]?key)\s*[:=]\s*["']?([^\s"',}]+)/gi,
    "$1=[REDACTED]",
  );
  return result;
}

/** Ensure a tool result object never embeds private keys. */
export function neverReturnPrivateKey<T extends object>(payload: T): T {
  return stripSecrets(payload);
}
