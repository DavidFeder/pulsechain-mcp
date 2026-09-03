/**
 * AES-256-GCM encryption for agent wallet private keys.
 * Uses Node.js crypto only — no custom/weak crypto.
 *
 * Master key (AGENT_WALLET_MASTER_KEY):
 * - 64-char hex (32 bytes) → used directly as AES key (kdf: raw-hex)
 * - any other non-empty string → scrypt-derived with per-blob salt (kdf: scrypt)
 *
 * Private-key blobs (`encryptPrivateKey`):
 * - New blobs set GCM AAD and record `aadVersion: 1` (see `encodePrivateKeyAad`).
 * - Legacy blobs omit `aadVersion` and decrypt with no `setAAD`.
 * - `alg` stays `aes-256-gcm` for both; unsupported `alg` still fails closed.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { ConfigError } from "../utils/errors.js";
import type { EncryptedBlob } from "./types.js";

const ALG = "aes-256-gcm" as const;
const IV_LEN = 12;
const KEY_LEN = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_LEN = 16;

/** Private-key blobs that bind GCM AAD to wallet id + address. */
export const PRIVATE_KEY_AAD_VERSION = 1 as const;

/** Same ConfigError for bad key, bad tag, AAD mismatch, or unknown aadVersion. */
const DECRYPT_FAIL_MESSAGE =
  "Failed to decrypt wallet key — check AGENT_WALLET_MASTER_KEY";

/** Wallet id + address used as AES-GCM AAD for private-key blobs. */
export type PrivateKeyAadBinding = {
  walletId: string;
  address: string;
};

/**
 * Canonical AES-GCM AAD bytes for private-key blobs with `aadVersion: 1`.
 *
 * Encoding: UTF-8 of `` `${walletId}:${address.toLowerCase()}` ``
 * (wallet id as stored; address lowercased 0x hex). No extra separators,
 * checksum, chain id, or trailing newline. Same bytes on encrypt and decrypt.
 */
export function encodePrivateKeyAad(walletId: string, address: string): Buffer {
  return Buffer.from(`${walletId}:${address.toLowerCase()}`, "utf8");
}

function stripOptionalHexPrefix(masterKey: string): string {
  return masterKey.startsWith("0x") || masterKey.startsWith("0X")
    ? masterKey.slice(2)
    : masterKey;
}

/** True if value is exactly 32 bytes as hex (optional 0x / 0X prefix). */
export function isRawHexKey(masterKey: string): boolean {
  const hex = stripOptionalHexPrefix(masterKey);
  return /^[a-fA-F0-9]{64}$/.test(hex);
}

function parseRawHexKey(masterKey: string): Buffer {
  return Buffer.from(stripOptionalHexPrefix(masterKey), "hex");
}

/**
 * Derive or load the AES-256 key from the configured master secret.
 * When using scrypt, salt must be provided (random per encrypt; stored with blob).
 */
export function resolveAesKey(
  masterKey: string,
  saltHex?: string,
): { key: Buffer; kdf: EncryptedBlob["kdf"]; salt?: string } {
  if (!masterKey || masterKey.trim() === "") {
    throw new ConfigError(
      "AGENT_WALLET_MASTER_KEY is required for encrypted agent wallets. " +
        "Provide a 64-char hex (32-byte) key or a strong passphrase.",
    );
  }

  if (isRawHexKey(masterKey)) {
    return { key: parseRawHexKey(masterKey), kdf: "raw-hex" };
  }

  const salt = saltHex
    ? Buffer.from(saltHex, "hex")
    : randomBytes(SALT_LEN);
  if (salt.length < 8) {
    throw new ConfigError("Invalid encryption salt");
  }
  const key = scryptSync(masterKey, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return { key, kdf: "scrypt", salt: salt.toString("hex") };
}

/** Encrypt plaintext (e.g. private key hex) with AES-256-GCM. */
export function encryptSecret(
  plaintext: string,
  masterKey: string,
  aad?: Uint8Array,
): EncryptedBlob {
  const { key, kdf, salt } = resolveAesKey(masterKey);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  if (aad) {
    cipher.setAAD(Buffer.from(aad));
  }
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Best-effort: zero key buffer
  key.fill(0);

  const blob: EncryptedBlob = {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    kdf,
    alg: ALG,
  };
  if (salt) blob.salt = salt;
  return blob;
}

/** Decrypt an EncryptedBlob. Throws on auth failure / wrong key / AAD mismatch. */
export function decryptSecret(
  blob: EncryptedBlob,
  masterKey: string,
  aad?: Uint8Array,
): string {
  if (blob.alg !== ALG) {
    throw new ConfigError(`Unsupported cipher: ${blob.alg}`);
  }
  const { key } = resolveAesKey(
    masterKey,
    blob.kdf === "scrypt" ? blob.salt : undefined,
  );
  try {
    const decipher = createDecipheriv(
      ALG,
      key,
      Buffer.from(blob.iv, "hex"),
    );
    if (aad) {
      decipher.setAAD(Buffer.from(aad));
    }
    decipher.setAuthTag(Buffer.from(blob.tag, "hex"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(blob.ciphertext, "hex")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    throw new ConfigError(DECRYPT_FAIL_MESSAGE);
  } finally {
    key.fill(0);
  }
}

/**
 * Encrypt a private key for storage. Accepts 0x-prefixed or bare 64-hex.
 * Binds GCM AAD to wallet id + address (`aadVersion: 1`). Never logs plaintext.
 */
export function encryptPrivateKey(
  privateKey: `0x${string}` | string,
  masterKey: string,
  binding: PrivateKeyAadBinding,
): EncryptedBlob {
  const normalized = privateKey.startsWith("0x")
    ? privateKey
    : (`0x${privateKey}` as const);
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new ConfigError("Invalid private key format for encryption");
  }
  const blob = encryptSecret(
    normalized,
    masterKey,
    encodePrivateKeyAad(binding.walletId, binding.address),
  );
  blob.aadVersion = PRIVATE_KEY_AAD_VERSION;
  return blob;
}

/**
 * Decrypt to 0x-prefixed private key hex. Caller must not log or return this.
 *
 * `aadVersion: 1` requires the same wallet id + address AAD used at encrypt.
 * Legacy blobs (no `aadVersion`) decrypt with no setAAD. Unknown versions and
 * AAD / key / tag failures share `DECRYPT_FAIL_MESSAGE` (no plaintext).
 */
export function decryptPrivateKey(
  blob: EncryptedBlob,
  masterKey: string,
  binding: PrivateKeyAadBinding,
): `0x${string}` {
  let aad: Buffer | undefined;
  if (blob.aadVersion === PRIVATE_KEY_AAD_VERSION) {
    aad = encodePrivateKeyAad(binding.walletId, binding.address);
  } else if (blob.aadVersion !== undefined) {
    throw new ConfigError(DECRYPT_FAIL_MESSAGE);
  }
  const plain = decryptSecret(blob, masterKey, aad);
  if (!/^0x[a-fA-F0-9]{64}$/.test(plain)) {
    throw new ConfigError("Decrypted material is not a valid private key");
  }
  return plain as `0x${string}`;
}

/** Constant-time compare of two hex strings (for tests / integrity). */
export function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** Generate a cryptographically random wallet id (hex, no secrets). */
export function generateWalletId(): string {
  return `aw_${randomBytes(16).toString("hex")}`;
}

/** Generate a proposal id. */
export function generateProposalId(): string {
  return `prop_${randomBytes(12).toString("hex")}`;
}
