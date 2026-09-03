/**
 * Opt-in AGENT_WALLET_ENFORCE_LEGACY_CAPS: stored legacy fields become hard denies.
 * Flag off is covered by the existing operator-trust suite (allowed=true).
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress } from "viem";
import {
  assertPolicyAllows,
  evaluatePolicy,
} from "../src/wallet/policy.js";
import { DEFAULT_POLICY } from "../src/wallet/types.js";
import { PolicyError } from "../src/utils/errors.js";
import { DAI_ADDRESS, WPLS_ADDRESS } from "../src/constants.js";
import { buildTxReviewSummary } from "../src/wallet/reviewSummary.js";
import { buildOperatorAtAGlance } from "../src/wallet/service.js";
import type { WalletDirOwnershipStatusView } from "../src/wallet/owner.js";

const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const TOKEN = getAddress(DAI_ADDRESS.toLowerCase());
const WPLS = getAddress(WPLS_ADDRESS.toLowerCase());

const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function daySpend(spentPls: number) {
  return {
    date: new Date().toISOString().slice(0, 10),
    spentPls,
  };
}

const ownershipOk = {
  status: "ok",
  multiProcessRisk: false,
  writesBlockedByMultiproc: false,
  riskLevel: "none",
  multiprocMode: "warn-only",
  multiprocStrict: false,
  thisProcessPid: 1,
  recommendedAction: "ok",
  recommendedModel: "one process → one unique AGENT_WALLET_DIR",
  locksAreProcessLocalOnly: true,
  notADistributedLock: true,
  posture: "ok",
} as WalletDirOwnershipStatusView;

describe("evaluatePolicy enforceLegacyCaps (opt-in hard denies)", () => {
  const base = DEFAULT_POLICY(10, 100);

  it("flag off: over maxPlsPerTx still allowed and display-only", () => {
    const check = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 50,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
    expect(check.legacyCapsDisplayOnly).toBe(true);
    expect(() => assertPolicyAllows(check)).not.toThrow();
  });

  it("maxPlsPerTx over-cap denies and assertPolicyAllows throws", () => {
    const check = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 50,
      data: "0x",
      destinationIsContract: false,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.legacyCapsDisplayOnly).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/maxPlsPerTx/i);
    expect(() => assertPolicyAllows(check)).toThrow(PolicyError);
    expect(() => assertPolicyAllows(check)).toThrow(/maxPlsPerTx/i);
  });

  it("maxPlsDaily projected over-cap denies (same wei math as remainingDaily)", () => {
    const check = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(95),
      to: RECIPIENT,
      valuePls: 10,
      data: "0x",
      destinationIsContract: false,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.projectedDailySpend).toBe(105);
    expect(check.remainingDaily).toBe(0);
    expect(check.reasons.join(" ")).toMatch(/maxPlsDaily|projected daily spend/i);
  });

  it("exact maxPlsPerTx / maxPlsDaily still allowed", () => {
    const check = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(90),
      to: RECIPIENT,
      valuePls: 10,
      data: "0x",
      destinationIsContract: false,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(true);
    expect(check.reasons).toEqual([]);
  });

  it("empty contractAllowlist denies contract interaction", () => {
    const check = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: WPLS,
      valuePls: 0,
      data: "0xa9059cbb",
      destinationIsContract: true,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/contractAllowlist/i);
  });

  it("destination not on contractAllowlist denies", () => {
    const check = evaluatePolicy({
      policy: { ...base, contractAllowlist: [TOKEN] },
      dailySpend: daySpend(0),
      to: WPLS,
      valuePls: 0,
      data: "0xd0e30db0",
      destinationIsContract: true,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/not on contractAllowlist/i);
  });

  it("tokenAllowlist destination filter denies off-list dest", () => {
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS, TOKEN],
        tokenAllowlist: [TOKEN],
      },
      dailySpend: daySpend(0),
      to: WPLS,
      valuePls: 0,
      data: "0x095ea7b3",
      destinationIsContract: true,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/tokenAllowlist/i);
  });

  it("expired allowlist denies contract dest that was on the stored list", () => {
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS],
        allowlistExpiresAt: "2020-01-01T00:00:00.000Z",
      },
      dailySpend: daySpend(0),
      to: WPLS,
      valuePls: 0,
      data: "0xd0e30db0",
      destinationIsContract: true,
      now: new Date("2026-07-26T12:00:00.000Z"),
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.allowlistExpired).toBe(true);
    expect(check.reasons.join(" ")).toMatch(/allowlist expired|contractAllowlist/i);
  });

  it("tokenSpendCaps over-cap denies native value to that dest", () => {
    const dest = WPLS.toLowerCase();
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS],
        tokenSpendCaps: { [dest]: 2 },
      },
      dailySpend: daySpend(0),
      to: WPLS,
      valuePls: 5,
      data: "0x",
      destinationIsContract: true,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/tokenSpendCaps/i);
  });

  it("tokenDailyCaps over-cap denies using dest daily ledger", () => {
    const dest = WPLS.toLowerCase();
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS],
        tokenDailyCaps: { [dest]: 3 },
      },
      dailySpend: daySpend(0),
      tokenDailySpend: {
        [dest]: { date: new Date().toISOString().slice(0, 10), spentPls: 2 },
      },
      to: WPLS,
      valuePls: 2,
      data: "0x",
      destinationIsContract: true,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/tokenDailyCaps/i);
  });

  it("allowNativeTransfers=false denies native EOA transfer", () => {
    const check = evaluatePolicy({
      policy: { ...base, allowNativeTransfers: false },
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.reasons.join(" ")).toMatch(
      /Native PLS transfers are disabled/i,
    );
  });

  it("erc20NotionalCaps denies when inspection is reliable and over cap", () => {
    const data = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, 5000n],
    });
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [TOKEN],
        erc20NotionalCaps: { [TOKEN.toLowerCase()]: "1000" },
      },
      dailySpend: daySpend(0),
      to: TOKEN,
      valuePls: 0,
      data,
      destinationIsContract: true,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.tokenNotional?.reliable).toBe(true);
    expect(check.reasons.join(" ")).toMatch(/erc20NotionalCaps/i);
    expect(check.tokenNotional?.capsApplied.some((c) => !c.withinCap)).toBe(
      true,
    );
    expect(() => assertPolicyAllows(check)).toThrow(PolicyError);
  });

  it("erc20NotionalCaps under cap still allowed when reliable", () => {
    const data = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, 100n],
    });
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [TOKEN],
        erc20NotionalCaps: { [TOKEN.toLowerCase()]: "1000" },
      },
      dailySpend: daySpend(0),
      to: TOKEN,
      valuePls: 0,
      data,
      destinationIsContract: true,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(true);
    expect(check.tokenNotional?.capsApplied[0]?.withinCap).toBe(true);
  });

  it("unreliable decode does not invent erc20NotionalCaps deny", () => {
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [TOKEN],
        erc20NotionalCaps: { [TOKEN.toLowerCase()]: "1" },
      },
      dailySpend: daySpend(0),
      to: TOKEN,
      valuePls: 0,
      data: "0xa9059cbb",
      destinationIsContract: true,
      enforceLegacyCaps: true,
    });
    expect(check.tokenNotional?.reliable).toBe(false);
    expect(check.reasons.join(" ")).not.toMatch(/erc20NotionalCaps/i);
    expect(check.tokenNotional?.capsApplied).toEqual([]);
  });

  it("requireDecodableCalldata denies unreliable/unknown calldata", () => {
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS],
        requireDecodableCalldata: true,
      },
      dailySpend: daySpend(0),
      to: WPLS,
      valuePls: 1,
      data: "0x12345678",
      destinationIsContract: true,
      enforceLegacyCaps: true,
    });
    expect(check.allowed).toBe(false);
    expect(check.tokenNotional?.pattern).toBe("unknown");
    expect(check.tokenNotional?.requireDecodableCalldata).toBe(true);
    expect(check.reasons.join(" ")).toMatch(/requireDecodableCalldata/i);
  });

  it("kill / enabled=false / invalid to still hard-deny in both modes", () => {
    const killed = evaluatePolicy({
      policy: { ...base, killed: true, enabled: false },
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
      enforceLegacyCaps: true,
    });
    expect(killed.allowed).toBe(false);
    expect(killed.reasons.join(" ")).toMatch(/kill/i);

    const badTo = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: "not-an-address",
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
      enforceLegacyCaps: false,
    });
    expect(badTo.allowed).toBe(false);
    expect(badTo.reasons.join(" ")).toMatch(/Invalid to/i);
  });

  it("review + status copy say enforcing vs display-only", () => {
    const denied = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 50,
      data: "0x",
      destinationIsContract: false,
      enforceLegacyCaps: true,
    });
    const summary = buildTxReviewSummary({
      to: RECIPIENT,
      valuePls: denied.valuePls,
      valueWei: denied.valueWei,
      data: "0x",
      policyCheck: denied,
      context: "check",
    });
    expect(summary.legacyCapsDisplayOnly).toBe(false);
    expect(summary.remainingDailyIsDisplayOnly).toBe(false);
    expect(summary.legacyCapsNote).toMatch(/AGENT_WALLET_ENFORCE_LEGACY_CAPS/i);
    expect(summary.checksApplied.join(" ")).toMatch(/legacy_caps_enforced/i);
    expect(summary.policyBackstop).toMatch(/opted into|opt-in/i);
    expect(summary.policyBackstop).toMatch(/product default remains operator-trust/i);

    const glance = buildOperatorAtAGlance({
      enabled: true,
      masterKeyConfigured: true,
      maxPlsPerTx: 10,
      maxPlsDaily: 100,
      walletCount: 1,
      killedWalletCount: 0,
      ownership: ownershipOk,
      enforceLegacyCaps: true,
    });
    expect(glance.legacyCapsMode).toBe("enforcing");
    expect(glance.legacyCapsEnforced).toBe(true);
    expect(glance.defaultCapsDisplayOnly).toBe(false);
    expect(glance.policyPosture).toBe("operator_trust");
    expect(glance.policyPostureNote).toMatch(/AGENT_WALLET_ENFORCE_LEGACY_CAPS/i);
    expect(glance.policyPostureNote).toMatch(
      /not a custody-policy product default/i,
    );
    expect(glance.bullets.join(" ")).toMatch(/ENFORCING/i);

    const display = buildOperatorAtAGlance({
      enabled: true,
      masterKeyConfigured: true,
      maxPlsPerTx: 10,
      maxPlsDaily: 100,
      walletCount: 1,
      killedWalletCount: 0,
      ownership: ownershipOk,
      enforceLegacyCaps: false,
    });
    expect(display.legacyCapsMode).toBe("display-only");
    expect(display.defaultCapsDisplayOnly).toBe(true);
    expect(display.bullets.join(" ")).toMatch(/display-only/i);
  });

});
