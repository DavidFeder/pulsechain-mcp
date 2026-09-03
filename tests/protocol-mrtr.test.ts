/**
 * Unit tests for dual-protocol wallet confirm (confirm=true + MRTR InputRequiredResult).
 * Mocks round-trips; no live RPC / no real private key material in assertions.
 */
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isInputRequiredResult,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import {
  clientSupportsMrtr,
  computeIntentHash,
  getConfirmStateCodec,
  getMrtrHmacSecret,
  policySnapshotId,
  proposalExecutionIntentArgs,
  assertSameExecutionIntent,
  requireConfirmOrInput,
  resetConfirmCodecForTests,
  resetMrtrSecretForTests,
  resolveConfirm,
  sha256Hex,
  stableStringify,
  type ConfirmHandlerContext,
  type ConfirmRequestState,
} from "../src/utils/confirm.js";
import { PolicyError, ConfigError } from "../src/utils/errors.js";
import { loadConfig } from "../src/config.js";
import { stripSecrets } from "../src/utils/safety.js";
import { isInputRequiredResult as defineGuard } from "@modelcontextprotocol/server";
import { DEFAULT_POLICY } from "../src/wallet/types.js";
import type { AppConfig } from "../src/types.js";
import * as rpc from "../src/data/rpc.js";
import { resetToolRegistry } from "../src/tools/define.js";
import { registerWalletTools } from "../src/tools/wallet/index.js";
import { resetWalletLocksForTests } from "../src/wallet/lock.js";
import { resetWalletDirOwnershipForTests } from "../src/wallet/owner.js";
import {
  createAgentWallet,
  killSwitch,
  proposeAgentTx,
  setAgentPolicy,
  setTestBroadcast,
} from "../src/wallet/service.js";
import { loadWalletRecord, persistBroadcastBarrier } from "../src/wallet/store.js";

const PRIVATE_KEY_HEX_RE = /0x[a-fA-F0-9]{64}/;

afterEach(() => {
  resetConfirmCodecForTests();
  resetMrtrSecretForTests();
  delete process.env.AGENT_WALLET_MRTR_SECRET;
});

function modernCtx(
  overrides?: Partial<{
    inputResponses: Record<string, unknown>;
    requestState: string | (() => Promise<unknown>);
  }>,
): ConfirmHandlerContext {
  return {
    client: {
      protocolVersion: "2026-07-28",
      clientInfo: { name: "mrtr-test", version: "0.0.0" },
      clientCapabilities: {},
    },
    mcpCtx: {
      mcpReq: {
        envelope: {},
        inputResponses: overrides?.inputResponses,
        requestState:
          typeof overrides?.requestState === "function"
            ? overrides.requestState
            : overrides?.requestState !== undefined
              ? overrides.requestState
              : undefined,
      },
    },
  };
}

function acceptConfirmResponses(confirm = true): Record<string, unknown> {
  return {
    confirm: {
      action: "accept",
      content: { confirm },
    },
  };
}

describe("confirm helpers (hashing / snapshot)", () => {
  it("stableStringify sorts keys for deterministic intent hashes", () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(computeIntentHash("t", { a: 1, confirm: true })).toBe(
      computeIntentHash("t", { confirm: false, a: 1 }),
    );
    expect(computeIntentHash("t", { a: 1 })).not.toBe(
      computeIntentHash("t", { a: 2 }),
    );
  });

  it("policySnapshotId never embeds private key material", () => {
    const policy = DEFAULT_POLICY(10, 100);
    const id = policySnapshotId(policy);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(id).not.toMatch(PRIVATE_KEY_HEX_RE);
    expect(policySnapshotId(null)).toBe("none");
  });
});

