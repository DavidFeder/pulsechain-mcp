import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chainForConfig, chainIdForConfig } from "../src/data/rpc.js";
import { SWAPS_BY_PAIRS_QUERY } from "../src/data/subgraph.js";
import { PolicyError } from "../src/utils/errors.js";
import { applyLabAutoloadIfEnabled } from "../src/labAutoload.js";
import {
  earliestTxTimestamp,
  isPositiveWeiString,
} from "../src/tools/analytics/advanced-helpers.js";
import { resolveConfirm } from "../src/utils/confirm.js";
import {
  formatConfirmPrompt,
  omittedMovementCount,
  type TxReviewSummary,
} from "../src/wallet/reviewSummary.js";
import { loadProposal, saveProposal } from "../src/wallet/store.js";
import type { TokenNotionalPolicyView, TxProposal } from "../src/wallet/types.js";

const PROP_A = "prop_aaaaaaaaaaaaaaaaaaaaaaaa";
const PROP_B = "prop_bbbbbbbbbbbbbbbbbbbbbbbb";

function pendingProposal(id: string): TxProposal {
  return {
    id,
    walletId: "aw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    valueWei: "1",
    valuePls: 1e-18,
    data: "0x",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    simulation: { attempted: true, ok: true },
    policyCheck: {
      allowed: true,
      reasons: [],
      isContractInteraction: false,
      destinationIsContract: false,
      valuePls: 1e-18,
      projectedDailySpend: 0,
      remainingDaily: 1,
      allowlistExpired: false,
      legacyCapsDisplayOnly: true,
    },
    status: "pending",
  };
}

describe("review hardening", () => {
  it("chainForConfig matches RPC endpoint family", () => {
    expect(chainForConfig({ network: "mainnet" }).id).toBe(369);
    expect(chainForConfig({ network: "testnet" }).id).toBe(943);
    expect(chainIdForConfig({ network: "mainnet" })).toBe(369);
    expect(chainIdForConfig({ network: "testnet" })).toBe(943);
  });

  it("loadProposal rejects filename vs embedded id mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcm-prop-"));
    await mkdir(join(dir, "proposals"), { recursive: true });
    await writeFile(
      join(dir, "proposals", `${PROP_A}.json`),
      JSON.stringify({ ...pendingProposal(PROP_B), id: PROP_B }),
      "utf8",
    );
    expect(() => loadProposal(dir, PROP_A)).toThrow(/mismatch/i);
  });

  it("saveProposal writes 0700 dirs and 0600 files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcm-store-"));
    saveProposal(dir, pendingProposal(PROP_A));
    const proposalsStat = await stat(join(dir, "proposals"));
    const fileStat = await stat(join(dir, "proposals", `${PROP_A}.json`));
    expect(proposalsStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("lab autoload does not overwrite set env vars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcm-lab-"));
    await mkdir(join(dir, "data", "wallets"), { recursive: true });
    await writeFile(
      join(dir, "data", "wallets", ".enable-wallet-autoload"),
      "",
      "utf8",
    );
    await writeFile(
      join(dir, ".env.wallet"),
      "PULSECHAIN_NETWORK=should-not-win\n",
      "utf8",
    );

    const keys = [
      "PULSECHAIN_NETWORK",
      "PULSECHAIN_WALLET_LAUNCHER",
      "PULSECHAIN_LAB_LAUNCHER",
      "AGENT_WALLET_ENABLED",
      "AGENT_WALLET_DIR",
      "AGENT_WALLET_MULTIPROC_STRICT",
    ] as const;
    const prev: Record<string, string | undefined> = {};
    for (const k of keys) prev[k] = process.env[k];

    delete process.env.PULSECHAIN_WALLET_LAUNCHER;
    delete process.env.PULSECHAIN_LAB_LAUNCHER;
    process.env.PULSECHAIN_NETWORK = "already-set";
    try {
      const result = applyLabAutoloadIfEnabled(dir);
      expect(result.applied).toBe(true);
      expect(process.env.PULSECHAIN_NETWORK).toBe("already-set");
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });

  it("earliestTxTimestamp ignores empty lists and non-positive wei", () => {
    expect(earliestTxTimestamp([])).toBeUndefined();
    expect(earliestTxTimestamp([{ timestamp: "9" }])).toBe(9);
    expect(isPositiveWeiString("0")).toBe(false);
    expect(isPositiveWeiString("1")).toBe(true);
  });

  it("confirm prompt reports omitted movements", () => {
    const tn = {
      movements: Array.from({ length: 16 }, () => ({
        token: "0x3333333333333333333333333333333333333333",
        amountRaw: "1",
        role: "out",
      })),
    } as TokenNotionalPolicyView;
    expect(omittedMovementCount(tn)).toBe(4);

    const summary = {
      headline: "Send",
      decision: "allow",
      destination: "0x2222222222222222222222222222222222222222",
      destinationKind: "eoa",
      nativeValuePls: 0,
      nativeValueWei: "0",
      tokenMovements: [
        {
          token: "0x3333333333333333333333333333333333333333",
          role: "out",
          amountRaw: "1",
        },
      ],
      omittedMovementCount: 4,
      movementExplanations: [],
      decodeKnowledge: { status: "empty", pattern: "native" },
      agentGuidance: "proceed_with_confirm",
    } as unknown as TxReviewSummary;
    expect(formatConfirmPrompt(summary)).toMatch(/4 more not shown/);
  });

  it("SWAPS_BY_PAIRS_QUERY includes skip pagination", () => {
    expect(SWAPS_BY_PAIRS_QUERY).toMatch(/\$skip:\s*Int/);
    expect(SWAPS_BY_PAIRS_QUERY).toMatch(/skip:\s*\$skip/);
  });

  it("resolveConfirm treats confirm=false as a decline", async () => {
    await expect(
      resolveConfirm({
        tool: "transfer_pls",
        message: "confirm",
        args: { confirm: false },
      }),
    ).rejects.toBeInstanceOf(PolicyError);
  });
});
