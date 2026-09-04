/**
 * Caps / allowlists / leftover env knobs are not send gates.
 * Only kill switch, enabled=false, and invalid address/value block.
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress } from "viem";
import {
  assertPolicyAllows,
  evaluatePolicy,
  normalizePolicy,
} from "../src/wallet/policy.js";
import { DEFAULT_POLICY } from "../src/wallet/types.js";
import { PolicyError } from "../src/utils/errors.js";
import { DAI_ADDRESS } from "../src/constants.js";
import { loadConfig } from "../src/config.js";

const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const TOKEN = getAddress(DAI_ADDRESS.toLowerCase());

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

describe("evaluatePolicy: funding authorizes; leftover fields ignored", () => {
  const base = DEFAULT_POLICY();

  it("large native value is allowed", () => {
    const check = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 50_000,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
    expect(check.legacyCapsDisplayOnly).toBeUndefined();
    expect(check.remainingDaily).toBeUndefined();
    expect(() => assertPolicyAllows(check)).not.toThrow();
  });

  it("on-disk cap/allowlist fields are ignored by normalizePolicy", () => {
    const policy = normalizePolicy({
      enabled: true,
      killed: false,
    });
    expect(policy).toEqual({ enabled: true, killed: false });
    const check = evaluatePolicy({
      policy,
      dailySpend: daySpend(0),
      to: TOKEN,
      valuePls: 100,
      data: encodeFunctionData({
        abi: erc20TransferAbi,
        functionName: "transfer",
        args: [RECIPIENT, 10n ** 18n],
      }),
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
    expect(check.tokenNotional?.notes.join(" ")).toMatch(/authorization|decode/i);
  });

  it("kill switch and disabled still deny", () => {
    const killed = evaluatePolicy({
      policy: { enabled: false, killed: true },
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
    });
    expect(killed.allowed).toBe(false);
    expect(killed.reasons.join(" ")).toMatch(/kill/i);
    expect(() => assertPolicyAllows(killed)).toThrow(PolicyError);

    const disabled = evaluatePolicy({
      policy: { enabled: false, killed: false },
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
    });
    expect(disabled.allowed).toBe(false);
    expect(disabled.reasons.join(" ")).toMatch(/enabled=false/i);
  });

  it("invalid address / value deny", () => {
    const badAddr = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: "not-an-address",
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
    });
    expect(badAddr.allowed).toBe(false);
    expect(badAddr.reasons.join(" ")).toMatch(/Invalid to address/i);

    const badVal = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: "1e18",
      data: "0x",
      destinationIsContract: false,
    });
    expect(badVal.allowed).toBe(false);
  });
});

describe("leftover MAX_PLS / ENFORCE_LEGACY env is ignored", () => {
  it("loadConfig does not parse MAX_PLS_* or ENFORCE_LEGACY into AppConfig", () => {
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      MAX_PLS_PER_TX: "50",
      MAX_PLS_DAILY: "200",
      AGENT_WALLET_ENFORCE_LEGACY_CAPS: "true",
    });
    expect(cfg).not.toHaveProperty("maxPlsPerTx");
    expect(cfg).not.toHaveProperty("maxPlsDaily");
    expect(cfg).not.toHaveProperty("agentWalletEnforceLegacyCaps");
  });
});