describe("resolveConfirm dual path", () => {
  it("confirm=true proceeds immediately without InputRequiredResult", async () => {
    const r = await resolveConfirm({
      tool: "create_agent_wallet",
      message: "Create?",
      args: { confirm: true, label: "x" },
      ctx: modernCtx(),
    });
    expect(r.confirmed).toBe(true);
    if (r.confirmed) expect(r.via).toBe("arg");
  });

  it("missing confirm without MRTR context throws PolicyError (legacy path)", async () => {
    await expect(
      resolveConfirm({
        tool: "create_agent_wallet",
        message: "Create?",
        args: { label: "x" },
        // no ctx → non-MRTR
      }),
    ).rejects.toThrow(PolicyError);

    await expect(
      resolveConfirm({
        tool: "kill_switch",
        message: "Kill?",
        args: { confirm: false, walletId: "aw_" + "ab".repeat(16) },
      }),
    ).rejects.toThrow(/declined|confirm/i);
  });

  it("missing confirm + MRTR-capable ctx returns input_required shape", async () => {
    const r = await resolveConfirm({
      tool: "transfer_pls",
      message: "Transfer 1 PLS?",
      args: {
        walletId: "aw_" + "ab".repeat(16),
        to: "0x0000000000000000000000000000000000000001",
        amountPls: 1,
      },
      ctx: modernCtx(),
      walletId: "aw_" + "ab".repeat(16),
      policySnapshotId: policySnapshotId(DEFAULT_POLICY(10, 100)),
    });

    expect(r.confirmed).toBe(false);
    if (r.confirmed) throw new Error("expected input required");
    const ir = r.inputRequired;
    expect(isInputRequiredResult(ir)).toBe(true);
    expect(defineGuard(ir)).toBe(true);
    expect(ir.resultType).toBe("input_required");
    expect(ir.inputRequests?.confirm).toBeTruthy();
    expect(typeof ir.requestState).toBe("string");
    expect(ir.requestState!.length).toBeGreaterThan(20);

    // requestState must not leak private keys / master secrets
    const stateStr = ir.requestState!;
    expect(stateStr).not.toMatch(PRIVATE_KEY_HEX_RE);
    expect(stateStr.toLowerCase()).not.toContain("privatekey");
    expect(stateStr.toLowerCase()).not.toContain("mnemonic");
    expect(JSON.stringify(ir)).not.toMatch(/privateKey|ciphertext|masterKey/i);

    // Payload decodes to expected fields only
    const decoded = await getConfirmStateCodec().verify(stateStr, {} as never);
    expect(decoded.tool).toBe("transfer_pls");
    expect(decoded.step).toBe("awaiting-confirm");
    expect(decoded.walletId).toBe("aw_" + "ab".repeat(16));
    expect(decoded.intentHash).toBe(
      computeIntentHash("transfer_pls", {
        walletId: "aw_" + "ab".repeat(16),
        to: "0x0000000000000000000000000000000000000001",
        amountPls: 1,
      }),
    );
    expect(decoded.policySnapshotId).toBe(
      policySnapshotId(DEFAULT_POLICY(10, 100)),
    );
    expect(Object.keys(decoded).sort()).toEqual(
      ["exp", "intentHash", "policySnapshotId", "step", "tool", "walletId"].sort(),
    );
  });

  it("explicit confirm=false declines even when MRTR ctx is present", async () => {
    await expect(
      resolveConfirm({
        tool: "kill_switch",
        message: "Kill?",
        args: { confirm: false, walletId: "aw_" + "ab".repeat(16) },
        ctx: modernCtx(),
      }),
    ).rejects.toThrow(/declined/i);
  });

  it("proposalExecutionIntentArgs changes when destination changes", () => {
    const base = {
      id: "prop_" + "ab".repeat(12),
      walletId: "aw_" + "cd".repeat(16),
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      valueWei: "1",
      data: "0x",
    };
    const honest = computeIntentHash(
      "execute_agent_tx",
      proposalExecutionIntentArgs(base),
    );
    const tampered = computeIntentHash(
      "execute_agent_tx",
      proposalExecutionIntentArgs({
        ...base,
        to: "0x3333333333333333333333333333333333333333",
      }),
    );
    expect(honest).not.toBe(tampered);
  });

  it("proposalExecutionIntentArgs includes chainId and bind fails when it changes", () => {
    const base = {
      id: "prop_" + "ab".repeat(12),
      walletId: "aw_" + "cd".repeat(16),
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      valueWei: "1",
      data: "0x",
      chainId: 369,
      network: "mainnet" as const,
    };
    const args = proposalExecutionIntentArgs(base);
    expect(args.chainId).toBe(369);
    expect(args.network).toBe("mainnet");
    const honest = computeIntentHash(
      "execute_agent_tx",
      proposalExecutionIntentArgs(base),
    );
    const flipped = computeIntentHash(
      "execute_agent_tx",
      proposalExecutionIntentArgs({ ...base, chainId: 943, network: "testnet" }),
    );
    expect(honest).not.toBe(flipped);
    expect(() =>
      assertSameExecutionIntent(base, {
        ...base,
        chainId: 943,
        network: "testnet",
      }),
    ).toThrow(/Proposal changed after confirmation/i);
  });

  it("MRTR resume with inputResponses.confirm + echoed requestState proceeds", async () => {
    const tool = "execute_agent_tx";
    const args = { proposalId: "prop_" + "cd".repeat(12) };
    const first = await resolveConfirm({
      tool,
      message: "Execute?",
      args,
      ctx: modernCtx(),
    });
    expect(first.confirmed).toBe(false);
    if (first.confirmed) throw new Error("expected challenge");
    const requestState = first.inputRequired.requestState!;

    const resumeCtx = modernCtx({
      inputResponses: acceptConfirmResponses(true),
      requestState,
    });

    const second = await resolveConfirm({
      tool,
      message: "Execute?",
      args,
      ctx: resumeCtx,
    });
    expect(second.confirmed).toBe(true);
    if (second.confirmed) expect(second.via).toBe("mrtr");
  });

  it("confirm=true still binds echoed requestState intentHash", async () => {
    const tool = "execute_agent_tx";
    const args = {
      proposalId: "prop_" + "cd".repeat(12),
      ...proposalExecutionIntentArgs({
        id: "prop_" + "cd".repeat(12),
        walletId: "aw_" + "11".repeat(16),
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        valueWei: "1",
        data: "0x",
      }),
    };
    const first = await resolveConfirm({
      tool,
      message: "Execute?",
      args,
      ctx: modernCtx(),
    });
    expect(first.confirmed).toBe(false);
    if (first.confirmed) throw new Error("expected challenge");
    const requestState = first.inputRequired.requestState!;

    await expect(
      resolveConfirm({
        tool,
        message: "Execute?",
        args: { ...args, confirm: true, valueWei: "999" },
        ctx: modernCtx({ requestState }),
      }),
    ).rejects.toThrow(/intent/i);

    const ok = await resolveConfirm({
      tool,
      message: "Execute?",
      args: { ...args, confirm: true },
      ctx: modernCtx({ requestState }),
    });
    expect(ok.confirmed).toBe(true);
    if (ok.confirmed) expect(ok.via).toBe("arg");
  });

  it("MRTR resume rejects tampered requestState", async () => {
    const tool = "kill_switch";
    const walletId = "aw_" + "ef".repeat(16);
    const args = { walletId };
    const first = await resolveConfirm({
      tool,
      message: "Kill?",
      args,
      ctx: modernCtx(),
      walletId,
    });
    if (first.confirmed) throw new Error("expected challenge");
    const badState = first.inputRequired.requestState!.slice(0, -4) + "dead";

    await expect(
      resolveConfirm({
        tool,
        message: "Kill?",
        args,
        ctx: modernCtx({
          inputResponses: acceptConfirmResponses(true),
          requestState: badState,
        }),
        walletId,
      }),
    ).rejects.toThrow(/requestState|integrity|verification|missing/i);
  });

  it("MRTR resume rejects intentHash mismatch (args changed)", async () => {
    const tool = "transfer_pls";
    const walletId = "aw_" + "11".repeat(16);
    const args1 = {
      walletId,
      to: "0x0000000000000000000000000000000000000001",
      amountPls: 1,
    };
    const first = await resolveConfirm({
      tool,
      message: "Transfer?",
      args: args1,
      ctx: modernCtx(),
      walletId,
    });
    if (first.confirmed) throw new Error("expected challenge");

    await expect(
      resolveConfirm({
        tool,
        message: "Transfer?",
        args: { ...args1, amountPls: 999 },
        ctx: modernCtx({
          inputResponses: acceptConfirmResponses(true),
          requestState: first.inputRequired.requestState,
        }),
        walletId,
      }),
    ).rejects.toThrow(/intent/i);
  });

  it("MRTR resume rejects walletId mismatch (forgery)", async () => {
    const tool = "kill_switch";
    const walletA = "aw_" + "aa".repeat(16);
    const walletB = "aw_" + "bb".repeat(16);
    const args = { walletId: walletA };
    const first = await resolveConfirm({
      tool,
      message: "Kill?",
      args,
      ctx: modernCtx(),
      walletId: walletA,
    });
    if (first.confirmed) throw new Error("expected challenge");

    await expect(
      resolveConfirm({
        tool,
        message: "Kill?",
        args,
        ctx: modernCtx({
          inputResponses: acceptConfirmResponses(true),
          requestState: first.inputRequired.requestState,
        }),
        // Handler supplies a different wallet than sealed requestState
        walletId: walletB,
      }),
    ).rejects.toThrow(/walletId mismatch|forgery/i);
  });

  it("MRTR resume re-challenges when policy snapshot changed after mint", async () => {
    const tool = "transfer_pls";
    const walletId = "aw_" + "33".repeat(16);
    const args = {
      walletId,
      to: "0x0000000000000000000000000000000000000001",
      amountPls: 1,
    };
    const snapBefore = policySnapshotId(DEFAULT_POLICY(10, 100));
    const snapAfter = policySnapshotId(DEFAULT_POLICY(1, 10));
    expect(snapBefore).not.toBe(snapAfter);

    const first = await resolveConfirm({
      tool,
      message: "Transfer?",
      args,
      ctx: modernCtx(),
      walletId,
      policySnapshotId: snapBefore,
    });
    if (first.confirmed) throw new Error("expected challenge");

    // Accept with old requestState but current policy hash differs → force re-confirm.
    const second = await resolveConfirm({
      tool,
      message: "Transfer?",
      args,
      ctx: modernCtx({
        inputResponses: acceptConfirmResponses(true),
        requestState: first.inputRequired.requestState,
      }),
      walletId,
      policySnapshotId: snapAfter,
    });
    expect(second.confirmed).toBe(false);
    if (second.confirmed) throw new Error("expected re-challenge");
    expect(isInputRequiredResult(second.inputRequired)).toBe(true);
    const reDecoded = await getConfirmStateCodec().verify(
      second.inputRequired.requestState!,
      {} as never,
    );
    expect(reDecoded.policySnapshotId).toBe(snapAfter);
    expect(reDecoded.intentHash).toBe(computeIntentHash(tool, args));
  });

  it("MRTR resume re-challenges execute_agent_tx when policy snapshot changed after mint", async () => {
    const tool = "execute_agent_tx";
    const walletId = "aw_" + "44".repeat(16);
    const args = { proposalId: "prop_" + "ab".repeat(12) };
    const snapBefore = policySnapshotId(DEFAULT_POLICY(10, 100));
    const snapAfter = policySnapshotId(DEFAULT_POLICY(1, 10));
    expect(snapBefore).not.toBe(snapAfter);

    const first = await resolveConfirm({
      tool,
      message: "Execute?",
      args,
      ctx: modernCtx(),
      walletId,
      policySnapshotId: snapBefore,
    });
    if (first.confirmed) throw new Error("expected challenge");

    const second = await resolveConfirm({
      tool,
      message: "Execute?",
      args,
      ctx: modernCtx({
        inputResponses: acceptConfirmResponses(true),
        requestState: first.inputRequired.requestState,
      }),
      walletId,
      policySnapshotId: snapAfter,
    });
    expect(second.confirmed).toBe(false);
    if (second.confirmed) throw new Error("expected re-challenge");
    expect(isInputRequiredResult(second.inputRequired)).toBe(true);
    const reDecoded = await getConfirmStateCodec().verify(
      second.inputRequired.requestState!,
      {} as never,
    );
    expect(reDecoded.policySnapshotId).toBe(snapAfter);
    expect(reDecoded.tool).toBe(tool);
  });

  it("MRTR resume proceeds execute_agent_tx when policy snapshot is unchanged", async () => {
    const tool = "execute_agent_tx";
    const walletId = "aw_" + "44".repeat(16);
    const args = { proposalId: "prop_" + "ab".repeat(12) };
    const snap = policySnapshotId(DEFAULT_POLICY(10, 100));

    const first = await resolveConfirm({
      tool,
      message: "Execute?",
      args,
      ctx: modernCtx(),
      walletId,
      policySnapshotId: snap,
    });
    if (first.confirmed) throw new Error("expected challenge");

    const second = await resolveConfirm({
      tool,
      message: "Execute?",
      args,
      ctx: modernCtx({
        inputResponses: acceptConfirmResponses(true),
        requestState: first.inputRequired.requestState,
      }),
      walletId,
      policySnapshotId: snap,
    });
    expect(second.confirmed).toBe(true);
    if (second.confirmed) expect(second.via).toBe("mrtr");
  });

  it("requireConfirmOrInput returns InputRequiredResult for MRTR first round", async () => {
    const out = await requireConfirmOrInput({
      tool: "create_agent_wallet",
      message: "Create wallet?",
      args: {},
      ctx: modernCtx(),
    });
    expect(out).not.toBe(true);
    expect(isInputRequiredResult(out)).toBe(true);
    const ir = out as InputRequiredResult;
    expect(ir.resultType).toBe("input_required");
  });

  it("requireConfirmOrInput returns true when confirm=true", async () => {
    const out = await requireConfirmOrInput({
      tool: "revoke",
      message: "Revoke?",
      args: { confirm: true, walletId: "aw_" + "22".repeat(16) },
    });
    expect(out).toBe(true);
  });

  it("clientSupportsMrtr detects modern protocol and resume fields", () => {
    expect(clientSupportsMrtr(undefined)).toBe(false);
    expect(clientSupportsMrtr({ client: {}, mcpCtx: undefined })).toBe(false);
    expect(clientSupportsMrtr(modernCtx())).toBe(true);
    expect(
      clientSupportsMrtr({
        client: {},
        mcpCtx: { mcpReq: { inputResponses: {} } },
      }),
    ).toBe(true);
  });
});

