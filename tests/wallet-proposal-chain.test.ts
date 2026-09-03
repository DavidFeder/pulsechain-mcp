/**
 * Sealed proposal chainId/network (item 4): persist at propose, refuse
 * execute on mismatch or missing chainId, bind chain in confirm intent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/types.js";
import * as rpc from "../src/data/rpc.js";
import {
  assertSameExecutionIntent,
  computeIntentHash,
  proposalExecutionIntentArgs,
} from "../src/utils/confirm.js";
import {
  assertProposalExecutable,
  createAgentWallet,
  executeAgentTx,
  proposeAgentTx,
  setTestBroadcast,
  settleInterruptedBroadcast,
  transferPls,
} from "../src/wallet/service.js";
import {
  formatConfirmPrompt,
  formatSealedChainLabel,
} from "../src/wallet/reviewSummary.js";
import {
  loadProposal,
  persistBroadcastBarrier,
  saveProposal,
} from "../src/wallet/store.js";
import { resetWalletLocksForTests } from "../src/wallet/lock.js";
import { resetWalletDirOwnershipForTests } from "../src/wallet/owner.js";
import type { TxProposal } from "../src/wallet/types.js";

const FAKE_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const tempDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-chain-"));
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

function intentBase(overrides: Record<string, unknown> = {}) {
  return {
    id: "prop_" + "ab".repeat(12),
    walletId: "aw_" + "cd".repeat(16),
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    valueWei: "1",
    data: "0x",
    chainId: 369,
    network: "mainnet",
    ...overrides,
  };
}

describe("proposeAgentTx seals chainId and network", () => {
  it("testnet propose stores chainId 943 and network testnet", async () => {
    mockRpcEoa();
    const cfg = testConfig({ network: "testnet" });
    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    expect(proposal.chainId).toBe(943);
    expect(proposal.network).toBe("testnet");
    const stored = loadProposal(cfg.agentWalletDir, proposal.id);
    expect(stored.chainId).toBe(943);
    expect(stored.network).toBe("testnet");
    expect(proposal.reviewSummary.chainId).toBe(943);
    expect(proposal.reviewSummary.network).toBe("testnet");
    expect(proposal.reviewSummary.headline).toMatch(/943/);
    expect(formatConfirmPrompt(proposal.reviewSummary)).toMatch(
      /Chain: 943 \(testnet\)/,
    );
  });

  it("mainnet propose stores chainId 369 and network mainnet", async () => {
    mockRpcEoa();
    const cfg = testConfig({ network: "mainnet" });
    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    expect(proposal.chainId).toBe(369);
    expect(proposal.network).toBe("mainnet");
    expect(loadProposal(cfg.agentWalletDir, proposal.id).chainId).toBe(369);
    expect(formatConfirmPrompt(proposal.reviewSummary)).toMatch(
      /Chain: 369 \(mainnet\)/,
    );
  });

  it("transfer_pls propose-then-confirm stamps the same sealed chain", async () => {
    mockRpcEoa();
    setTestBroadcast(async () => FAKE_HASH);
    const cfg = testConfig({ network: "testnet" });
    const w = await createAgentWallet(cfg);
    const result = await transferPls(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      amountPls: 1,
      confirm: true,
    });
    const stored = loadProposal(cfg.agentWalletDir, result.proposalId);
    expect(stored.chainId).toBe(943);
    expect(stored.network).toBe("testnet");
    expect(result.reviewSummary.chainId).toBe(943);
  });
});

describe("execute refuses sealed-chain mismatch and missing chainId", () => {
  it("execute throws when proposal is 369 and live config is testnet", async () => {
    mockRpcEoa();
    let broadcasted = false;
    setTestBroadcast(async () => {
      broadcasted = true;
      return FAKE_HASH;
    });
    const cfg = testConfig({ network: "mainnet" });
    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    expect(proposal.chainId).toBe(369);

    const liveTestnet = { ...cfg, network: "testnet" as const };
    await expect(executeAgentTx(liveTestnet, proposal.id, true)).rejects.toThrow(
      /sealed for chainId 369.*943.*testnet.*[Rr]e-propose/s,
    );
    expect(broadcasted).toBe(false);
    expect(loadProposal(cfg.agentWalletDir, proposal.id).status).toBe("pending");
  });

  it("execute throws when proposal is 943 and live config is mainnet", async () => {
    mockRpcEoa();
    let broadcasted = false;
    setTestBroadcast(async () => {
      broadcasted = true;
      return FAKE_HASH;
    });
    const cfg = testConfig({ network: "testnet" });
    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    expect(proposal.chainId).toBe(943);

    const liveMainnet = { ...cfg, network: "mainnet" as const };
    await expect(executeAgentTx(liveMainnet, proposal.id, true)).rejects.toThrow(
      /sealed for chainId 943.*369.*mainnet.*[Rr]e-propose/s,
    );
    expect(broadcasted).toBe(false);
  });

  it("missing chainId on a pending proposal refuses execute (does not assume 369)", async () => {
    mockRpcEoa();
    let broadcasted = false;
    setTestBroadcast(async () => {
      broadcasted = true;
      return FAKE_HASH;
    });
    const cfg = testConfig({ network: "mainnet" });
    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    const stored = loadProposal(cfg.agentWalletDir, proposal.id);
    delete stored.chainId;
    delete stored.network;
    saveProposal(cfg.agentWalletDir, stored);

    await expect(executeAgentTx(cfg, proposal.id, true)).rejects.toThrow(
      /no sealed chainId|legacy on-disk|[Rr]e-propose/i,
    );
    expect(broadcasted).toBe(false);
    expect(loadProposal(cfg.agentWalletDir, proposal.id).status).toBe("pending");
    expect(loadProposal(cfg.agentWalletDir, proposal.id).chainId).toBeUndefined();
  });

  it("legacy pending without chainId is still loadable; settle does not re-broadcast", async () => {
    mockRpcEoa();
    const cfg = testConfig();
    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    const stored = loadProposal(cfg.agentWalletDir, proposal.id) as TxProposal;
    delete stored.chainId;
    delete stored.network;
    saveProposal(cfg.agentWalletDir, stored);
    persistBroadcastBarrier(
      cfg.agentWalletDir,
      loadProposal(cfg.agentWalletDir, proposal.id),
      FAKE_HASH,
    );

    const loaded = loadProposal(cfg.agentWalletDir, proposal.id);
    expect(loaded.chainId).toBeUndefined();
    expect(loaded.txHash).toBe(FAKE_HASH);

    const settled = await settleInterruptedBroadcast(cfg, proposal.id, true);
    expect(settled.status).toBe("executed");
    expect(settled.txHash).toBe(FAKE_HASH);

    await expect(executeAgentTx(cfg, proposal.id, true)).rejects.toThrow(
      /already|not retryable/i,
    );
  });
});

describe("proposalExecutionIntentArgs / assertSameExecutionIntent bind chain", () => {
  it("includes chainId and network in intent args", () => {
    const args = proposalExecutionIntentArgs(intentBase());
    expect(args.chainId).toBe(369);
    expect(args.network).toBe("mainnet");
    expect(args).toMatchObject({
      to: "0x2222222222222222222222222222222222222222",
      valueWei: "1",
      data: "0x",
    });
  });

  it("intent hash changes when chainId changes", () => {
    const honest = computeIntentHash(
      "execute_agent_tx",
      proposalExecutionIntentArgs(intentBase({ chainId: 369 })),
    );
    const flipped = computeIntentHash(
      "execute_agent_tx",
      proposalExecutionIntentArgs(intentBase({ chainId: 943, network: "testnet" })),
    );
    expect(honest).not.toBe(flipped);
  });

  it("assertSameExecutionIntent fails if chainId changes", () => {
    const before = intentBase({ chainId: 369, network: "mainnet" });
    const after = intentBase({ chainId: 943, network: "testnet" });
    expect(() => assertSameExecutionIntent(before, after)).toThrow(
      /Proposal changed after confirmation/i,
    );
  });

  it("assertSameExecutionIntent accepts identical sealed chain", () => {
    const before = intentBase();
    const after = intentBase();
    expect(() => assertSameExecutionIntent(before, after)).not.toThrow();
  });
});

describe("formatSealedChainLabel / assertProposalExecutable chain gate", () => {
  it("labels 369 vs 943 for humans", () => {
    expect(formatSealedChainLabel(369, "mainnet")).toBe("369 (mainnet)");
    expect(formatSealedChainLabel(943, "testnet")).toBe("943 (testnet)");
    expect(formatSealedChainLabel(undefined)).toMatch(/unsealed.*re-propose/i);
  });

  it("assertProposalExecutable refuses pending missing chainId", () => {
    const pending = {
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
        legacyCapsDisplayOnly: true as const,
      },
      status: "pending" as const,
    };
    expect(() =>
      assertProposalExecutable(pending, { network: "mainnet" }),
    ).toThrow(/no sealed chainId|[Rr]e-propose/i);
    expect(() =>
      assertProposalExecutable(
        { ...pending, chainId: 369, network: "mainnet" },
        { network: "testnet" },
      ),
    ).toThrow(/chainId 369.*943|[Rr]e-propose/s);
  });
});
