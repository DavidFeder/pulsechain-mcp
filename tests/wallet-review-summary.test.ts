/**
 * v0.1.15: reviewSummary + decision traces on propose / check / deny paths.
 * Drives shipped buildTxReviewSummary, evaluatePolicy, and proposeAgentTx.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTxReviewSummary,
  categorizeDenyReason,
  formatConfirmPrompt,
  POLICY_BACKSTOP_NOTE,
  SAFE_USAGE_PATTERN,
} from "../src/wallet/reviewSummary.js";
import { evaluatePolicy } from "../src/wallet/policy.js";
import {
  createAgentWallet,
  proposeAgentTx,
  setTestBroadcast,
} from "../src/wallet/service.js";
import type { AppConfig } from "../src/types.js";
import * as rpc from "../src/data/rpc.js";
import { encodeFunctionData, parseEther } from "viem";

const tempDirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-rev-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  setTestBroadcast(null);
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

describe("categorizeDenyReason / buildTxReviewSummary (pure shipped)", () => {
  it("categorizes common deny reasons", () => {
    expect(
      categorizeDenyReason(
        "valueWei 1 exceeds maxPlsPerTx 0.5",
      ).category,
    ).toBe("max_pls_per_tx");
    expect(
      categorizeDenyReason(
        "Wallet kill switch is active (killed=true).",
      ).category,
    ).toBe("kill_switch");
    expect(
      categorizeDenyReason(
        "Contract interaction denied: contractAllowlist is empty",
      ).category,
    ).toBe("contract_allowlist");
    expect(
      categorizeDenyReason(
        "Token notional 99 raw exceeds erc20NotionalCaps[0xab]=1",
      ).category,
    ).toBe("erc20_notional_cap");
  });

  it("builds allow summary for native EOA transfer from real evaluatePolicy", () => {
    const check = evaluatePolicy({
      policy: {
        enabled: true,
        killed: false,
        maxPlsPerTx: 10,
        maxPlsDaily: 100,
        contractAllowlist: [],
        tokenAllowlist: [],
        allowlistExpiresAt: null,
        tokenSpendCaps: {},
        tokenDailyCaps: {},
        erc20NotionalCaps: {},
        requireDecodableCalldata: false,
        allowNativeTransfers: true,
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      tokenDailySpend: {},
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);

    const summary = buildTxReviewSummary({
      to: "0x0000000000000000000000000000000000000001",
      valuePls: check.valuePls,
      valueWei: check.valueWei,
      data: "0x",
      policyCheck: check,
      context: "propose",
    });

    expect(summary.decision).toBe("allow");
    expect(summary.headline).toMatch(/ALLOWED/i);
    expect(summary.destination).toMatch(/^0x0{39}1$/);
    expect(summary.nativeValuePls).toBe(1);
    expect(summary.nativeValueWei).toBe(parseEther("1").toString());
    expect(summary.destinationKind).toBe("eoa");
    expect(summary.checksApplied).toEqual(
      expect.arrayContaining([
        "kill_switch",
        "enabled",
        "operator_trust (caps/allowlists not hard gates)",
      ]),
    );
    expect(summary.decisionTrace).toEqual([]);
    expect(summary.confirmRequiredForBroadcast).toBe(true);
    expect(summary.confirmRationale).toMatch(/confirm|host UX|Operator-trust/i);
    expect(summary.confirmRationale).toMatch(
      /no hard spend-cap|operator-trust|funding/i,
    );
    expect(summary.policyBackstop).toMatch(/Operator-trust|funding the agent/i);
    expect(summary.nextStep).toMatch(/execute_agent_tx|confirm/i);
    expect(summary.tokenMovements).toEqual([]);
    // PulseChain gas-aware safetyHints (shipped guidance, not fee oracle)
    expect(summary.safetyHints.join(" ")).toMatch(/EIP-1559|BEATS|PulseChain/i);
    expect(summary.safetyHints.join(" ")).toMatch(
      /value transferred|native value|total PLS|gas headroom|Operator-trust/i,
    );
    expect(summary.safetyHints.join(" ")).toMatch(
      /tiny-value|tiny value|substantial PLS for gas/i,
    );
    // No secrets
    const blob = JSON.stringify(summary);
    expect(blob).not.toMatch(/privateKey|masterKey|ciphertext/i);
  });

  it("builds deny summary with decisionTrace from real kill-switch denial", () => {
    const check = evaluatePolicy({
      policy: {
        enabled: false,
        killed: true,
        maxPlsPerTx: 0.5,
        maxPlsDaily: 100,
        contractAllowlist: [],
        tokenAllowlist: [],
        allowlistExpiresAt: null,
        tokenSpendCaps: {},
        tokenDailyCaps: {},
        erc20NotionalCaps: {},
        requireDecodableCalldata: false,
        allowNativeTransfers: true,
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      tokenDailySpend: {},
      to: "0x00000000000000000000000000000000000000aa",
      valuePls: 2,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/kill|disabled/i);

    const summary = buildTxReviewSummary({
      to: "0x00000000000000000000000000000000000000aa",
      valuePls: check.valuePls,
      valueWei: check.valueWei,
      data: "0x",
      policyCheck: check,
      context: "check",
    });

    expect(summary.decision).toBe("deny");
    expect(summary.headline).toMatch(/DENIED/i);
    expect(summary.reasons.length).toBeGreaterThan(0);
    expect(summary.decisionTrace.length).toBeGreaterThan(0);
    expect(summary.decisionTrace[0]!.category).toBe("kill_switch");
    expect(summary.decisionTrace[0]!.message).toMatch(/kill/i);
    expect(summary.nextStep).toMatch(/Do not execute|kill/i);

    const prompt = formatConfirmPrompt(summary);
    expect(prompt).toMatch(/DENIED|Decision: DENY/i);
    expect(prompt).toMatch(/kill|Deny:/i);
  });

  it("surfaces token movements on decoded ERC-20 transfer under operator-trust allow", () => {
    // transfer(address,uint256) selector + args
    const dai = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
    const recipient = "0x0000000000000000000000000000000000000002";
    const data = encodeFunctionData({
      abi: [
        {
          name: "transfer",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ type: "bool" }],
        },
      ],
      functionName: "transfer",
      args: [recipient, 10n ** 18n],
    });

    const check = evaluatePolicy({
      policy: {
        enabled: true,
        killed: false,
        maxPlsPerTx: 100,
        maxPlsDaily: 1000,
        contractAllowlist: [], // legacy empty allowlist — not a hard gate
        tokenAllowlist: [],
        allowlistExpiresAt: null,
        tokenSpendCaps: {},
        tokenDailyCaps: {},
        erc20NotionalCaps: {},
        requireDecodableCalldata: false,
        allowNativeTransfers: true,
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      tokenDailySpend: {},
      to: dai,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);

    const summary = buildTxReviewSummary({
      to: dai,
      valuePls: 0,
      valueWei: "0",
      data,
      policyCheck: check,
      context: "propose",
    });

    expect(summary.decision).toBe("allow");
    expect(summary.isContractInteraction).toBe(true);
    expect(summary.hasCalldata).toBe(true);
    expect(summary.calldataPreview).toMatch(/^0xa9059cbb/i);
    expect(summary.tokenNotional?.pattern).toMatch(/transfer|erc20/i);
    expect(summary.tokenMovements.length).toBeGreaterThan(0);
    expect(summary.checksApplied.join(" ")).toMatch(
      /operator_trust|tokenNotional_advisory/i,
    );
  });

  it("exports operator-trust backstop and safe usage constants", () => {
    expect(POLICY_BACKSTOP_NOTE).toMatch(/Operator-trust|funding the agent/i);
    expect(SAFE_USAGE_PATTERN).toMatch(
      /inspect_tx_intent.*propose_agent_tx.*reviewSummary.*execute_agent_tx/i,
    );
  });
});

describe("proposeAgentTx attaches reviewSummary (shipped service path)", () => {
  it("allowed native propose includes reviewSummary without secrets", async () => {
    mockRpcEoa();
    const cfg = testConfig();
    const w = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 0.25,
      data: "0x",
    });

    expect(proposal.policyCheck.allowed).toBe(true);
    expect(proposal.reviewSummary).toBeDefined();
    expect(proposal.reviewSummary.decision).toBe("allow");
    expect(proposal.reviewSummary.destination).toBe(
      "0x0000000000000000000000000000000000000001",
    );
    expect(proposal.reviewSummary.nativeValueWei).toBe(
      parseEther("0.25").toString(),
    );
    expect(proposal.reviewSummary.headline).toMatch(/ALLOWED/i);
    expect(proposal.reviewSummary.checksApplied.length).toBeGreaterThan(0);
    expect(proposal.reviewSummary.confirmRequiredForBroadcast).toBe(true);
    expect(proposal.reviewSummary.policyBackstop).toMatch(
      /Operator-trust|funding the agent/i,
    );
    expect(proposal.reviewSummary.simulation?.attempted).toBe(true);

    const json = JSON.stringify(proposal);
    expect(json).not.toMatch(/privateKey|ciphertext|masterKey/i);
    expect(json).not.toMatch(/0x[a-fA-F0-9]{64}/); // no private key material
  });

  it("killed wallet propose is denied with decisionTrace (not legacy caps)", async () => {
    mockRpcEoa();
    const cfg = testConfig({ maxPlsPerTx: 1, maxPlsDaily: 10 });
    const w = await createAgentWallet(cfg);
    const { killSwitch } = await import("../src/wallet/service.js");
    await killSwitch(cfg, w.id);
    const proposal = await proposeAgentTx(cfg, {
      walletId: w.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 5,
      data: "0x",
    });

    expect(proposal.policyCheck.allowed).toBe(false);
    expect(proposal.status).toBe("rejected");
    expect(proposal.reviewSummary.decision).toBe("deny");
    expect(proposal.reviewSummary.reasons.join(" ")).toMatch(/kill|disabled/i);
    expect(proposal.reviewSummary.decisionTrace[0]?.category).toMatch(
      /kill|enabled/,
    );
    expect(proposal.reviewSummary.nextStep).toMatch(/Do not execute|kill/i);
    expect(proposal.simulation.attempted).toBe(false);
  });
});