describe("requestState security invariants", () => {
  it("minted requestState is integrity-protected (MAC rejects mutation)", async () => {
    process.env.AGENT_WALLET_MRTR_SECRET = "s".repeat(32);
    resetConfirmCodecForTests();
    const codec = getConfirmStateCodec();
    const payload: ConfirmRequestState = {
      tool: "create_agent_wallet",
      step: "awaiting-confirm",
      intentHash: sha256Hex("intent"),
      policySnapshotId: "none",
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const wire = await codec.mint(payload);
    expect(wire.startsWith("v1.")).toBe(true);
    // Flip a character in the body segment
    const parts = wire.split(".");
    expect(parts.length).toBe(3);
    const mutated =
      parts[0] +
      "." +
      parts[1]!.slice(0, -1) +
      (parts[1]!.endsWith("A") ? "B" : "A") +
      "." +
      parts[2];
    await expect(codec.verify(mutated, {} as never)).rejects.toThrow();
  });

  it("stripSecrets on InputRequiredResult still leaves no private keys", async () => {
    const r = await resolveConfirm({
      tool: "create_agent_wallet",
      message: "Create?",
      args: {},
      ctx: modernCtx(),
    });
    if (r.confirmed) throw new Error("expected ir");
    const scrubbed = stripSecrets(r.inputRequired);
    const text = JSON.stringify(scrubbed);
    expect(text).not.toMatch(PRIVATE_KEY_HEX_RE);
    expect(text.toLowerCase()).not.toContain("privatekey");
  });
});

const FAKE_TX_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const snapshotTempDirs: string[] = [];

type CapturedToolHandler = (
  args?: Record<string, unknown>,
  mcpCtx?: unknown,
) => Promise<unknown>;

function snapshotTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "aw-snap-"));
  snapshotTempDirs.push(dir);
  return {
    rpcUrl: "https://rpc.pulsechain.com",
    rpcUrls: ["https://rpc.pulsechain.com"],
    network: "mainnet",
    explorerApi: "https://api.scan.pulsechain.com/api",
    pulseXSubgraphV1: "https://example.com/v1",
    pulseXSubgraphV2: "https://example.com/v2",
    agentWalletEnabled: true,
    agentWalletMasterKey: randomBytes(32).toString("hex"),
    agentWalletDir: dir,
    agentWalletMultiprocStrict: false,
    maxPlsPerTx: 10,
    maxPlsDaily: 100,
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

function captureWalletHandlers(
  cfg: AppConfig,
): Map<string, CapturedToolHandler> {
  const handlers = new Map<string, CapturedToolHandler>();
  const server = {
    registerTool: (name: string, ...rest: unknown[]) => {
      const cb = rest[rest.length - 1];
      if (typeof cb === "function") {
        handlers.set(name, cb as CapturedToolHandler);
      }
    },
  };
  resetToolRegistry();
  registerWalletTools(server as never, cfg);
  return handlers;
}

function mrtrMcpCtx(overrides?: {
  inputResponses?: Record<string, unknown>;
  requestState?: string;
}) {
  return {
    mcpReq: {
      envelope: {},
      inputResponses: overrides?.inputResponses,
      requestState: overrides?.requestState,
    },
  };
}

function expectInputRequired(value: unknown): InputRequiredResult {
  expect(isInputRequiredResult(value)).toBe(true);
  return value as InputRequiredResult;
}

function toolErrorText(value: unknown): string {
  const res = value as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  expect(res.isError).toBe(true);
  return res.content?.[0]?.text ?? JSON.stringify(value);
}

describe("execute/settle/sign_and_send bind real policySnapshotId", () => {
  afterEach(() => {
    setTestBroadcast(null);
    resetWalletLocksForTests();
    resetWalletDirOwnershipForTests();
    resetToolRegistry();
    vi.restoreAllMocks();
    while (snapshotTempDirs.length) {
      const d = snapshotTempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  async function pendingProposal(cfg: AppConfig) {
    mockRpcEoa();
    const wallet = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: wallet.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });
    return { wallet, proposal };
  }

  it("create_agent_wallet still mints policySnapshotId none", async () => {
    const cfg = snapshotTestConfig();
    const handlers = captureWalletHandlers(cfg);
    const first = expectInputRequired(
      await handlers.get("create_agent_wallet")!({}, mrtrMcpCtx()),
    );
    const decoded = await getConfirmStateCodec().verify(
      first.requestState!,
      {} as never,
    );
    expect(decoded.tool).toBe("create_agent_wallet");
    expect(decoded.policySnapshotId).toBe("none");
    expect(decoded.walletId).toBeUndefined();
  });

  it("execute_agent_tx MRTR challenge seals the current wallet policy snapshot", async () => {
    const cfg = snapshotTestConfig();
    const { wallet, proposal } = await pendingProposal(cfg);
    const snap = policySnapshotId(
      loadWalletRecord(cfg.agentWalletDir, wallet.id).policy,
    );
    expect(snap).not.toBe("none");

    const handlers = captureWalletHandlers(cfg);
    const first = expectInputRequired(
      await handlers.get("execute_agent_tx")!(
        { proposalId: proposal.id },
        mrtrMcpCtx(),
      ),
    );
    const decoded = await getConfirmStateCodec().verify(
      first.requestState!,
      {} as never,
    );
    expect(decoded.tool).toBe("execute_agent_tx");
    expect(decoded.walletId).toBe(wallet.id);
    expect(decoded.policySnapshotId).toBe(snap);
  });

  it("execute_agent_tx MRTR resume re-challenges when policy snapshot changed after mint", async () => {
    const cfg = snapshotTestConfig();
    const { wallet, proposal } = await pendingProposal(cfg);
    const snapBefore = policySnapshotId(
      loadWalletRecord(cfg.agentWalletDir, wallet.id).policy,
    );
    const handlers = captureWalletHandlers(cfg);

    const first = expectInputRequired(
      await handlers.get("execute_agent_tx")!(
        { proposalId: proposal.id },
        mrtrMcpCtx(),
      ),
    );

    const killed = await killSwitch(cfg, wallet.id);
    const snapAfter = policySnapshotId(killed.policy);
    expect(snapAfter).not.toBe(snapBefore);

    const second = expectInputRequired(
      await handlers.get("execute_agent_tx")!(
        { proposalId: proposal.id },
        mrtrMcpCtx({
          inputResponses: acceptConfirmResponses(true),
          requestState: first.requestState,
        }),
      ),
    );
    const reDecoded = await getConfirmStateCodec().verify(
      second.requestState!,
      {} as never,
    );
    expect(reDecoded.policySnapshotId).toBe(snapAfter);
    expect(reDecoded.tool).toBe("execute_agent_tx");
  });

  it("execute_agent_tx MRTR resume proceeds when policy snapshot is unchanged", async () => {
    const cfg = snapshotTestConfig();
    const { proposal } = await pendingProposal(cfg);
    const handlers = captureWalletHandlers(cfg);
    setTestBroadcast(async () => FAKE_TX_HASH);

    const first = expectInputRequired(
      await handlers.get("execute_agent_tx")!(
        { proposalId: proposal.id },
        mrtrMcpCtx(),
      ),
    );

    const second = await handlers.get("execute_agent_tx")!(
      { proposalId: proposal.id },
      mrtrMcpCtx({
        inputResponses: acceptConfirmResponses(true),
        requestState: first.requestState,
      }),
    );
    expect(isInputRequiredResult(second)).toBe(false);
    const res = second as {
      isError?: boolean;
      structuredContent?: { ok?: boolean; data?: { txHash?: string } };
    };
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.data?.txHash).toBe(FAKE_TX_HASH);
  });

  it("settle_interrupted_broadcast MRTR resume re-challenges when policy snapshot changed after mint", async () => {
    const cfg = snapshotTestConfig();
    const { wallet, proposal } = await pendingProposal(cfg);
    persistBroadcastBarrier(
      cfg.agentWalletDir,
      proposal,
      FAKE_TX_HASH,
    );
    const snapBefore = policySnapshotId(
      loadWalletRecord(cfg.agentWalletDir, wallet.id).policy,
    );
    const handlers = captureWalletHandlers(cfg);

    const first = expectInputRequired(
      await handlers.get("settle_interrupted_broadcast")!(
        { proposalId: proposal.id },
        mrtrMcpCtx(),
      ),
    );
    const minted = await getConfirmStateCodec().verify(
      first.requestState!,
      {} as never,
    );
    expect(minted.policySnapshotId).toBe(snapBefore);

    const updated = await setAgentPolicy(cfg, wallet.id, { maxPlsPerTx: 1 });
    const snapAfter = policySnapshotId(updated.policy);
    expect(snapAfter).not.toBe(snapBefore);

    const second = expectInputRequired(
      await handlers.get("settle_interrupted_broadcast")!(
        { proposalId: proposal.id },
        mrtrMcpCtx({
          inputResponses: acceptConfirmResponses(true),
          requestState: first.requestState,
        }),
      ),
    );
    const reDecoded = await getConfirmStateCodec().verify(
      second.requestState!,
      {} as never,
    );
    expect(reDecoded.policySnapshotId).toBe(snapAfter);
    expect(reDecoded.tool).toBe("settle_interrupted_broadcast");
  });

  it("settle_interrupted_broadcast MRTR resume proceeds when policy snapshot is unchanged", async () => {
    const cfg = snapshotTestConfig();
    const { proposal } = await pendingProposal(cfg);
    persistBroadcastBarrier(cfg.agentWalletDir, proposal, FAKE_TX_HASH);
    const handlers = captureWalletHandlers(cfg);

    const first = expectInputRequired(
      await handlers.get("settle_interrupted_broadcast")!(
        { proposalId: proposal.id },
        mrtrMcpCtx(),
      ),
    );

    const second = await handlers.get("settle_interrupted_broadcast")!(
      { proposalId: proposal.id },
      mrtrMcpCtx({
        inputResponses: acceptConfirmResponses(true),
        requestState: first.requestState,
      }),
    );
    expect(isInputRequiredResult(second)).toBe(false);
    const res = second as {
      isError?: boolean;
      structuredContent?: { ok?: boolean; data?: { status?: string } };
    };
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.data?.status).toBe("executed");
  });

  it("sign_and_send MRTR challenge seals the current wallet policy snapshot", async () => {
    const cfg = snapshotTestConfig();
    const { wallet, proposal } = await pendingProposal(cfg);
    const handlers = captureWalletHandlers(cfg);
    const first = expectInputRequired(
      await handlers.get("sign_and_send")!(
        { proposalId: proposal.id },
        mrtrMcpCtx(),
      ),
    );
    const decoded = await getConfirmStateCodec().verify(
      first.requestState!,
      {} as never,
    );
    expect(decoded.tool).toBe("sign_and_send");
    expect(decoded.policySnapshotId).toBe(
      policySnapshotId(loadWalletRecord(cfg.agentWalletDir, wallet.id).policy),
    );
  });

  it("execute_agent_tx fails closed when the wallet record cannot be loaded", async () => {
    const cfg = snapshotTestConfig();
    const { wallet, proposal } = await pendingProposal(cfg);
    unlinkSync(join(cfg.agentWalletDir, `${wallet.id}.json`));
    const handlers = captureWalletHandlers(cfg);

    const first = await handlers.get("execute_agent_tx")!(
      { proposalId: proposal.id },
      mrtrMcpCtx(),
    );
    expect(isInputRequiredResult(first)).toBe(false);
    const text = toolErrorText(first);
    expect(text).toMatch(/policy snapshot|Wallet not found/i);
    expect(text).not.toMatch(/"policySnapshotId":\s*"none"/);
  });
});

