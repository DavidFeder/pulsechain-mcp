/**
 * v0.1.16: router liquidity notional + agent intent intelligence.
 * Drives shipped inspectTokenNotional, buildAgentIntentView, buildTxReviewSummary.
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseEther } from "viem";
import {
  inspectTokenNotional,
  TOKEN_NOTIONAL_SELECTORS,
} from "../src/wallet/tokenNotional.js";
import {
  buildAgentIntentView,
  buildTxReviewSummary,
} from "../src/wallet/reviewSummary.js";
import { evaluatePolicy } from "../src/wallet/policy.js";
import { PULSEX_V2_ROUTER } from "../src/constants.js";

const tokenA = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27" as const; // WPLS
const tokenB = "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab" as const; // PLSX
const lpTo = "0x00000000000000000000000000000000000000b1" as const;

const liquidityAbi = [
  {
    type: "function",
    name: "addLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "amountADesired", type: "uint256" },
      { name: "amountBDesired", type: "uint256" },
      { name: "amountAMin", type: "uint256" },
      { name: "amountBMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" },
      { name: "liquidity", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "addLiquidityETH",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountTokenDesired", type: "uint256" },
      { name: "amountTokenMin", type: "uint256" },
      { name: "amountETHMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "amountToken", type: "uint256" },
      { name: "amountETH", type: "uint256" },
      { name: "liquidity", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "removeLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "liquidity", type: "uint256" },
      { name: "amountAMin", type: "uint256" },
      { name: "amountBMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "removeLiquidityETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "liquidity", type: "uint256" },
      { name: "amountTokenMin", type: "uint256" },
      { name: "amountETHMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [
      { name: "amountToken", type: "uint256" },
      { name: "amountETH", type: "uint256" },
    ],
  },
] as const;

describe("router liquidity notional (shipped inspectTokenNotional)", () => {
  it("decodes addLiquidity desired amounts with high confidence", () => {
    const data = encodeFunctionData({
      abi: liquidityAbi,
      functionName: "addLiquidity",
      args: [
        tokenA,
        tokenB,
        parseEther("10"),
        parseEther("20"),
        0n,
        0n,
        lpTo,
        9999999999n,
      ],
    });
    expect(data.slice(0, 10)).toBe(TOKEN_NOTIONAL_SELECTORS.addLiquidity);

    const ins = inspectTokenNotional({
      to: PULSEX_V2_ROUTER,
      data,
      valueWei: 0n,
    });
    expect(ins.pattern).toBe("router.addLiquidity");
    expect(ins.confidence).toBe("high");
    expect(ins.reliable).toBe(true);
    expect(ins.knownPulsexRouter).toBe(true);
    expect(ins.movements).toHaveLength(2);
    expect(ins.movements[0]!.role).toBe("addLiquidity");
    expect(ins.movements[0]!.amountRaw).toBe(parseEther("10").toString());
    expect(ins.movements[1]!.amountRaw).toBe(parseEther("20").toString());
  });

  it("decodes addLiquidityETH with token desired + native msg.value", () => {
    const data = encodeFunctionData({
      abi: liquidityAbi,
      functionName: "addLiquidityETH",
      args: [tokenB, parseEther("5"), 0n, 0n, lpTo, 9999999999n],
    });
    expect(data.slice(0, 10)).toBe(TOKEN_NOTIONAL_SELECTORS.addLiquidityETH);

    const valueWei = parseEther("3");
    const ins = inspectTokenNotional({
      to: PULSEX_V2_ROUTER,
      data,
      valueWei,
    });
    expect(ins.pattern).toBe("router.addLiquidityETH");
    expect(ins.reliable).toBe(true);
    const tokenMove = ins.movements.find((m) => m.token !== "native");
    const nativeMove = ins.movements.find((m) => m.token === "native");
    expect(tokenMove?.amountRaw).toBe(parseEther("5").toString());
    expect(nativeMove?.amountRaw).toBe(valueWei.toString());
    expect(nativeMove?.role).toBe("addLiquidity");
  });

  it("decodes removeLiquidity without inventing underlying amounts", () => {
    const data = encodeFunctionData({
      abi: liquidityAbi,
      functionName: "removeLiquidity",
      args: [tokenA, tokenB, parseEther("1"), 0n, 0n, lpTo, 9999999999n],
    });
    const ins = inspectTokenNotional({
      to: PULSEX_V2_ROUTER,
      data,
    });
    expect(ins.pattern).toBe("router.removeLiquidity");
    expect(ins.reliable).toBe(true);
    expect(ins.notes.join(" ")).toMatch(/LP|not invented|underly/i);
    // Zero notional on underlyings — no false cap application of LP shares
    expect(ins.movements.every((m) => m.amountRaw === "0")).toBe(true);
    expect(ins.movements.every((m) => m.role === "removeLiquidity")).toBe(true);
  });

  it("decodes removeLiquidityETH", () => {
    const data = encodeFunctionData({
      abi: liquidityAbi,
      functionName: "removeLiquidityETH",
      args: [tokenB, parseEther("2"), 0n, 0n, lpTo, 9999999999n],
    });
    expect(data.slice(0, 10)).toBe(TOKEN_NOTIONAL_SELECTORS.removeLiquidityETH);
    const ins = inspectTokenNotional({ to: PULSEX_V2_ROUTER, data });
    expect(ins.pattern).toBe("router.removeLiquidityETH");
    expect(ins.reliable).toBe(true);
  });

  it("fails closed on truncated addLiquidity", () => {
    const ins = inspectTokenNotional({
      to: PULSEX_V2_ROUTER,
      data: TOKEN_NOTIONAL_SELECTORS.addLiquidity + "00".repeat(8),
    });
    expect(ins.reliable).toBe(false);
    expect(["truncated", "invalid"]).toContain(ins.pattern);
  });

  it("operator-trust: erc20NotionalCaps do not hard-deny addLiquidity amounts", () => {
    const data = encodeFunctionData({
      abi: liquidityAbi,
      functionName: "addLiquidity",
      args: [
        tokenA,
        tokenB,
        parseEther("10"),
        parseEther("1"),
        0n,
        0n,
        lpTo,
        9999999999n,
      ],
    });
    const check = evaluatePolicy({
      policy: {
        enabled: true,
        killed: false,
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      tokenDailySpend: {},
      to: PULSEX_V2_ROUTER,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
    expect(check.tokenNotional?.pattern).toBe("router.addLiquidity");
    expect(check.tokenNotional?.notes.join(" ")).toMatch(/authorization|Decode only/i);
  });
});

describe("agent intelligence (shipped buildAgentIntentView / reviewSummary)", () => {
  it("inspect path: known addLiquidity → decodeComplete + explanations", () => {
    const data = encodeFunctionData({
      abi: liquidityAbi,
      functionName: "addLiquidityETH",
      args: [tokenB, parseEther("1"), 0n, 0n, lpTo, 9999999999n],
    });
    const valueWei = parseEther("2").toString();
    const inspection = inspectTokenNotional({
      to: PULSEX_V2_ROUTER,
      data,
      valueWei,
    });
    const intent = buildAgentIntentView({
      to: PULSEX_V2_ROUTER,
      data,
      valueWei,
      inspection,
    });
    expect(intent.decodeComplete).toBe(true);
    expect(intent.decodeKnowledge.status).toBe("known_priority");
    expect(intent.movementExplanations.length).toBeGreaterThan(0);
    expect(intent.movementExplanations.join(" ")).toMatch(/liquidity|native/i);
    expect(intent.residualUncertainty.length).toBeGreaterThan(0);
    expect(JSON.stringify(intent)).not.toMatch(/privateKey|masterKey/i);
  });

  it("unknown selector → decodeComplete false (not a send gate)", () => {
    const inspection = inspectTokenNotional({
      to: PULSEX_V2_ROUTER,
      data: "0x12345678" + "00".repeat(64),
    });
    expect(inspection.pattern).toBe("unknown");
    const intent = buildAgentIntentView({
      to: PULSEX_V2_ROUTER,
      data: "0x12345678" + "00".repeat(64),
      valueWei: "0",
      inspection,
    });
    expect(intent.decodeComplete).toBe(false);
    expect(intent.decodeKnowledge.status).toBe("unknown");
  });

  it("truncated priority selector → decodeComplete false (not a send gate)", () => {
    const inspection = inspectTokenNotional({
      to: tokenA,
      data: TOKEN_NOTIONAL_SELECTORS.transfer + "00".repeat(4),
    });
    const intent = buildAgentIntentView({
      to: tokenA,
      data: TOKEN_NOTIONAL_SELECTORS.transfer + "00".repeat(4),
      inspection,
    });
    expect(intent.decodeComplete).toBe(false);
    expect(intent.decodeKnowledge.status).toBe("truncated_or_invalid");
  });

  it("reviewSummary includes agentGuidance and decodeKnowledge on allow", () => {
    const check = evaluatePolicy({
      policy: {
        enabled: true,
        killed: false,
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      tokenDailySpend: {},
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
    });
    const summary = buildTxReviewSummary({
      to: "0x0000000000000000000000000000000000000001",
      valuePls: check.valuePls,
      valueWei: check.valueWei,
      data: "0x",
      policyCheck: check,
      context: "propose",
    });
    expect(summary.agentGuidance).toBe("ready");
    expect(summary.decodeKnowledge.status).toBe("empty");
    expect(summary.movementExplanations).toEqual([]);
    expect(summary.safetyHints.length).toBeGreaterThan(0);
  });

  it("kill-switch deny sets agentGuidance blocked", () => {
    const check = evaluatePolicy({
      policy: {
        enabled: false,
        killed: true,
      },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      tokenDailySpend: {},
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 5,
      data: "0x",
      destinationIsContract: false,
    });
    const summary = buildTxReviewSummary({
      to: "0x0000000000000000000000000000000000000001",
      policyCheck: check,
      data: "0x",
      context: "propose",
    });
    expect(summary.decision).toBe("deny");
    expect(summary.agentGuidance).toBe("blocked");
  });
});
