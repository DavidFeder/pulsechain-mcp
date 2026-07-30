/**
 * Unit tests for dual-protocol wallet confirm (confirm=true + MRTR InputRequiredResult).
 * Mocks round-trips; no live RPC / no real private key material in assertions.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  isInputRequiredResult,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import {
  clientSupportsMrtr,
  computeIntentHash,
  getConfirmStateCodec,
  policySnapshotId,
  requireConfirmOrInput,
  resetConfirmCodecForTests,
  resetMrtrSecretForTests,
  resolveConfirm,
  sha256Hex,
  stableStringify,
  type ConfirmHandlerContext,
  type ConfirmRequestState,
} from "../src/utils/confirm.js";
import { PolicyError } from "../src/utils/errors.js";
import { stripSecrets } from "../src/utils/safety.js";
import { isInputRequiredResult as defineGuard } from "@modelcontextprotocol/server";
import { DEFAULT_POLICY } from "../src/wallet/types.js";

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
    ).rejects.toThrow(/confirm=true/);
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