describe("MRTR secret: stdio fallback vs HTTP wallets-on require", () => {
  const TEST_MASTER_KEY = "a".repeat(64);
  const TEST_MRTR = "s".repeat(32);

  it("getMrtrHmacSecret falls back to a process-local secret when env is unset", () => {
    delete process.env.AGENT_WALLET_MRTR_SECRET;
    resetMrtrSecretForTests();
    const a = getMrtrHmacSecret();
    const b = getMrtrHmacSecret();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toBe(b);
  });

  it("wallets + HTTP without MRTR secret fail closed at loadConfig", () => {
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        HTTP_TRANSPORT_PORT: "8787",
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        HTTP_TRANSPORT_PORT: "8787",
      }),
    ).toThrow(/AGENT_WALLET_MRTR_SECRET/);
  });

  it("wallets + HTTP with MRTR ≥32 bytes load; stdio wallets-on without MRTR load", () => {
    const http = loadConfig({
      AGENT_WALLET_ENABLED: "true",
      AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
      HTTP_TRANSPORT_PORT: "8787",
      AGENT_WALLET_MRTR_SECRET: TEST_MRTR,
    });
    expect(http.httpTransportPort).toBe(8787);
    const stdio = loadConfig({
      AGENT_WALLET_ENABLED: "true",
      AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
    });
    expect(stdio.httpTransportPort).toBeUndefined();
    const researchHttp = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      HTTP_TRANSPORT_PORT: "8787",
    });
    expect(researchHttp.httpTransportPort).toBe(8787);
  });
});
