import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptPrivateKey,
  decryptSecret,
  encryptPrivateKey,
  encryptSecret,
  isRawHexKey,
} from "../src/wallet/crypto.js";
import {
  evaluatePolicy,
  mergePolicy,
  normalizeDailySpend,
} from "../src/wallet/policy.js";
import {
  appendAudit,
  loadWalletRecord,
  readAuditLog,
  saveWalletRecord,
} from "../src/wallet/store.js";
import {
  agentWalletSystemStatus,
  createAgentWallet,
  executeAgentTx,
  getAgentWalletInfo,
  killSwitch,
  setAgentPolicy,
  transferPls,
} from "../src/wallet/service.js";
import { DEFAULT_POLICY, type AgentWalletRecord } from "../src/wallet/types.js";
import type { AppConfig } from "../src/types.js";
import { neverReturnPrivateKey, stripSecrets } from "../src/utils/safety.js";
import { PolicyError } from "../src/utils/errors.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** Matches 0x-prefixed 64-hex private key material (must not appear in responses). */
const PRIVATE_KEY_HEX_RE = /0x[a-fA-F0-9]{64}/;

const tempDirs: string[] = [];

function tempWalletDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-test-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    rpcUrl: "https://rpc.pulsechain.com",
  rpcUrls: ["https://rpc.pulsechain.com"],
  network: "mainnet",
    explorerApi: "https://api.scan.pulsechain.com/api",
    pulseXSubgraphV1: "https://example.com/v1",
    pulseXSubgraphV2: "https://example.com/v2",
    agentWalletEnabled: true,
    agentWalletMasterKey: randomBytes(32).toString("hex"),
    agentWalletDir: tempWalletDir(),
    agentWalletMultiprocStrict: false,
    maxPlsPerTx: 10,
    maxPlsDaily: 100,
    httpTransportPort: undefined,
    logLevel: "error",
    httpTimeoutMs: 5000,
    ...overrides,
  };
}

describe("wallet crypto", () => {
  it("encrypt/decrypt roundtrip with raw hex master key", () => {
    const master = randomBytes(32).toString("hex");
    expect(isRawHexKey(master)).toBe(true);
    const plain = "super-secret-value";
    const blob = encryptSecret(plain, master);
    expect(blob.alg).toBe("aes-256-gcm");
    expect(blob.kdf).toBe("raw-hex");
    expect(blob.ciphertext).not.toContain(plain);
    expect(decryptSecret(blob, master)).toBe(plain);
  });

  it("encrypt/decrypt roundtrip with passphrase (scrypt)", () => {
    const master = "correct horse battery staple passphrase!";
    expect(isRawHexKey(master)).toBe(false);
    const plain = "0x" + "ab".repeat(32);
    const blob = encryptSecret(plain, master);
    expect(blob.kdf).toBe("scrypt");
    expect(blob.salt).toBeTruthy();
    expect(decryptSecret(blob, master)).toBe(plain);
  });

  it("encrypt/decrypt private key roundtrip", () => {
    const master = randomBytes(32).toString("hex");
    const pk = generatePrivateKey();
    const blob = encryptPrivateKey(pk, master);
    const out = decryptPrivateKey(blob, master);
    expect(out.toLowerCase()).toBe(pk.toLowerCase());
  });

  it("fails decrypt with wrong master key", () => {
    const blob = encryptSecret("hello", randomBytes(32).toString("hex"));
    expect(() =>
      decryptSecret(blob, randomBytes(32).toString("hex")),
    ).toThrow(/decrypt|MASTER_KEY/i);
  });
});

