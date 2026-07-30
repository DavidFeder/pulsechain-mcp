/**
 * v0.1.6: multi-process ownership marker + post-broadcast barrier.
 * Drives shipped owner.ts / store.persistBroadcastBarrier / service status.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  buildWalletDirOwnershipStatusView,
  claimWalletDirOwnership,
  clearOwnerMarker,
  ensureWalletDirClaimed,
  getProcessOwnerId,
  isPidAlive,
  parseOwnerRecord,
  readOwnerMarker,
  resetWalletDirOwnershipForTests,
  writeOwnerMarker,
  WALLET_DIR_OWNER_FILENAME,
} from "../src/wallet/owner.js";
import {
  loadProposal,
  persistBroadcastBarrier,
  saveProposal,
} from "../src/wallet/store.js";
import {
  agentWalletSystemStatus,
  buildOperatorAtAGlance,
  createAgentWallet,
  listAgentWallets,
  setTestBroadcast,
  executeAgentTx,
  proposeAgentTx,
  killSwitch,
} from "../src/wallet/service.js";
import type { AppConfig } from "../src/types.js";
import type { TxProposal } from "../src/wallet/types.js";
import * as rpc from "../src/data/rpc.js";
import { vi } from "vitest";

const tempDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-own-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  setTestBroadcast(null);
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
    maxPlsPerTx: 100,
    maxPlsDaily: 1000,
    httpTransportPort: undefined,
    logLevel: "error",
    httpTimeoutMs: 5000,
    ...overrides,
  };
}

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

describe("isPidAlive / parseOwnerRecord (shipped)", () => {
  it("reports current process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("reports nonsense / zero PID as not alive", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    // Extremely high PID unlikely to exist
    expect(isPidAlive(2_147_483_646)).toBe(false);
  });

  it("parseOwnerRecord accepts valid and rejects garbage", () => {
    expect(
      parseOwnerRecord({
        pid: 123,
        ownerId: "abcd",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      pid: 123,
      ownerId: "abcd",
      startedAt: "2026-01-01T00:00:00.000Z",
      hostname: undefined,
    });
    expect(parseOwnerRecord(null)).toBeNull();
    expect(parseOwnerRecord({ pid: "x", ownerId: "ab", startedAt: "t" })).toBeNull();
    expect(parseOwnerRecord({ pid: 1, ownerId: "ab", startedAt: "t" })).toBeNull();
  });
});

describe("claimWalletDirOwnership (shipped)", () => {
  it("acquires empty dir and marks ours on re-claim", () => {
    const dir = tempDir();
    const first = claimWalletDirOwnership(dir);
    expect(first.status).toBe("acquired");
    expect(first.multiProcessRisk).toBe(false);
    expect(first.owner.pid).toBe(process.pid);
    expect(first.owner.ownerId).toBe(getProcessOwnerId());
    expect(readOwnerMarker(dir)?.pid).toBe(process.pid);

    const second = claimWalletDirOwnership(dir);
    expect(second.status).toBe("ours");
    expect(second.multiProcessRisk).toBe(false);
  });

  it("reclaims marker from dead (stale) foreign PID", () => {
    const dir = tempDir();
    writeOwnerMarker(dir, {
      pid: 2_147_483_646, // almost certainly dead
      ownerId: "deadbeefdead",
      startedAt: "2020-01-01T00:00:00.000Z",
      hostname: "old-host",
    });
    const result = claimWalletDirOwnership(dir);
    expect(result.status).toBe("reclaimed");
    expect(result.multiProcessRisk).toBe(false);
    expect(result.previous?.ownerId).toBe("deadbeefdead");
    expect(result.owner.pid).toBe(process.pid);
    expect(readOwnerMarker(dir)?.ownerId).toBe(getProcessOwnerId());
  });

  it("detects conflict when marker has a live foreign PID", async () => {
    const dir = tempDir();
    // Spawn a short-lived child so we have a real foreign live PID
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    try {
      const childPid = child.pid;
      expect(childPid).toBeTypeOf("number");
      expect(isPidAlive(childPid!)).toBe(true);

      writeOwnerMarker(dir, {
        pid: childPid!,
        ownerId: "foreign01foreign",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      resetWalletDirOwnershipForTests();

      const result = claimWalletDirOwnership(dir);
      expect(result.status).toBe("conflict");
      expect(result.multiProcessRisk).toBe(true);
      expect(result.warning).toMatch(
        /shared with another live process|process-local/i,
      );
      // Must not overwrite foreign live marker
      expect(readOwnerMarker(dir)?.ownerId).toBe("foreign01foreign");
      expect(readOwnerMarker(dir)?.pid).toBe(childPid);
    } finally {
      child.kill();
    }
  });

  it("ensureWalletDirClaimed caches non-conflict ownership", () => {
    const dir = tempDir();
    const a = ensureWalletDirClaimed(dir);
    expect(["acquired", "ours", "reclaimed"]).toContain(a.status);
    const b = ensureWalletDirClaimed(dir);
    expect(b.status).toBe(a.status === "acquired" ? "acquired" : b.status);
    expect(b.owner.ownerId).toBe(a.owner.ownerId);
  });

  it("marker filename is stable", () => {
    expect(WALLET_DIR_OWNER_FILENAME).toBe(".mcp-wallet-owner.json");
  });
});

describe("buildOperatorAtAGlance (shipped operator UX)", () => {
  const baseOwnership = {
    status: "acquired" as const,
    multiProcessRisk: false,
    multiprocStrict: false,
    multiprocMode: "warn-only" as const,
    writesBlockedByMultiproc: false,
    riskLevel: "none" as const,
    thisProcessPid: process.pid,
    recommendedAction: "OK",
    recommendedModel: "one process → one unique AGENT_WALLET_DIR",
    locksAreProcessLocalOnly: true as const,
    notADistributedLock: true as const,
    posture: "process-local",
  };

  it("disabled wallets snapshot is scannable and points at enable checklist", () => {
    const snap = buildOperatorAtAGlance({
      enabled: false,
      masterKeyConfigured: false,
      maxPlsPerTx: 100,
      maxPlsDaily: 1000,
      walletCount: 0,
      killedWalletCount: 0,
      ownership: {
        ...baseOwnership,
        status: "disabled",
      },
    });
    expect(snap.walletsEnabled).toBe(false);
    expect(snap.policyPosture).toBe("disabled");
    expect(snap.headline).toMatch(/OFF|disabled/i);
    expect(snap.writesBlocked).toBe(false);
    expect(snap.safeFlow).toMatch(/inspect_tx_intent.*propose_agent_tx.*execute_agent_tx/i);
    expect(snap.nextAction).toMatch(/Leave disabled|MASTER_KEY|unique/i);
    expect(snap.nextAction).toMatch(
      /process-local|not a distributed lock|MULTIPROC_STRICT|host-strength/i,
    );
    expect(snap.bullets.join(" ")).toMatch(
      /multi-writer|unique AGENT_WALLET_DIR|host-strength/i,
    );
    expect(JSON.stringify(snap)).not.toMatch(/privateKey|0x[a-f0-9]{64}/i);
  });

  it("blocked multiproc surfaces writesBlocked and nextAction", () => {
    const snap = buildOperatorAtAGlance({
      enabled: true,
      masterKeyConfigured: true,
      maxPlsPerTx: 5,
      maxPlsDaily: 20,
      walletCount: 1,
      killedWalletCount: 0,
      ownership: {
        ...baseOwnership,
        multiProcessRisk: true,
        multiprocStrict: true,
        multiprocMode: "strict-fail-closed",
        writesBlockedByMultiproc: true,
        riskLevel: "blocked",
        recommendedAction: "STOP: unique dir",
      },
    });
    expect(snap.writesBlocked).toBe(true);
    expect(snap.multiprocRisk).toBe(true);
    expect(snap.policyPosture).toBe("operator_trust");
    expect(snap.headline).toMatch(/BLOCKED|multiproc/i);
    expect(snap.nextAction).toMatch(/unique AGENT_WALLET_DIR|other MCP/i);
  });

  it("enabled wallets report operator_trust posture regardless of legacy MAX_PLS_* numbers", () => {
    const looseNums = buildOperatorAtAGlance({
      enabled: true,
      masterKeyConfigured: true,
      maxPlsPerTx: 5000,
      maxPlsDaily: 50000,
      walletCount: 2,
      killedWalletCount: 0,
      ownership: baseOwnership,
    });
    expect(looseNums.policyPosture).toBe("operator_trust");
    expect(looseNums.headline).toMatch(/operator-trust|fund/i);
  });

  it("lab-scale defaults still show PulseChain gas bullets under operator_trust", () => {
    const snap = buildOperatorAtAGlance({
      enabled: true,
      masterKeyConfigured: true,
      maxPlsPerTx: 500,
      maxPlsDaily: 2000,
      walletCount: 1,
      killedWalletCount: 0,
      ownership: baseOwnership,
    });
    expect(snap.policyPosture).toBe("operator_trust");
    expect(snap.policyPostureNote).toMatch(/Operator-trust|funding the agent/i);
    expect(snap.bullets.join(" ")).toMatch(/EIP-1559|BEATS/i);
    expect(snap.bullets.join(" ")).toMatch(/value|gas headroom|total PLS|Operator-trust/i);
    expect(snap.nextAction).toMatch(/gas|operator-trust|propose/i);
  });
});

describe("persistBroadcastBarrier (shipped durability)", () => {
  it("writes broadcasting + txHash immediately and blocks re-execute semantics", () => {
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
    const hash = ("0x" + "ef".repeat(32)) as `0x${string}`;
    persistBroadcastBarrier(dir, proposal, hash);
    const loaded = loadProposal(dir, proposal.id);
    expect(loaded.status).toBe("broadcasting");
    expect(loaded.txHash).toBe(hash);
  });
});

describe("buildWalletDirOwnershipStatusView (shipped pure status)", () => {
  it("maps clean ownership to riskLevel none", () => {
    const view = buildWalletDirOwnershipStatusView(
      {
        status: "acquired",
        multiProcessRisk: false,
        owner: {
          pid: process.pid,
          ownerId: "selfselfself",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      false,
    );
    expect(view.riskLevel).toBe("none");
    expect(view.writesBlockedByMultiproc).toBe(false);
    expect(view.multiProcessRisk).toBe(false);
    expect(view.recommendedModel).toMatch(/one process/i);
    expect(view.recommendedAction).toMatch(/OK|owns/i);
    expect(view.thisProcessPid).toBe(process.pid);
    expect(view.notADistributedLock).toBe(true);
    expect(view.foreignOwner).toBeUndefined();
  });

  it("maps live foreign conflict to warn vs blocked by strict flag", () => {
    const conflict = {
      status: "conflict" as const,
      multiProcessRisk: true,
      owner: {
        pid: 999001,
        ownerId: "foreignpeerxx",
        startedAt: "2026-01-01T00:00:00.000Z",
        hostname: "peer-host",
      },
      warning: "SECURITY WARNING: shared",
    };
    const warn = buildWalletDirOwnershipStatusView(conflict, false);
    expect(warn.riskLevel).toBe("warn");
    expect(warn.writesBlockedByMultiproc).toBe(false);
    expect(warn.multiprocMode).toBe("warn-only");
    expect(warn.foreignOwner?.pid).toBe(999001);
    expect(warn.foreignOwner?.hostname).toBe("peer-host");
    expect(warn.recommendedAction).toMatch(/WARN|unique|MULTIPROC_STRICT/i);

    const blocked = buildWalletDirOwnershipStatusView(conflict, true);
    expect(blocked.riskLevel).toBe("blocked");
    expect(blocked.writesBlockedByMultiproc).toBe(true);
    expect(blocked.multiprocMode).toBe("strict-fail-closed");
    expect(blocked.recommendedAction).toMatch(/STOP|refused|unique/i);
  });
});

describe("agent_wallet_status multiproc fields + execute barrier (service path)", () => {
  it("status reports process-local locks and ownership when enabled", async () => {
    const cfg = testConfig();
    const st = agentWalletSystemStatus(cfg) as {
      operatorAtAGlance?: {
        headline: string;
        walletsEnabled: boolean;
        multiprocRisk: boolean;
        writesBlocked: boolean;
        policyPosture: string;
        safeFlow: string;
        nextAction: string;
        bullets: string[];
      };
      walletDirOwnership: {
        multiProcessRisk: boolean;
        locksAreProcessLocalOnly: boolean;
        notADistributedLock?: boolean;
        multiprocMode?: string;
        multiprocStrict?: boolean;
        writesBlockedByMultiproc?: boolean;
        riskLevel?: string;
        recommendedAction?: string;
        recommendedModel?: string;
        thisProcessPid?: number;
        posture?: string;
        status: string;
      };
      security: {
        multiProcessSharedDir: string;
        multiprocRecommendedModel?: string;
        multiprocStrictDoesNot?: string;
        multiprocModeMeanings?: string;
        residualCrashWindow: string;
        postBroadcastDurability?: string;
        tokenAllowlistSemantics?: string;
        safeFlow?: string;
        recommendation?: string;
        confirmRequired?: string;
        confirmHostStrengthOnly?: boolean;
      };
      enableWarning?: string;
    };
    expect(st.walletDirOwnership.locksAreProcessLocalOnly).toBe(true);
    expect(st.walletDirOwnership.notADistributedLock).toBe(true);
    expect(st.walletDirOwnership.multiProcessRisk).toBe(false);
    expect(st.walletDirOwnership.multiprocMode).toBe("warn-only");
    expect(st.walletDirOwnership.multiprocStrict).toBe(false);
    expect(st.walletDirOwnership.writesBlockedByMultiproc).toBe(false);
    expect(st.walletDirOwnership.riskLevel).toBe("none");
    expect(st.walletDirOwnership.thisProcessPid).toBe(process.pid);
    expect(String(st.walletDirOwnership.recommendedAction)).toMatch(
      /OK|owns|unique/i,
    );
    expect(String(st.walletDirOwnership.recommendedModel)).toMatch(
      /one process/i,
    );
    expect(String(st.walletDirOwnership.posture)).toMatch(
      /process-local|not a distributed lock|MULTIPROC_STRICT/i,
    );
    expect(["acquired", "ours", "reclaimed"]).toContain(
      st.walletDirOwnership.status,
    );
    expect(st.security.multiProcessSharedDir).toMatch(
      /process-local|unique AGENT_WALLET_DIR|MULTIPROC_STRICT/i,
    );
    expect(String(st.security.multiprocRecommendedModel)).toMatch(
      /one process/i,
    );
    expect(String(st.security.multiprocStrictDoesNot)).toMatch(
      /distributed lock|multi-writer/i,
    );
    expect(String(st.security.multiprocModeMeanings)).toMatch(
      /warn-only|strict|distributed lock/i,
    );
    expect(st.security.confirmHostStrengthOnly).toBe(true);
    expect(String(st.security.confirmRequired)).toMatch(/host UX|confirm/i);
    // operatorAtAGlance must make shared-dir / not-distributed-lock hard to miss
    expect(st.operatorAtAGlance!.bullets.join(" ")).toMatch(
      /process-local|not a distributed lock|multi-writer|warn-only|MULTIPROC/i,
    );
    expect(st.operatorAtAGlance!.bullets.join(" ")).toMatch(/host UX|confirm|operator-trust/i);
    expect(st.security.residualCrashWindow).toMatch(
      /barrier|pending|settle_interrupted|explorer/i,
    );
    expect(String(st.security.postBroadcastDurability)).toMatch(
      /broadcasting|txHash|idempotent|settle/i,
    );
    expect(String(st.enableWarning)).toMatch(/process-local|AGENT_WALLET_DIR/i);
    expect(String(st.security.tokenAllowlistSemantics)).toMatch(
      /operator-trust|Legacy|funding/i,
    );
    expect(String((st.security as { executeSerialization?: string }).executeSerialization)).toMatch(
      /settle/i,
    );
    // Operator UX snapshot (v0.1.19)
    expect(st.operatorAtAGlance).toBeDefined();
    expect(st.operatorAtAGlance!.walletsEnabled).toBe(true);
    expect(st.operatorAtAGlance!.writesBlocked).toBe(false);
    expect(st.operatorAtAGlance!.headline).toMatch(/Wallets ON/i);
    expect(st.operatorAtAGlance!.safeFlow).toMatch(
      /inspect_tx_intent|propose_agent_tx|reviewSummary|execute_agent_tx/i,
    );
    expect(st.operatorAtAGlance!.bullets.length).toBeGreaterThanOrEqual(4);
    expect(st.operatorAtAGlance!.nextAction.length).toBeGreaterThan(10);
    expect(String(st.security.safeFlow)).toMatch(/inspect_tx_intent|propose_agent_tx/i);
    expect(String(st.security.recommendation)).toMatch(/inspect_tx_intent|propose_agent_tx|operator-trust|MASTER_KEY/i);
    // Status text must describe operator-trust notional posture (advisory, not hard gate)
    const security = st.security as {
      tokenNotional: string;
      trustModel?: string;
    };
    expect(security.tokenNotional).toMatch(/advisory|not a hard deny/i);
    expect(String(security.trustModel ?? "")).toMatch(/operator-trust|funding/i);
  });

  it("status surfaces multiproc strict mode when configured", () => {
    const cfg = testConfig({ agentWalletMultiprocStrict: true });
    const st = agentWalletSystemStatus(cfg) as {
      walletDirOwnership: {
        multiprocStrict: boolean;
        multiprocMode: string;
        notADistributedLock: boolean;
        riskLevel: string;
      };
    };
    expect(st.walletDirOwnership.multiprocStrict).toBe(true);
    expect(st.walletDirOwnership.multiprocMode).toBe("strict-fail-closed");
    expect(st.walletDirOwnership.notADistributedLock).toBe(true);
    expect(st.walletDirOwnership.riskLevel).toBe("none");
  });

  it("multiproc strict refuses create when multiProcessRisk is true (shipped gate)", async () => {
    const dir = tempDir();
    const cfg = testConfig({
      agentWalletDir: dir,
      agentWalletMultiprocStrict: true,
    });
    const ownerMod = await import("../src/wallet/owner.js");
    const spy = vi.spyOn(ownerMod, "ensureWalletDirClaimed").mockReturnValue({
      status: "conflict",
      multiProcessRisk: true,
      owner: {
        pid: 424242,
        ownerId: "foreignpeer01",
        startedAt: new Date().toISOString(),
      },
      warning: "SECURITY WARNING: shared AGENT_WALLET_DIR (test)",
    });

    await expect(createAgentWallet(cfg)).rejects.toThrow(
      /MULTIPROC_STRICT|write refused|shared|foreign pid/i,
    );
    spy.mockRestore();
  });

  it("warn-only multiproc still allows create when multiProcessRisk is true", async () => {
    const dir = tempDir();
    const cfg = testConfig({
      agentWalletDir: dir,
      agentWalletMultiprocStrict: false,
    });
    const ownerMod = await import("../src/wallet/owner.js");
    const spy = vi.spyOn(ownerMod, "ensureWalletDirClaimed").mockReturnValue({
      status: "conflict",
      multiProcessRisk: true,
      owner: {
        pid: 424243,
        ownerId: "foreignpeer02",
        startedAt: new Date().toISOString(),
      },
      warning: "SECURITY WARNING: shared AGENT_WALLET_DIR (test)",
    });

    const w = await createAgentWallet(cfg);
    expect(w.id).toMatch(/^aw_/);
    spy.mockRestore();
  });

  it("live foreign owner: status risk fields + strict write refuse (real claim path)", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    try {
      const childPid = child.pid;
      expect(childPid).toBeTypeOf("number");
      expect(isPidAlive(childPid!)).toBe(true);

      const dir = tempDir();
      writeOwnerMarker(dir, {
        pid: childPid!,
        ownerId: "liveforeign01",
        startedAt: "2026-01-01T00:00:00.000Z",
        hostname: "test-peer",
      });
      resetWalletDirOwnershipForTests();

      // Status (warn-only) must surface multiproc risk without mocking claim.
      const warnCfg = testConfig({
        agentWalletDir: dir,
        agentWalletMultiprocStrict: false,
      });
      const stWarn = agentWalletSystemStatus(warnCfg) as {
        walletDirOwnership: {
          multiProcessRisk: boolean;
          riskLevel: string;
          writesBlockedByMultiproc: boolean;
          multiprocMode: string;
          foreignOwner?: { pid: number; hostname?: string };
          recommendedAction: string;
          status: string;
        };
      };
      expect(stWarn.walletDirOwnership.status).toBe("conflict");
      expect(stWarn.walletDirOwnership.multiProcessRisk).toBe(true);
      expect(stWarn.walletDirOwnership.riskLevel).toBe("warn");
      expect(stWarn.walletDirOwnership.writesBlockedByMultiproc).toBe(false);
      expect(stWarn.walletDirOwnership.multiprocMode).toBe("warn-only");
      expect(stWarn.walletDirOwnership.foreignOwner?.pid).toBe(childPid);
      expect(stWarn.walletDirOwnership.foreignOwner?.hostname).toBe("test-peer");
      expect(stWarn.walletDirOwnership.recommendedAction).toMatch(
        /WARN|unique|MULTIPROC_STRICT/i,
      );

      // Strict: status blocked + create refused on real ownership gate.
      resetWalletDirOwnershipForTests();
      writeOwnerMarker(dir, {
        pid: childPid!,
        ownerId: "liveforeign01",
        startedAt: "2026-01-01T00:00:00.000Z",
        hostname: "test-peer",
      });
      const strictCfg = testConfig({
        agentWalletDir: dir,
        agentWalletMultiprocStrict: true,
      });
      const stStrict = agentWalletSystemStatus(strictCfg) as {
        walletDirOwnership: {
          riskLevel: string;
          writesBlockedByMultiproc: boolean;
          multiprocMode: string;
          multiProcessRisk: boolean;
        };
      };
      expect(stStrict.walletDirOwnership.multiProcessRisk).toBe(true);
      expect(stStrict.walletDirOwnership.riskLevel).toBe("blocked");
      expect(stStrict.walletDirOwnership.writesBlockedByMultiproc).toBe(true);
      expect(stStrict.walletDirOwnership.multiprocMode).toBe(
        "strict-fail-closed",
      );

      await expect(createAgentWallet(strictCfg)).rejects.toThrow(
        /MULTIPROC_STRICT|write refused|foreign pid|unique AGENT_WALLET_DIR/i,
      );

      // List is read-only: still allowed under strict conflict for diagnostics.
      const listed = listAgentWallets(strictCfg);
      expect(Array.isArray(listed)).toBe(true);

      // Marker must remain the foreign live owner (no steal).
      expect(readOwnerMarker(dir)?.ownerId).toBe("liveforeign01");
      expect(readOwnerMarker(dir)?.pid).toBe(childPid);
    } finally {
      child.kill();
    }
  });

  it("live foreign owner: strict kill refuses with explicit multiproc error", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    try {
      const childPid = child.pid!;
      const dir = tempDir();
      // Create wallet first under clean ownership, then inject foreign live marker.
      const setupCfg = testConfig({
        agentWalletDir: dir,
        agentWalletMultiprocStrict: false,
      });
      const w = await createAgentWallet(setupCfg);

      writeOwnerMarker(dir, {
        pid: childPid,
        ownerId: "liveforeign02",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      resetWalletDirOwnershipForTests();

      const strictCfg = testConfig({
        agentWalletDir: dir,
        agentWalletMultiprocStrict: true,
      });
      await expect(killSwitch(strictCfg, w.id)).rejects.toThrow(
        /MULTIPROC_STRICT|write refused|foreign pid/i,
      );
    } finally {
      child.kill();
    }
  });

  it("execute uses barrier so proposal is non-retryable after success", async () => {
    const cfg = testConfig();
    mockRpcEoa();
    const hash = ("0x" + "12".repeat(32)) as `0x${string}`;
    setTestBroadcast(async () => hash);

    const w = await createAgentWallet(cfg);
    // Ownership marker should exist after first write path
    expect(readOwnerMarker(cfg.agentWalletDir)?.pid).toBe(process.pid);

    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 0,
      data: "0x",
    });
    await executeAgentTx(cfg, proposal.id, true);
    const p = loadProposal(cfg.agentWalletDir, proposal.id);
    expect(p.status).toBe("executed");
    expect(p.txHash).toBe(hash);

    await expect(executeAgentTx(cfg, proposal.id, true)).rejects.toThrow(
      /already|not retryable/i,
    );
  });

  it("clearOwnerMarker removes file for clean re-acquire", () => {
    const dir = tempDir();
    claimWalletDirOwnership(dir);
    expect(readOwnerMarker(dir)).not.toBeNull();
    clearOwnerMarker(dir);
    resetWalletDirOwnershipForTests();
    expect(readOwnerMarker(dir)).toBeNull();
    const again = claimWalletDirOwnership(dir);
    expect(again.status).toBe("acquired");
  });
});

