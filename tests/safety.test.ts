import { describe, expect, it } from "vitest";
import {
  assertAddress,
  assertPositiveAmount,
  assertTxHash,
  assertWithinLimit,
  isAddress,
  neverReturnPrivateKey,
  redact,
  stripSecrets,
  WRITE_TOOL_WARNING,
} from "../src/utils/safety.js";
import { PolicyError } from "../src/utils/errors.js";

describe("safety", () => {
  it("validates addresses", () => {
    expect(isAddress("0x0000000000000000000000000000000000000000")).toBe(true);
    expect(isAddress("not-an-address")).toBe(false);
    expect(() => assertAddress("bad")).toThrow(PolicyError);
  });

  it("validates tx hashes", () => {
    expect(() =>
      assertTxHash(
        "0x" + "ab".repeat(32),
      ),
    ).not.toThrow();
    expect(() => assertTxHash("0x1234")).toThrow(PolicyError);
  });

  it("enforces positive amounts and limits", () => {
    expect(() => assertPositiveAmount(1)).not.toThrow();
    expect(() => assertPositiveAmount(0)).toThrow(PolicyError);
    expect(() => assertWithinLimit(10, 5, "x")).toThrow(PolicyError);
    expect(() => assertWithinLimit(3, 5, "x")).not.toThrow();
  });

  it("redacts secrets", () => {
    expect(redact("abcdefghijklmnop")).toMatch(/…/);
    expect(redact(undefined)).toBe("");
  });

  it("WRITE_TOOL_WARNING mentions funding authorizes and kill_switch", () => {
    expect(WRITE_TOOL_WARNING).toMatch(/WRITE OPERATION/);
    expect(WRITE_TOOL_WARNING).toMatch(/AGENT_WALLET_ENABLED=true/);
    expect(WRITE_TOOL_WARNING).toMatch(/funding the agent is authorization/i);
    expect(WRITE_TOOL_WARNING).toMatch(/no spend caps|allowlists/i);
    expect(WRITE_TOOL_WARNING).toMatch(/kill_switch/);
    expect(WRITE_TOOL_WARNING).not.toMatch(/confirm=true/);
    expect(WRITE_TOOL_WARNING).not.toMatch(/MRTR|InputRequiredResult/);
  });

  it("never returns private key fields", () => {
    const cleaned = neverReturnPrivateKey({
      address: "0xabc",
      privateKey: "0xdeadbeef",
      nested: { mnemonic: "word word", ok: 1 },
    });
    expect(cleaned.privateKey).toBe("[REDACTED]");
    expect(cleaned.nested.mnemonic).toBe("[REDACTED]");
    expect(cleaned.nested.ok).toBe(1);
    expect(cleaned.address).toBe("0xabc");
  });

  it("stripSecrets handles arrays", () => {
    const out = stripSecrets([{ seed: "secret", n: 1 }]);
    expect(out[0]?.seed).toBe("[REDACTED]");
    expect(out[0]?.n).toBe(1);
  });

  it("stripSecrets redacts labeled secrets in free-form error strings", () => {
    const scrubbed = stripSecrets(
      "failed privateKey=0x" + "ab".repeat(32) + " and master_key: supersecret",
    );
    expect(scrubbed).toContain("[REDACTED]");
    expect(scrubbed).not.toContain("ababab");
    expect(scrubbed).not.toContain("supersecret");
  });

  it("stripSecrets redacts ciphertext and master key object keys", () => {
    const out = stripSecrets({
      master_key: "should-hide",
      encryptedKey: { ciphertext: "abc", iv: "1" },
      ok: true,
    });
    expect(out.master_key).toBe("[REDACTED]");
    expect(out.encryptedKey).toBe("[REDACTED]");
    expect(out.ok).toBe(true);
  });
});
