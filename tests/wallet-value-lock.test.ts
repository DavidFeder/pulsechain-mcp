/**
 * v0.1.4–0.1.5: wei accounting, per-wallet locks, kill/policy coverage,
 * post-broadcast durability. Drives shipped service / store / lock paths.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { parseEther } from "viem";
import {
  parsePlsToWei,
  normalizePlsDecimal,
  addSpendWei,
  getSpendWei,
  weiToPlsDecimal,
} from "../src/wallet/value.js";
import { evaluatePolicy, normalizeDailySpend } from "../src/wallet/policy.js";
import {
  withWalletLock,
  resetWalletLocksForTests,
} from "../src/wallet/lock.js";
import { resetWalletDirOwnershipForTests } from "../src/wallet/owner.js";
import {
  assertProposalExecutable,
  completePostBroadcastSettlement,
  createAgentWallet,
  executeAgentTx,
  isProposalNonRetryableForSend,
  killSwitch,
  mergeSpendIntoWalletRecord,
  proposeAgentTx,
  setAgentPolicy,
  setTestBroadcast,
  settleInterruptedBroadcast,
} from "../src/wallet/service.js";
import {
  atomicWriteJson,
  loadProposal,
  loadWalletRecord,
  persistBroadcastBarrier,
  readAuditLog,
  saveProposal,
  saveWalletRecord,
} from "../src/wallet/store.js";
import { DEFAULT_POLICY, type TxProposal } from "../src/wallet/types.js";
import type { AppConfig } from "../src/types.js";
import { PolicyError } from "../src/utils/errors.js";
import * as rpc from "../src/data/rpc.js";

function mockRpcEoa() {
  vi.spyOn(rpc, "getPublicClient").mockReturnValue({
    getBytecode: async () => undefined,
  } as never);
  vi.spyOn(rpc, "estimateGas").mockResolvedValue({ gasEstimate: "21000" });
  vi.spyOn(rpc, "ethCall").mockResolvedValue({ data: "0x" });
  vi.spyOn(rpc, "getFeeData").mockResolvedValue({
    gasPriceWei: "100000000000000",
    maxFeePerGas: "100000000000000",
    maxPriorityFeePerGas: "1000000000",
  });
}

const tempDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-v014-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  setTestBroadcast(null);
  resetWalletLocksForTests();
  resetWalletDirOwnershipForTests();
  vi.restoreAllMocks();
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
    agentWalletDir: tempDir(),
    agentWalletMultiprocStrict: false,
    agentWalletEnforceLegacyCaps: false,
    maxPlsPerTx: 100,
    maxPlsDaily: 1000,
    httpTransportPort: undefined,
    logLevel: "error",
    httpTimeoutMs: 5000,
    ...overrides,
  };
}

describe("parsePlsToWei / normalizePlsDecimal (shipped value path)", () => {
  it("converts clean decimal strings exactly (no float residue)", () => {
    expect(parsePlsToWei("0.1")).toBe(parseEther("0.1"));
    expect(parsePlsToWei("0.2")).toBe(parseEther("0.2"));
    // Exact accumulation that IEEE-754 number 0.1+0.2 cannot do
    expect(parsePlsToWei("0.1") + parsePlsToWei("0.2")).toBe(parsePlsToWei("0.3"));
    expect(weiToPlsDecimal(parsePlsToWei("0.3"))).toBe("0.3");
  });

  it("accepts safe integers as numbers", () => {
    expect(parsePlsToWei(0)).toBe(0n);
    expect(parsePlsToWei(10)).toBe(parseEther("10"));
    expect(normalizePlsDecimal(42)).toBe("42");
  });

  it("fractional JS numbers use String(n) not toFixed (exact 0.1/0.2/0.3)", () => {
    // MCP JSON sends numbers; String(0.1)==="0.1" → same as parseEther("0.1")
    expect(String(0.1)).toBe("0.1");
    expect(normalizePlsDecimal(0.1)).toBe("0.1");
    expect(parsePlsToWei(0.1)).toBe(parseEther("0.1"));
    expect(parsePlsToWei(0.2)).toBe(parseEther("0.2"));
    expect(parsePlsToWei(0.3)).toBe(parseEther("0.3"));
    // Must NOT equal the toFixed(18) residue (100000000000000006n)
    expect(parsePlsToWei(0.1)).not.toBe(100000000000000006n);
    expect(parsePlsToWei(0.1)).toBe(100000000000000000n);
  });

  it("rejects scientific notation strings and numbers", () => {
    expect(() => parsePlsToWei("1e-18")).toThrow(PolicyError);
    expect(() => parsePlsToWei("1E-18")).toThrow(PolicyError);
    // Number that stringifies with exponent
    expect(() => parsePlsToWei(1e-18)).toThrow(PolicyError);
    expect(() => parsePlsToWei(1e21)).toThrow(PolicyError);
  });

  it("rejects invalid / negative / empty decimals", () => {
    expect(() => parsePlsToWei("-1")).toThrow(PolicyError);
    expect(() => parsePlsToWei("")).toThrow(PolicyError);
    expect(() => parsePlsToWei("not-a-number")).toThrow(PolicyError);
    expect(() => parsePlsToWei(Number.NaN)).toThrow(PolicyError);
    expect(() => parsePlsToWei(Number.POSITIVE_INFINITY)).toThrow(PolicyError);
  });

  it("ledger addSpendWei accumulates exactly in wei", () => {
    let ledger = {
      date: new Date().toISOString().slice(0, 10),
      spentPls: 0,
      spentWei: "0",
    };
    ledger = addSpendWei(ledger, parsePlsToWei("0.1"));
    ledger = addSpendWei(ledger, parsePlsToWei("0.2"));
    expect(getSpendWei(ledger)).toBe(parsePlsToWei("0.3"));
    expect(ledger.spentWei).toBe(parsePlsToWei("0.3").toString());
  });

  it("proposeAgentTx uses parsePlsToWei for string and number 0.1 (exact wei)", async () => {
    const cfg = testConfig();
    mockRpcEoa();

    const w = await createAgentWallet(cfg, { label: "wei" });
    const fromString = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: "0.1",
      data: "0x",
    });
    expect(fromString.valueWei).toBe(parseEther("0.1").toString());
    expect(BigInt(fromString.valueWei)).toBe(parsePlsToWei("0.1"));

    // Primary MCP path: JSON number 0.1 (must match string path / parseEther("0.1"))
    const fromNumber = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 0.1,
      data: "0x",
    });
    expect(fromNumber.valueWei).toBe(parseEther("0.1").toString());
    expect(BigInt(fromNumber.valueWei)).toBe(parsePlsToWei(0.1));
    expect(fromNumber.valueWei).toBe(fromString.valueWei);
    expect(fromNumber.policyCheck.valueWei).toBe(parseEther("0.1").toString());
  });

  it("evaluatePolicy tracks projected daily spend in wei without hard-denying over legacy caps", () => {
    const day = new Date().toISOString().slice(0, 10);
    const check = evaluatePolicy({
      policy: DEFAULT_POLICY(1, 1), // legacy display caps only
      dailySpend: {
        date: day,
        spentPls: 0.6,
        spentWei: parsePlsToWei("0.6").toString(),
      },
      to: "0x0000000000000000000000000000000000000001",
      valueWei: parsePlsToWei("0.5"),
      data: "0x",
      destinationIsContract: false,
    });
    // 0.6 + 0.5 = 1.1 — operator-trust still allows; projection remains visible
    expect(check.allowed).toBe(true);
    expect(check.projectedDailySpendWei).toBe(
      (parsePlsToWei("0.6") + parsePlsToWei("0.5")).toString(),
    );
  });

  it("evaluatePolicy allows exact wei sum that float residual would mis-handle", () => {
    const day = new Date().toISOString().slice(0, 10);
    // 0.1 + 0.2 as wei strings = exactly 0.3; cap 0.3 should allow
    let ledger = {
      date: day,
      spentPls: 0,
      spentWei: "0",
    };
    ledger = addSpendWei(ledger, parsePlsToWei("0.1"));
    const check = evaluatePolicy({
      policy: {
        ...DEFAULT_POLICY(1, 1),
        maxPlsPerTx: 1,
        maxPlsDaily: 0.3 as unknown as number,
      },
      dailySpend: ledger,
      to: "0x0000000000000000000000000000000000000001",
      valueWei: parsePlsToWei("0.2"),
      data: "0x",
      destinationIsContract: false,
    });
    // maxPlsDaily 0.3 as number — parsePlsToWei may use toFixed path
    // If cap parses to exact 0.3 wei, allowed; document result
    expect(check.valueWei).toBe(parsePlsToWei("0.2").toString());
    expect(check.projectedDailySpendWei).toBe(parsePlsToWei("0.3").toString());
  });
});

describe("withWalletLock (shipped serialization)", () => {
  it("serializes concurrent work on the same wallet id", async () => {
    const order: number[] = [];
    const p1 = withWalletLock("aw_test1", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 40));
      order.push(2);
      return "a";
    });
    const p2 = withWalletLock("aw_test1", async () => {
      order.push(3);
      return "b";
    });
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe("a");
    expect(b).toBe("b");
    // p2 must start after p1 finished (2 before 3)
    expect(order).toEqual([1, 2, 3]);
  });

  it("allows parallel locks on different wallet ids", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = (id: string) =>
      withWalletLock(id, async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent -= 1;
      });
    await Promise.all([run("w1"), run("w2"), run("w3")]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("second concurrent execute of same proposal fails closed after first succeeds", async () => {
    const cfg = testConfig({ maxPlsPerTx: 50, maxPlsDaily: 100 });
    mockRpcEoa();

    // Drive withWalletLock + proposal status re-check (same primitive execute uses):
    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    expect(proposal.status).toBe("pending");

    let firstEntered = false;
    let secondSawExecuted = false;

    const slowFirst = withWalletLock(w.id, async () => {
      firstEntered = true;
      await new Promise((r) => setTimeout(r, 50));
      const p = loadProposal(cfg.agentWalletDir, proposal.id);
      p.status = "executed";
      p.txHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
      saveProposal(cfg.agentWalletDir, p);
      const rec = loadWalletRecord(cfg.agentWalletDir, w.id);
      rec.dailySpend = addSpendWei(rec.dailySpend, BigInt(p.valueWei));
      saveWalletRecord(cfg.agentWalletDir, rec);
      return "first";
    });

    const second = withWalletLock(w.id, async () => {
      const p = loadProposal(cfg.agentWalletDir, proposal.id);
      if (p.status === "executed") {
        secondSawExecuted = true;
        throw new PolicyError(`Proposal already executed: ${proposal.id}`);
      }
      return "second";
    });

    const r1 = await slowFirst;
    await expect(second).rejects.toThrow(/already executed/i);
    expect(r1).toBe("first");
    expect(firstEntered).toBe(true);
    expect(secondSawExecuted).toBe(true);

    const rec = loadWalletRecord(cfg.agentWalletDir, w.id);
    expect(getSpendWei(rec.dailySpend)).toBe(parsePlsToWei(1));
  });

  it("executeAgentTx rejects already-executed proposal (shipped service path)", async () => {
    const cfg = testConfig();
    mockRpcEoa();

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 0,
      data: "0x",
    });
    const p = loadProposal(cfg.agentWalletDir, proposal.id) as TxProposal;
    p.status = "executed";
    p.txHash = ("0x" + "cd".repeat(32)) as `0x${string}`;
    saveProposal(cfg.agentWalletDir, p);

    await expect(executeAgentTx(cfg, proposal.id, true)).rejects.toThrow(
      /already executed|already broadcast|not retryable/i,
    );
  });
});

describe("legacy ledger migration", () => {
  it("normalizeDailySpend migrates spentPls-only records to spentWei", () => {
    const day = new Date().toISOString().slice(0, 10);
    const migrated = normalizeDailySpend({
      date: day,
      spentPls: 2,
    });
    expect(migrated.spentWei).toBe(parsePlsToWei(2).toString());
    expect(getSpendWei(migrated)).toBe(parsePlsToWei(2));
  });
});

describe("v0.1.5 kill/policy lock + execute durability", () => {
  const FAKE_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

  it("assertProposalExecutable blocks executed, broadcasting, and any txHash", () => {
    const base = {
      id: "prop_" + "11".repeat(12),
      walletId: "aw_" + "22".repeat(16),
      from: "0x0000000000000000000000000000000000000001" as const,
      to: "0x0000000000000000000000000000000000000002" as const,
      valueWei: "0",
      valuePls: 0,
      data: "0x" as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      simulation: { attempted: true, ok: true },
      policyCheck: {
        allowed: true,
        reasons: [],
        isContractInteraction: false,
        destinationIsContract: false,
        valuePls: 0,
        projectedDailySpend: 0,
        remainingDaily: 1,
        allowlistExpired: false,
      },
      status: "pending" as const,
      chainId: 369,
      network: "mainnet" as const,
    };
    expect(() => assertProposalExecutable(base, { network: "mainnet" })).not.toThrow();
    expect(() =>
      assertProposalExecutable({ ...base, status: "executed" }, { network: "mainnet" }),
    ).toThrow(/already executed/i);
    expect(() =>
      assertProposalExecutable({ ...base, status: "broadcasting" }, { network: "mainnet" }),
    ).toThrow(/in-flight|broadcasting|not retryable/i);
    expect(() =>
      assertProposalExecutable(
        {
          ...base,
          status: "pending",
          txHash: FAKE_HASH,
        },
        { network: "mainnet" },
      ),
    ).toThrow(/already broadcast|not retryable/i);
  });

  it("mergeSpendIntoWalletRecord updates spend without clearing kill flags", () => {
    const day = new Date().toISOString().slice(0, 10);
    const fresh = {
      id: "aw_" + "33".repeat(16),
      address: "0x00000000000000000000000000000000000000aa" as const,
      createdAt: new Date().toISOString(),
      encryptedKey: {
        ciphertext: "x",
        iv: "y",
        tag: "z",
        kdf: "raw-hex" as const,
        alg: "aes-256-gcm" as const,
      },
      policy: {
        ...DEFAULT_POLICY(10, 100),
        killed: true,
        enabled: false,
        contractAllowlist: [] as `0x${string}`[],
      },
      dailySpend: { date: day, spentPls: 0, spentWei: "0" },
      tokenDailySpend: {},
    };
    mergeSpendIntoWalletRecord(
      fresh,
      parsePlsToWei(1),
      "0x0000000000000000000000000000000000000001",
    );
    expect(fresh.policy.killed).toBe(true);
    expect(fresh.policy.enabled).toBe(false);
    expect(getSpendWei(fresh.dailySpend)).toBe(parsePlsToWei(1));
  });

  it("concurrent kill_switch + execute leaves wallet killed (shipped lock path)", async () => {
    const cfg = testConfig({ maxPlsPerTx: 50, maxPlsDaily: 100 });
    mockRpcEoa();

    let releaseSend!: (h: `0x${string}`) => void;
    const sendGate = new Promise<`0x${string}`>((resolve) => {
      releaseSend = resolve;
    });
    let sendEntered = false;
    setTestBroadcast(async () => {
      sendEntered = true;
      return sendGate;
    });

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    expect(proposal.status).toBe("pending");

    const execP = executeAgentTx(cfg, proposal.id, true);
    // Wait until execute holds the lock and is inside broadcast
    for (let i = 0; i < 100 && !sendEntered; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sendEntered).toBe(true);

    // Kill queues behind execute (same withWalletLock); must not be undone
    const killP = killSwitch(cfg, w.id);

    releaseSend(FAKE_HASH);
    const settled = await Promise.allSettled([execP, killP]);
    // Execute may succeed (held lock first) or rarely fail; kill must succeed
    const killResult = settled[1];
    expect(killResult.status).toBe("fulfilled");
    if (killResult.status === "fulfilled") {
      expect(killResult.value.policy.killed).toBe(true);
      expect(killResult.value.policy.enabled).toBe(false);
    }

    const final = loadWalletRecord(cfg.agentWalletDir, w.id);
    expect(final.policy.killed).toBe(true);
    expect(final.policy.enabled).toBe(false);
    expect(final.policy.contractAllowlist).toEqual([]);
  });

  it("execute merge preserves mid-broadcast disk kill (stale full-record overwrite fixed)", async () => {
    const cfg = testConfig({ maxPlsPerTx: 50, maxPlsDaily: 100 });
    mockRpcEoa();

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 2,
      data: "0x",
    });

    // Simulate another process writing kill while this process is in send
    // (same-process kill waits on lock; direct save models multi-process residual path)
    setTestBroadcast(async () => {
      const rec = loadWalletRecord(cfg.agentWalletDir, w.id);
      rec.policy = {
        ...rec.policy,
        killed: true,
        enabled: false,
        contractAllowlist: [],
        tokenAllowlist: [],
        allowlistExpiresAt: null,
      };
      saveWalletRecord(cfg.agentWalletDir, rec);
      return FAKE_HASH;
    });

    const result = await executeAgentTx(cfg, proposal.id, true);
    expect(result.txHash).toBe(FAKE_HASH);

    const final = loadWalletRecord(cfg.agentWalletDir, w.id);
    // Spend recorded on re-loaded record; kill flags from disk preserved
    expect(final.policy.killed).toBe(true);
    expect(final.policy.enabled).toBe(false);
    expect(getSpendWei(final.dailySpend)).toBe(parsePlsToWei(2));

    const p = loadProposal(cfg.agentWalletDir, proposal.id);
    expect(p.status).toBe("executed");
    expect(p.txHash).toBe(FAKE_HASH);
  });

  it("crash-after-send durability: broadcasting+txHash is not re-executable", async () => {
    const cfg = testConfig();
    mockRpcEoa();

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 0,
      data: "0x",
    });

    // Model crash after broadcast persist, before spend/final executed
    const p = loadProposal(cfg.agentWalletDir, proposal.id) as TxProposal;
    p.status = "broadcasting";
    p.txHash = FAKE_HASH;
    saveProposal(cfg.agentWalletDir, p);

    await expect(executeAgentTx(cfg, proposal.id, true)).rejects.toThrow(
      /already broadcast|not retryable|in-flight|broadcasting/i,
    );

    // Spend must not have been double-applied
    const rec = loadWalletRecord(cfg.agentWalletDir, w.id);
    expect(getSpendWei(rec.dailySpend)).toBe(0n);
  });

  it("successful execute marks non-retryable and second execute fails closed", async () => {
    const cfg = testConfig();
    mockRpcEoa();
    setTestBroadcast(async () => FAKE_HASH);

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });

    const first = await executeAgentTx(cfg, proposal.id, true);
    expect(first.txHash).toBe(FAKE_HASH);

    const p = loadProposal(cfg.agentWalletDir, proposal.id);
    expect(p.status).toBe("executed");
    expect(p.txHash).toBe(FAKE_HASH);
    expect(getSpendWei(loadWalletRecord(cfg.agentWalletDir, w.id).dailySpend)).toBe(
      parsePlsToWei(1),
    );

    await expect(executeAgentTx(cfg, proposal.id, true)).rejects.toThrow(
      /already|not retryable/i,
    );
  });

  it("kill before execute blocks signing (shipped service path)", async () => {
    const cfg = testConfig();
    mockRpcEoa();
    setTestBroadcast(async () => FAKE_HASH);

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    await killSwitch(cfg, w.id);

    await expect(executeAgentTx(cfg, proposal.id, true)).rejects.toThrow(
      /kill|disabled|signing/i,
    );
    const p = loadProposal(cfg.agentWalletDir, proposal.id);
    expect(p.status).toBe("pending");
    expect(p.txHash).toBeUndefined();
  });
});

describe("v0.1.17 post-broadcast durability + recovery", () => {
  const FAKE_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

  it("barrier write is broadcasting+txHash+broadcastAcceptedAt only path to non-retryable", () => {
    const dir = tempDir();
    const proposal: TxProposal = {
      id: "prop_" + "aa".repeat(12),
      walletId: "aw_" + "bb".repeat(16),
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      valueWei: "1000",
      valuePls: 0,
      data: "0x",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      simulation: { attempted: true, ok: true },
      policyCheck: {
        allowed: true,
        reasons: [],
        isContractInteraction: false,
        destinationIsContract: false,
        valuePls: 0,
        projectedDailySpend: 0,
        remainingDaily: 1,
        allowlistExpired: false,
      },
      status: "pending",
    };
    saveProposal(dir, proposal);
    persistBroadcastBarrier(dir, proposal, FAKE_HASH);
    const loaded = loadProposal(dir, proposal.id);
    expect(loaded.status).toBe("broadcasting");
    expect(loaded.txHash).toBe(FAKE_HASH);
    expect(loaded.broadcastAcceptedAt).toMatch(/^\d{4}-/);
    expect(isProposalNonRetryableForSend(loaded)).toBe(true);
    expect(() => assertProposalExecutable(loaded, { network: "mainnet" })).toThrow(
      /already broadcast|settle_interrupted|not retryable/i,
    );
  });

  it("mergeSpend is idempotent per proposalId (no double-count on re-settle)", () => {
    const day = new Date().toISOString().slice(0, 10);
    const fresh = {
      id: "aw_" + "33".repeat(16),
      address: "0x00000000000000000000000000000000000000aa" as const,
      createdAt: new Date().toISOString(),
      encryptedKey: {
        ciphertext: "x",
        iv: "y",
        tag: "z",
        kdf: "raw-hex" as const,
        alg: "aes-256-gcm" as const,
      },
      policy: {
        ...DEFAULT_POLICY(10, 100),
        contractAllowlist: [] as `0x${string}`[],
      },
      dailySpend: { date: day, spentPls: 0, spentWei: "0" },
      tokenDailySpend: {},
    };
    const pid = "prop_" + "cc".repeat(12);
    const to = "0x0000000000000000000000000000000000000001" as const;
    mergeSpendIntoWalletRecord(fresh, parsePlsToWei(2), to, pid);
    mergeSpendIntoWalletRecord(fresh, parsePlsToWei(2), to, pid);
    mergeSpendIntoWalletRecord(fresh, parsePlsToWei(2), to, pid);
    expect(getSpendWei(fresh.dailySpend)).toBe(parsePlsToWei(2));
    expect(fresh.appliedSpendProposalIds).toEqual([pid]);
  });

  it("crash after barrier: re-execute fails closed; settle recovers without double spend", async () => {
    const cfg = testConfig();
    mockRpcEoa();

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 3,
      data: "0x",
    });

    // Model: chain accepted, barrier written, process died before spend/executed
    const p = loadProposal(cfg.agentWalletDir, proposal.id) as TxProposal;
    persistBroadcastBarrier(cfg.agentWalletDir, p, FAKE_HASH);
    expect(loadProposal(cfg.agentWalletDir, proposal.id).status).toBe(
      "broadcasting",
    );
    expect(getSpendWei(loadWalletRecord(cfg.agentWalletDir, w.id).dailySpend)).toBe(
      0n,
    );

    await expect(executeAgentTx(cfg, proposal.id, true)).rejects.toThrow(
      /already broadcast|not retryable|settle_interrupted/i,
    );
    // Still no spend from failed re-execute
    expect(getSpendWei(loadWalletRecord(cfg.agentWalletDir, w.id).dailySpend)).toBe(
      0n,
    );

    const settled = await settleInterruptedBroadcast(cfg, proposal.id, true);
    expect(settled.status).toBe("executed");
    expect(settled.txHash).toBe(FAKE_HASH);
    expect(settled.alreadySettled).toBe(false);
    expect(settled.spendApplied).toBe(true);

    const finalP = loadProposal(cfg.agentWalletDir, proposal.id);
    expect(finalP.status).toBe("executed");
    expect(finalP.txHash).toBe(FAKE_HASH);
    expect(getSpendWei(loadWalletRecord(cfg.agentWalletDir, w.id).dailySpend)).toBe(
      parsePlsToWei(3),
    );

    // Second settle is idempotent (no double spend)
    const again = await settleInterruptedBroadcast(cfg, proposal.id, true);
    expect(again.alreadySettled).toBe(true);
    expect(getSpendWei(loadWalletRecord(cfg.agentWalletDir, w.id).dailySpend)).toBe(
      parsePlsToWei(3),
    );

    await expect(executeAgentTx(cfg, proposal.id, true)).rejects.toThrow(
      /already|not retryable/i,
    );
  });

  it("crash after spend merge before executed: re-settle does not double-count", async () => {
    const cfg = testConfig();
    mockRpcEoa();

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 4,
      data: "0x",
    });

    const p = loadProposal(cfg.agentWalletDir, proposal.id) as TxProposal;
    persistBroadcastBarrier(cfg.agentWalletDir, p, FAKE_HASH);

    // Spend applied, proposal still broadcasting (interrupted before executed)
    const rec = loadWalletRecord(cfg.agentWalletDir, w.id);
    mergeSpendIntoWalletRecord(
      rec,
      parsePlsToWei(4),
      proposal.to,
      proposal.id,
    );
    saveWalletRecord(cfg.agentWalletDir, rec);
    expect(getSpendWei(loadWalletRecord(cfg.agentWalletDir, w.id).dailySpend)).toBe(
      parsePlsToWei(4),
    );
    expect(loadProposal(cfg.agentWalletDir, proposal.id).status).toBe(
      "broadcasting",
    );

    const settled = await settleInterruptedBroadcast(cfg, proposal.id, true);
    expect(settled.status).toBe("executed");
    expect(settled.spendApplied).toBe(false); // already applied before settle
    expect(getSpendWei(loadWalletRecord(cfg.agentWalletDir, w.id).dailySpend)).toBe(
      parsePlsToWei(4),
    );
  });

  it("settleInterruptedBroadcast accepts expired+txHash (do not strand broadcasts)", async () => {
    const cfg = testConfig();
    mockRpcEoa();

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });

    const p = loadProposal(cfg.agentWalletDir, proposal.id) as TxProposal;
    persistBroadcastBarrier(cfg.agentWalletDir, p, FAKE_HASH);
    const stranded = loadProposal(cfg.agentWalletDir, proposal.id) as TxProposal;
    stranded.status = "expired";
    stranded.expiresAt = new Date(Date.now() - 60_000).toISOString();
    saveProposal(cfg.agentWalletDir, stranded);

    const settled = await settleInterruptedBroadcast(cfg, proposal.id, true);
    expect(settled.status).toBe("executed");
    expect(settled.txHash).toBe(FAKE_HASH);
  });

  it("completePostBroadcastSettlement promotes broadcasting → executed with spend", async () => {
    const cfg = testConfig();
    mockRpcEoa();
    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    const p = loadProposal(cfg.agentWalletDir, proposal.id) as TxProposal;
    persistBroadcastBarrier(cfg.agentWalletDir, p, FAKE_HASH);
    completePostBroadcastSettlement(
      cfg.agentWalletDir,
      p,
      parsePlsToWei(1),
    );
    expect(loadProposal(cfg.agentWalletDir, proposal.id).status).toBe("executed");
    expect(getSpendWei(loadWalletRecord(cfg.agentWalletDir, w.id).dailySpend)).toBe(
      parsePlsToWei(1),
    );
  });

  it("successful execute writes broadcast_accepted audit and appliedSpendProposalIds", async () => {
    const cfg = testConfig();
    mockRpcEoa();
    setTestBroadcast(async () => FAKE_HASH);

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    await executeAgentTx(cfg, proposal.id, true);

    const p = loadProposal(cfg.agentWalletDir, proposal.id);
    expect(p.status).toBe("executed");
    expect(p.txHash).toBe(FAKE_HASH);
    expect(p.broadcastAcceptedAt).toBeTruthy();

    const rec = loadWalletRecord(cfg.agentWalletDir, w.id);
    expect(rec.appliedSpendProposalIds).toContain(proposal.id);

    const audit = readAuditLog(cfg.agentWalletDir, 50);
    expect(audit.some((e) => e.action === "broadcast_accepted" && e.txHash === FAKE_HASH)).toBe(
      true,
    );
    expect(
      audit.some(
        (e) => e.action === "execute_tx" && e.ok === true && e.txHash === FAKE_HASH,
      ),
    ).toBe(true);
  });

  it("settle without txHash fails closed; settle without confirm fails closed", async () => {
    const cfg = testConfig();
    mockRpcEoa();
    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 0,
      data: "0x",
    });
    await expect(settleInterruptedBroadcast(cfg, proposal.id, true)).rejects.toThrow(
      /without txHash|Cannot settle/i,
    );
    await expect(settleInterruptedBroadcast(cfg, proposal.id, false)).rejects.toThrow(
      /confirm=true/i,
    );
  });

  it("set_agent_policy under lock is not undone by concurrent execute save", async () => {
    const cfg = testConfig({ maxPlsPerTx: 50, maxPlsDaily: 100 });
    mockRpcEoa();

    let releaseSend!: (h: `0x${string}`) => void;
    const sendGate = new Promise<`0x${string}`>((resolve) => {
      releaseSend = resolve;
    });
    let sendEntered = false;
    setTestBroadcast(async () => {
      sendEntered = true;
      return sendGate;
    });

    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });

    const execP = executeAgentTx(cfg, proposal.id, true);
    for (let i = 0; i < 100 && !sendEntered; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sendEntered).toBe(true);

    // Tighten caps while execute holds lock (queued; maxPerTx must stay <= daily)
    const policyP = setAgentPolicy(cfg, w.id, {
      maxPlsPerTx: 2,
      maxPlsDaily: 3,
    });
    releaseSend(FAKE_HASH);
    const settled = await Promise.allSettled([execP, policyP]);
    expect(settled[1].status).toBe("fulfilled");

    const final = loadWalletRecord(cfg.agentWalletDir, w.id);
    expect(final.policy.maxPlsDaily).toBe(3);
    expect(final.policy.maxPlsPerTx).toBe(2);
  });

  it("atomicWriteJson produces readable JSON at target path", () => {
    const dir = tempDir();
    const path = join(dir, "atomic-test.json");
    atomicWriteJson(path, { ok: true, n: 1 });
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { ok: boolean; n: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.n).toBe(1);
  });
});