describe("wallet policy", () => {
  const basePolicy = DEFAULT_POLICY(10, 100);

  it("allows EOA native transfer (display caps do not hard-deny)", () => {
    const check = evaluatePolicy({
      policy: basePolicy,
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 5 },
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 3,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
    expect(check.isContractInteraction).toBe(false);
    expect(check.remainingDaily).toBe(92);
  });

  it("operator-trust: value over legacy maxPlsPerTx is still allowed", () => {
    const check = evaluatePolicy({
      policy: basePolicy,
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 50,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
    expect(check.reasons).toEqual([]);
    expect(check.valuePls).toBe(50);
  });

  it("operator-trust: projected daily over legacy maxPlsDaily is still allowed", () => {
    const check = evaluatePolicy({
      policy: basePolicy,
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 95 },
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 10,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
    expect(check.projectedDailySpend).toBe(105);
  });

  it("operator-trust: empty contract allowlist does not hard-deny contract calls", () => {
    const check = evaluatePolicy({
      policy: basePolicy,
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
      valuePls: 0,
      data: "0xa9059cbb",
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
    expect(check.isContractInteraction).toBe(true);
    expect(check.tokenNotional?.notes.join(" ")).toMatch(/Operator-trust/i);
  });

  it("allows contract interaction regardless of allowlist membership", () => {
    const wpls = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27" as const;
    const check = evaluatePolicy({
      policy: {
        ...basePolicy,
        contractAllowlist: [wpls],
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: wpls,
      valuePls: 1,
      data: "0xd0e30db0",
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
  });

  it("denies when kill switch / disabled", () => {
    const killed = evaluatePolicy({
      policy: { ...basePolicy, killed: true, enabled: false },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
    });
    expect(killed.allowed).toBe(false);
    expect(killed.reasons.join(" ")).toMatch(/kill/i);
  });

  it("operator-trust: token allowlist does not hard-deny destination", () => {
    const token = "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab" as const;
    const other = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27" as const;
    const check = evaluatePolicy({
      policy: {
        ...basePolicy,
        contractAllowlist: [other, token],
        tokenAllowlist: [token],
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: other,
      valuePls: 0,
      data: "0x095ea7b3",
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
  });
  it("resets daily spend on new UTC day", () => {
    const ledger = normalizeDailySpend({
      date: "2000-01-01",
      spentPls: 999,
    });
    expect(ledger.spentPls).toBe(0);
    expect(ledger.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it("mergePolicy validates kill-switch clear", () => {
    const current = { ...basePolicy, killed: true, enabled: false };
    expect(() => mergePolicy(current, { killed: false })).toThrow(PolicyError);
    const next = mergePolicy(current, { killed: false, enabled: true });
    expect(next.killed).toBe(false);
    expect(next.enabled).toBe(true);
  });

  it("operator-trust: expired allowlist is reported but does not hard-deny", () => {
    const wpls = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27" as const;
    const check = evaluatePolicy({
      policy: {
        ...basePolicy,
        contractAllowlist: [wpls],
        allowlistExpiresAt: "2020-01-01T00:00:00.000Z",
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: wpls,
      valuePls: 0,
      data: "0xd0e30db0",
      destinationIsContract: true,
      now: new Date("2026-07-26T12:00:00.000Z"),
    });
    expect(check.allowed).toBe(true);
    expect(check.allowlistExpired).toBe(true);
  });

  it("operator-trust: tokenSpendCaps and tokenDailyCaps are not hard gates", () => {
    const dest = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27";
    const perTx = evaluatePolicy({
      policy: {
        ...basePolicy,
        contractAllowlist: [dest as `0x${string}`],
        tokenSpendCaps: { [dest.toLowerCase()]: 2 },
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: dest,
      valuePls: 5,
      data: "0x",
      destinationIsContract: true,
    });
    expect(perTx.allowed).toBe(true);

    const daily = evaluatePolicy({
      policy: {
        ...basePolicy,
        contractAllowlist: [dest as `0x${string}`],
        tokenDailyCaps: { [dest.toLowerCase()]: 3 },
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      tokenDailySpend: {
        [dest.toLowerCase()]: {
          date: new Date().toISOString().slice(0, 10),
          spentPls: 2,
        },
      },
      to: dest,
      valuePls: 2,
      data: "0x",
      destinationIsContract: true,
    });
    expect(daily.allowed).toBe(true);
  });

  it("operator-trust: allowNativeTransfers=false is not a hard gate", () => {
    const check = evaluatePolicy({
      policy: { ...basePolicy, allowNativeTransfers: false },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
  });
});

describe("wallet store + create (no key leak)", () => {
  it("create_agent_wallet returns public fields only", async () => {
    const cfg = testConfig();
    const info = await createAgentWallet(cfg, { label: "test" });
    expect(info.id).toMatch(/^aw_[a-f0-9]{32}$/);
    expect(info.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(info.policy.maxPlsPerTx).toBe(10);
    expect(info.policy.contractAllowlist).toEqual([]);
    expect(info.label).toBe("test");

    const json = JSON.stringify(info);
    expect(json).not.toMatch(/privateKey/i);
    expect(json).not.toMatch(/"ciphertext"/);
    expect(json.toLowerCase()).not.toContain("encryptedkey");

    // On-disk record has ciphertext but never plaintext key equal to address derivation leak in public
    const record = loadWalletRecord(cfg.agentWalletDir, info.id);
    expect(record.encryptedKey.ciphertext).toBeTruthy();
    expect(record.encryptedKey.alg).toBe("aes-256-gcm");
    const diskJson = readFileSync(
      join(cfg.agentWalletDir, `${info.id}.json`),
      "utf8",
    );
    // decrypted key must not appear on disk as plaintext 0x+64hex matching account
    const pk = decryptPrivateKey(record.encryptedKey, cfg.agentWalletMasterKey!);
    expect(privateKeyToAccount(pk).address.toLowerCase()).toBe(
      info.address.toLowerCase(),
    );
    // master key itself not on disk
    expect(diskJson).not.toContain(cfg.agentWalletMasterKey);
  });

  it("neverReturnPrivateKey strips encrypted material from accidental payloads", () => {
    const cleaned = neverReturnPrivateKey({
      address: "0xabc",
      privateKey: "0x" + "ab".repeat(32),
      encryptedKey: { ciphertext: "dead", iv: "beef" },
      ciphertext: "ff00",
      ok: true,
    });
    expect(cleaned.privateKey).toBe("[REDACTED]");
    expect(cleaned.encryptedKey).toBe("[REDACTED]");
    expect(cleaned.ciphertext).toBe("[REDACTED]");
    expect(cleaned.ok).toBe(true);
    expect(JSON.stringify(cleaned)).not.toMatch(/dead|ff00|ababab/);
  });

  it("stripSecrets never leaks keys in nested JSON responses", () => {
    const payload = {
      data: {
        wallets: [
          {
            id: "aw_1",
            private_key: "0xsecret",
            nested: { seed: "words", balance: "1" },
          },
        ],
      },
    };
    const out = stripSecrets(payload);
    expect(out.data.wallets[0]!.private_key).toBe("[REDACTED]");
    expect(out.data.wallets[0]!.nested.seed).toBe("[REDACTED]");
    expect(out.data.wallets[0]!.nested.balance).toBe("1");
  });

  it("kill switch disables signing and clears allowlists", async () => {
    const cfg = testConfig();
    const info = await createAgentWallet(cfg);
    const wpls = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27" as const;
    const withList = await setAgentPolicy(cfg, info.id, {
      contractAllowlist: [wpls],
    });
    expect(withList.policy.contractAllowlist.length).toBe(1);

    const killed = await killSwitch(cfg, info.id);
    expect(killed.policy.killed).toBe(true);
    expect(killed.policy.enabled).toBe(false);
    expect(killed.policy.contractAllowlist).toEqual([]);
    expect(killed.policy.tokenAllowlist).toEqual([]);

    // Idempotent re-kill
    const again = await killSwitch(cfg, info.id);
    expect(again.policy.killed).toBe(true);

    const check = evaluatePolicy({
      policy: killed.policy,
      dailySpend: killed.dailySpend,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(false);
  });

  it("set_agent_policy updates allowlist and time-box", async () => {
    const cfg = testConfig();
    const info = await createAgentWallet(cfg);
    const wpls = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27" as const;
    const exp = "2099-01-01T00:00:00.000Z";
    const updated = await setAgentPolicy(cfg, info.id, {
      maxPlsPerTx: 5,
      contractAllowlist: [wpls],
      allowlistExpiresAt: exp,
      tokenSpendCaps: { [wpls]: 3 },
    });
    expect(updated.policy.maxPlsPerTx).toBe(5);
    expect(updated.policy.contractAllowlist[0]!.toLowerCase()).toBe(
      wpls.toLowerCase(),
    );
    expect(updated.policy.allowlistExpiresAt).toBe(exp);
    expect(updated.policy.tokenSpendCaps[wpls.toLowerCase()]).toBe(3);
    expect(updated.allowlistExpired).toBe(false);
  });

  it("execute_agent_tx requires confirm=true (fail closed)", async () => {
    const cfg = testConfig();
    await expect(executeAgentTx(cfg, "prop_" + "ab".repeat(12), false)).rejects.toThrow(
      /confirm/i,
    );
  });

  it("agent_wallet_status warns when enabled and never returns secrets", () => {
    const cfg = testConfig({ agentWalletEnabled: true });
    const st = agentWalletSystemStatus(cfg);
    expect(st.enabled).toBe(true);
    expect(String(st.enableWarning)).toMatch(
      /SECURITY WARNING|operator-trust|funding the agent/i,
    );
    const json = JSON.stringify(st);
    expect(json).not.toMatch(PRIVATE_KEY_HEX_RE);
    expect(json).not.toContain(cfg.agentWalletMasterKey!);
    // Boolean flags may mention "masterKeyConfigured" / "privateKeysInResponses"
    // but must not embed secret values
    expect(st).not.toHaveProperty("privateKey");
    expect(st).not.toHaveProperty("AGENT_WALLET_MASTER_KEY");

    const off = agentWalletSystemStatus(
      testConfig({ agentWalletEnabled: false }),
    );
    expect(off.enabled).toBe(false);
    expect(off.enableWarning).toBeUndefined();
  });

  it("transfer_pls requires confirm; kill switch blocks without key leak", async () => {
    const cfg = testConfig({ maxPlsPerTx: 1, maxPlsDaily: 1 });
    const info = await createAgentWallet(cfg);
    await expect(
      transferPls(cfg, {
        walletId: info.id,
        to: "0x0000000000000000000000000000000000000001",
        amountPls: 50,
        confirm: false,
      }),
    ).rejects.toThrow(/confirm/i);

    await killSwitch(cfg, info.id);
    await expect(
      transferPls(cfg, {
        walletId: info.id,
        to: "0x0000000000000000000000000000000000000001",
        amountPls: 50,
        confirm: true,
      }),
    ).rejects.toThrow(/kill|disabled|blocked/i);

    const log = readAuditLog(cfg.agentWalletDir);
    expect(log.some((e) => e.action === "kill_switch")).toBe(true);
    expect(JSON.stringify(log)).not.toMatch(PRIVATE_KEY_HEX_RE);
  });

  it("audit log is append-only and has no private keys", async () => {
    const cfg = testConfig();
    const info = await createAgentWallet(cfg);
    await killSwitch(cfg, info.id);
    const log = readAuditLog(cfg.agentWalletDir);
    expect(log.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(log);
    expect(text).not.toMatch(/privateKey|ciphertext|mnemonic/i);
    expect(log.some((e) => e.action === "create_wallet")).toBe(true);
    expect(log.some((e) => e.action === "kill_switch")).toBe(true);
  });

  it("rejects operations when AGENT_WALLET_ENABLED=false", async () => {
    const cfg = testConfig({ agentWalletEnabled: false });
    await expect(createAgentWallet(cfg)).rejects.toThrow(/disabled/i);
    await expect(
      executeAgentTx(cfg, "prop_" + "ab".repeat(12), true),
    ).rejects.toThrow(/disabled/i);
    await expect(
      transferPls(cfg, {
        walletId: "aw_" + "cd".repeat(16),
        to: "0x0000000000000000000000000000000000000001",
        amountPls: 1,
        confirm: true,
      }),
    ).rejects.toThrow(/disabled/i);
  });

  it("rejects create without master key", async () => {
    const cfg = testConfig({ agentWalletMasterKey: undefined });
    await expect(createAgentWallet(cfg)).rejects.toThrow(/MASTER_KEY/i);
  });

  it("responses never contain privateKey or 0x private key hex patterns", async () => {
    const cfg = testConfig();
    const info = await createAgentWallet(cfg, { label: "no-leak" });
    const record = loadWalletRecord(cfg.agentWalletDir, info.id);
    const pk = decryptPrivateKey(
      record.encryptedKey,
      cfg.agentWalletMasterKey!,
    );

    const publicSurfaces = [
      info,
      await getAgentWalletInfo(cfg, info.id, { includeBalance: false }),
      agentWalletSystemStatus(cfg),
      neverReturnPrivateKey({
        ...info,
        // accidental secret fields must be stripped
        privateKey: pk,
        encryptedKey: record.encryptedKey,
      }),
    ];

    for (const surface of publicSurfaces) {
      const json = JSON.stringify(surface);
      expect(json).not.toMatch(/"privateKey"\s*:\s*"0x/i);
      expect(json).not.toMatch(/"private_key"\s*:\s*"0x/i);
      expect(json).not.toContain(pk);
      expect(json).not.toContain(pk.slice(2)); // raw 64-hex without 0x
      // Redacted payloads may still have address (40 hex) but not 64-hex keys
      if (!("encryptedKey" in (surface as object))) {
        // public info objects should not embed any 0x+64hex key material
        const matches = json.match(PRIVATE_KEY_HEX_RE) ?? [];
        expect(matches).toEqual([]);
      }
    }

    // stripSecrets on nested leak
    const stripped = stripSecrets({
      result: { privateKey: pk, ok: true, address: info.address },
    });
    expect(JSON.stringify(stripped)).not.toContain(pk);
    expect(stripped.result.privateKey).toBe("[REDACTED]");
  });

  it("agent_wallet_status never includes secrets", () => {
    const cfg = testConfig();
    const status = agentWalletSystemStatus(cfg);
    const cleaned = neverReturnPrivateKey(status);
    expect(cleaned.masterKeyConfigured).toBe(true);
    expect(JSON.stringify(cleaned)).not.toContain(cfg.agentWalletMasterKey!);
  });

  it("get_agent_wallet_info returns no encrypted fields", async () => {
    const cfg = testConfig();
    const created = await createAgentWallet(cfg);
    const info = await getAgentWalletInfo(cfg, created.id, {
      includeBalance: false,
    });
    const json = JSON.stringify(info);
    expect(json).not.toMatch(/encrypted|ciphertext|privateKey/i);
    expect(info.address).toBe(created.address);
  });

  it("save/load wallet record preserves structure", () => {
    const dir = tempWalletDir();
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const master = randomBytes(32).toString("hex");
    const record: AgentWalletRecord = {
      id: "aw_" + "ab".repeat(16),
      address: account.address,
      createdAt: new Date().toISOString(),
      encryptedKey: encryptPrivateKey(pk, master),
      policy: DEFAULT_POLICY(1, 10),
      dailySpend: { date: "2020-01-01", spentPls: 0 },
      tokenDailySpend: {},
    };
    saveWalletRecord(dir, record);
    const loaded = loadWalletRecord(dir, record.id);
    expect(loaded.address).toBe(record.address);
    expect(decryptPrivateKey(loaded.encryptedKey, master).toLowerCase()).toBe(
      pk.toLowerCase(),
    );
    appendAudit(dir, {
      ts: new Date().toISOString(),
      action: "create_wallet",
      walletId: record.id,
      ok: true,
    });
  });
});
