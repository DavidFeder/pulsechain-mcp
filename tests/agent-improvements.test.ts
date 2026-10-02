/**
 * Quote stamps, ERC-20 transfer proposals, USDL/LOAN catalog, allowance hints.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { decodeFunctionData, erc20Abi } from "viem";
import {
  CORE_TOKENS,
  LOAN_ADDRESS,
  USDL_ADDRESS,
  resolveCoreToken,
  tokenLabelFields,
} from "../src/constants.js";
import { PITEAS_ROUTER } from "../src/data/piteas.js";
import { buildPiteasAllowanceHint } from "../src/data/piteasAllowance.js";
import { formatRatioPercent } from "../src/data/liquidLoans.js";
import { loadConfig } from "../src/config.js";
import type { AppConfig } from "../src/types.js";
import { createAgentWallet, proposeAgentTx, setTestBroadcast } from "../src/wallet/service.js";
import { proposeTokenTransfer } from "../src/wallet/tokenTransfer.js";
import * as rpc from "../src/data/rpc.js";

const tempDirs: string[] = [];

function tempWalletDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-improve-"));
  tempDirs.push(d);
  return d;
}

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
    agentWalletDir: tempWalletDir(),
    agentWalletMultiprocStrict: false,
    httpTransportPort: undefined,
    logLevel: "error",
    httpTimeoutMs: 5000,
    toolProfile: "slim",
  };
}

function mockRpc(): void {
  vi.spyOn(rpc, "assertLiveRpcChainMatchesConfig").mockImplementation(
    async (cfg) => (cfg.network === "testnet" ? 943 : 369),
  );
  vi.spyOn(rpc, "getPublicClient").mockReturnValue({
    getBytecode: async () => "0x6000",
  } as never);
  vi.spyOn(rpc, "estimateGas").mockResolvedValue({ gasEstimate: "65000" });
  vi.spyOn(rpc, "ethCall").mockResolvedValue({ data: "0x" });
  vi.spyOn(rpc, "getFeeData").mockResolvedValue({
    gasPriceWei: "100000000000000",
    maxFeePerGas: "100000000000000",
    maxPriorityFeePerGas: "1000000000",
  });
}

afterEach(() => {
  setTestBroadcast(null);
  vi.restoreAllMocks();
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("USDL and LOAN catalog", () => {
  it("resolves only the explicit symbols and stays out of the core portfolio", () => {
    expect(resolveCoreToken("USDL")?.address).toBe(USDL_ADDRESS);
    expect(resolveCoreToken("LOAN")?.address).toBe(LOAN_ADDRESS);
    expect(resolveCoreToken("USD")).toBeUndefined();
    expect(resolveCoreToken("LUSD")).toBeUndefined();
    expect(resolveCoreToken("DAI")?.address).not.toBe(USDL_ADDRESS);
    expect(CORE_TOKENS.USDL).toBeUndefined();
    expect(CORE_TOKENS.LOAN).toBeUndefined();
    expect(tokenLabelFields(USDL_ADDRESS)?.is_usdl).toBe(true);
    expect(tokenLabelFields(USDL_ADDRESS)?.not_bridged_dai).toBe(true);
    expect(tokenLabelFields(LOAN_ADDRESS)?.is_loan).toBe(true);
    expect(tokenLabelFields(LOAN_ADDRESS)?.not_a_stablecoin).toBe(true);
  });
});

describe("Piteas quote stamp on proposals", () => {
  it("keeps unknown router calldata reviewable from the stamped quote", async () => {
    mockRpc();
    const cfg = testConfig();
    const wallet = await createAgentWallet(cfg);
    const quotedAt = new Date(Date.now() - 300_000).toISOString();
    const proposal = await proposeAgentTx(cfg, {
      walletId: wallet.id,
      to: PITEAS_ROUTER,
      valuePls: "1",
      data: "0x12345678",
      quoteReview: {
        source: "piteas",
        quotedAt,
        tokenIn: USDL_ADDRESS,
        tokenOut: LOAN_ADDRESS,
        amountIn: "1000000000000000000",
        amountOut: "2000000000000000000",
        amountOutMin: "1900000000000000000",
        router: PITEAS_ROUTER,
        sellingNativePls: false,
      },
    });
    expect(proposal.quoteReview?.source).toBe("piteas");
    expect(proposal.policyCheck.tokenNotional?.pattern).toBe("unknown");
    const quote = proposal.reviewSummary.aggregatorQuote;
    expect(quote?.tokenIn.toLowerCase()).toBe(USDL_ADDRESS.toLowerCase());
    expect(quote?.amountOutMin).toBe("1900000000000000000");
    expect(quote?.stale).toBe(true);
    expect(quote?.quoteAgeSec).toBeGreaterThanOrEqual(299);
    expect(quote?.routerMatchesDestination).toBe(true);
    expect(proposal.reviewSummary.headline).toMatch(/Piteas/);
    expect(proposal.reviewSummary.safetyHints.join(" ")).toMatch(/aggregatorQuote/);
    expect(proposal.reviewSummary.safetyHints.join(" ")).toMatch(/does not block the send/i);
    expect(proposal.reviewSummary.movementExplanations[0]).toMatch(/not a local selector decode/);
  });

  it("rejects a quote stamp that is not piteas", async () => {
    mockRpc();
    const cfg = testConfig();
    const wallet = await createAgentWallet(cfg);
    await expect(
      proposeAgentTx(cfg, {
        walletId: wallet.id,
        to: PITEAS_ROUTER,
        valuePls: 0,
        data: "0x12345678",
        quoteReview: {
          source: "other" as "piteas",
          tokenIn: USDL_ADDRESS,
          tokenOut: LOAN_ADDRESS,
          amountIn: "1",
          amountOut: "1",
        },
      }),
    ).rejects.toThrow(/piteas/);
  });
});

describe("transfer_token proposals", () => {
  it("proposes a USDL transfer and does not broadcast", async () => {
    mockRpc();
    const cfg = testConfig();
    const wallet = await createAgentWallet(cfg);
    const recipient = "0x0000000000000000000000000000000000000004";
    const proposal = await proposeTokenTransfer(cfg, {
      walletId: wallet.id,
      token: "USDL",
      to: recipient,
      amount: "1.5",
    });
    expect(proposal.status).toBe("pending");
    expect(proposal.to.toLowerCase()).toBe(USDL_ADDRESS.toLowerCase());
    expect(proposal.valueWei).toBe("0");
    expect(proposal.amountRaw).toBe("1500000000000000000");
    const decoded = decodeFunctionData({ abi: erc20Abi, data: proposal.data });
    expect(decoded.functionName).toBe("transfer");
    expect((decoded.args[0] as string).toLowerCase()).toBe(recipient);
    expect(decoded.args[1]).toBe(1500000000000000000n);
  });

  it("does not treat USD as USDL", async () => {
    const cfg = testConfig();
    await expect(
      proposeTokenTransfer(cfg, {
        walletId: "aw_" + "ab".repeat(16),
        token: "USD",
        to: "0x0000000000000000000000000000000000000004",
        amount: "1",
      }),
    ).rejects.toThrow(/USDL/);
  });
});

describe("Piteas allowance hint", () => {
  const prepared = {
    ok: true as const,
    source: "piteas" as const,
    advisory: true as const,
    broadcast: false as const,
    intent: {
      to: PITEAS_ROUTER,
      data: "0x1234",
      valueWei: "0",
      valuePls: "0",
    },
    review: {
      tokenIn: USDL_ADDRESS,
      tokenOut: LOAN_ADDRESS,
      tokenInParam: USDL_ADDRESS,
      tokenOutParam: LOAN_ADDRESS,
      amountIn: "1000",
      amountOut: "900",
      router: PITEAS_ROUTER,
      sellingNativePls: false,
      localDecodeExpect: "unknown_selector_likely" as const,
      allowedSlippage: 0.5,
    },
    methodParameters: { calldata: "0x1234", value: "0x0" },
    proposalQuoteReview: {
      source: "piteas" as const,
      quotedAt: new Date().toISOString(),
      tokenIn: USDL_ADDRESS,
      tokenOut: LOAN_ADDRESS,
      amountIn: "1000",
      amountOut: "900",
      router: PITEAS_ROUTER,
      sellingNativePls: false,
      allowedSlippage: 0.5,
    },
    nextStep: "propose",
    note: "note",
  };

  it("emits unsigned approve calldata when allowance is short", async () => {
    const hint = await buildPiteasAllowanceHint(
      testConfig(),
      prepared,
      "0x0000000000000000000000000000000000000005",
      async () => ({
        token: USDL_ADDRESS,
        owner: "0x0000000000000000000000000000000000000005",
        spender: PITEAS_ROUTER,
        allowanceRaw: "10",
        decimals: 18,
        allowanceFormatted: "0.00000000000000001",
      }),
    );
    expect(hint.status).toBe("insufficient");
    expect(hint.allowanceSufficient).toBe(false);
    expect(hint.suggestedApprove?.to.toLowerCase()).toBe(USDL_ADDRESS.toLowerCase());
    expect(hint.suggestedApprove?.spender.toLowerCase()).toBe(PITEAS_ROUTER.toLowerCase());
    const decoded = decodeFunctionData({
      abi: erc20Abi,
      data: hint.suggestedApprove!.data as `0x${string}`,
    });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args[1]).toBe(1000n);
  });

  it("skips native PLS sells", async () => {
    const hint = await buildPiteasAllowanceHint(
      testConfig(),
      {
        ...prepared,
        review: { ...prepared.review, sellingNativePls: true },
      },
      undefined,
    );
    expect(hint.status).toBe("not_applicable");
    expect(hint.allowanceSufficient).toBe(true);
    expect(hint.suggestedApprove).toBeNull();
  });
});

describe("Liquid Loans ratio formatting", () => {
  it("renders 110% MCR from 1.1e18", () => {
    expect(formatRatioPercent(1100000000000000000n)).toBe("110.00%");
  });
});

describe("tool profile config", () => {
  it("defaults to slim and accepts full", () => {
    expect(loadConfig({}).toolProfile).toBe("slim");
    expect(loadConfig({ PULSECHAIN_TOOL_PROFILE: "full" }).toolProfile).toBe("full");
  });
});
