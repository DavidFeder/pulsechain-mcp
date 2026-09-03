/**
 * v0.1.38 operator-trust: shipped evaluatePolicy + public create path.
 * Proves former hard denies (empty allowlist, over caps) no longer block,
 * and public wallet info never includes private/encrypted material.
 * Uses placeholder addresses only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/wallet/policy.js";
import { DEFAULT_POLICY } from "../src/wallet/types.js";
import { createAgentWallet, getAgentWalletInfo } from "../src/wallet/service.js";
import type { AppConfig } from "../src/types.js";
import { neverReturnPrivateKey } from "../src/utils/safety.js";
import { parsePlsToWei } from "../src/wallet/value.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-ot-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function testConfig(): AppConfig {
  return {
    rpcUrl: "https://rpc.pulsechain.com",
    rpcUrls: ["https://rpc.pulsechain.com"],
    network: "mainnet",
    explorerApi: "https://api.scan.pulsechain.com/api",
    pulseXSubgraphV1: "https://example.com/v1",
    pulseXSubgraphV2: "https://example.com/v2",
    agentWalletEnabled: true,
    agentWalletMasterKey: randomBytes(32).toString("hex"),
    agentWalletDir: tempDir(),
    agentWalletMultiprocStrict: true,
    maxPlsPerTx: 1,
    maxPlsDaily: 5,
    httpTransportPort: undefined,
    logLevel: "error",
    httpTimeoutMs: 5000,
  };
}

describe("operator-trust wallet path (shipped)", () => {
  it("shipped tool/service/review strings no longer claim policy backstop theater", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = process.cwd();
    const files = [
      "src/tools/wallet/index.ts",
      "src/wallet/reviewSummary.ts",
      "src/wallet/service.ts",
      "src/wallet/tokenNotional.ts",
      "src/wallet/policy.ts",
      "src/server.ts",
      "src/utils/safety.ts",
      "src/tools/chain/operations.ts",
      "package.json",
      "docs/SECURITY.md",
      "docs/SECURITY_DEEP.md",
    ];
    const ban =
      /Policy is the real backstop|Policy\/caps are the real backstop|policy-constrained agent wallets|Policy-gated sign and broadcast|policy-gated agent wallets|also gated by maxPls|contract destinations need allowlist entry|Empty contractAllowlist denies all contract calls|empty array denies all contracts|then re-allowlist/i;
    for (const rel of files) {
      const text = readFileSync(join(root, rel), "utf8");
      expect(text, rel).not.toMatch(ban);
    }
  });

  it("server instructions use operator-trust wording", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const server = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
    expect(server).toMatch(/operator-trust agent wallets/i);
    expect(server).toMatch(/funding authorizes/i);
    expect(server).not.toMatch(/policy-gated agent wallets/i);
  });

  it("createServer instructions differ for wallets on vs research-only", async () => {
    const { mcpServerInstructions } = await import("../src/server.js");
    const walletsOn = mcpServerInstructions(true);
    const researchOnly = mcpServerInstructions(false);

    expect(walletsOn).toMatch(/operator-trust agent wallets/i);
    expect(walletsOn).toMatch(/funding authorizes/i);
    expect(walletsOn).toMatch(/confirm=true \/ MRTR is host UX only/i);

    expect(researchOnly).toMatch(/analytics and chain reads/i);
    expect(researchOnly).toMatch(/Write and signing tools refuse/i);
    expect(researchOnly).toMatch(/are not listed/i);
    expect(researchOnly).toMatch(/pulsechain:\/\/guidance\/ro-research/);
    expect(researchOnly).toMatch(/does not sign or broadcast/i);
    expect(researchOnly).not.toMatch(/funding authorizes/i);
    expect(researchOnly).not.toMatch(/Wallet writes require/i);
    expect(walletsOn).not.toBe(researchOnly);
  });

  it("evaluatePolicy marks legacy caps display-only and still allows over-cap", () => {
    const amountPls = 50_000;
    const valueWei = parsePlsToWei(amountPls);
    const check = evaluatePolicy({
      policy: DEFAULT_POLICY(1, 5),
      dailySpend: {
        date: new Date().toISOString().slice(0, 10),
        spentPls: 0,
        spentWei: "0",
      },
      to: "0x00000000000000000000000000000000000000f1",
      valueWei,
      valuePls: amountPls,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
    expect(check.legacyCapsDisplayOnly).toBe(true);
    // remainingDaily can be 0 while still allowed (display only)
    expect(check.remainingDaily).toBe(0);
  });

  it("allows contract call with empty allowlist (was deny-by-default)", () => {
    const check = evaluatePolicy({
      policy: DEFAULT_POLICY(1, 5),
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
      valueWei: 0n,
      valuePls: 0,
      data: "0xa9059cbb",
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
    expect(check.reasons).toEqual([]);
    expect(check.isContractInteraction).toBe(true);
  });

  it("allows native value far over legacy maxPlsPerTx/daily", () => {
    const amountPls = 50_000;
    const valueWei = parsePlsToWei(amountPls);
    const check = evaluatePolicy({
      policy: DEFAULT_POLICY(1, 5),
      dailySpend: {
        date: new Date().toISOString().slice(0, 10),
        spentPls: 0,
        spentWei: "0",
      },
      to: "0x00000000000000000000000000000000000000f1",
      valueWei,
      valuePls: amountPls,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
    expect(check.valuePls).toBe(amountPls);
  });

  it("create + getAgentWalletInfo public shape has no private/encrypted material", async () => {
    const cfg = testConfig();
    const created = await createAgentWallet(cfg, { label: "ot-test" });
    const info = await getAgentWalletInfo(cfg, created.id, {
      includeBalance: false,
    });
    const publicShape = neverReturnPrivateKey(info);
    const keys = Object.keys(publicShape as object);
    expect(keys).not.toContain("encryptedKey");
    expect(keys).not.toContain("privateKey");
    expect(keys).not.toContain("ciphertext");
    const json = JSON.stringify(publicShape);
    expect(json).not.toMatch(/privateKey|ciphertext|masterKey/i);
    expect(json).not.toContain(cfg.agentWalletMasterKey!);
    expect(info.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });
});
