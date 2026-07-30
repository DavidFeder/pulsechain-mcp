/**
 * v0.1.7+: practical token-notional inspection + policy integration.
 * v0.1.8: exact-out, fee-supporting exact-in, one-level multicall.
 * v0.1.9: WETH9 deposit/withdraw (WPLS wrap/unwrap).
 * Drives shipped inspectTokenNotional + evaluatePolicy (no re-implementation).
 */
import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseEther } from "viem";
import {
  evaluatePolicy,
  mergePolicy,
  normalizePolicy,
} from "../src/wallet/policy.js";
import {
  inspectTokenNotional,
  TOKEN_NOTIONAL_SELECTORS,
} from "../src/wallet/tokenNotional.js";
import { DEFAULT_POLICY } from "../src/wallet/types.js";
import {
  PULSEX_V2_ROUTER,
  WPLS_ADDRESS,
  DAI_ADDRESS,
} from "../src/constants.js";

const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const SPENDER = "0x2222222222222222222222222222222222222222" as const;
/** Checksum-corrected (in-repo DAI_ADDRESS has a historical checksum typo). */
const TOKEN = getAddress(DAI_ADDRESS.toLowerCase());
const WPLS = getAddress(WPLS_ADDRESS.toLowerCase());
const ROUTER = getAddress(PULSEX_V2_ROUTER.toLowerCase());
const OTHER = "0x3333333333333333333333333333333333333333" as const;

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

const erc20TransferFromAbi = [
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const routerAbi = [
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapExactETHForTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapExactTokensForETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

function daySpend(spentPls = 0) {
  return {
    date: new Date().toISOString().slice(0, 10),
    spentPls,
  };
}

describe("inspectTokenNotional (shipped decode)", () => {
  it("surfaces ERC-20 transfer token + amount with high confidence", () => {
    const amount = 1_000_000_000_000_000_000n; // 1e18
    const data = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, amount],
    });
    expect(data.startsWith(TOKEN_NOTIONAL_SELECTORS.transfer)).toBe(true);

    const r = inspectTokenNotional({ to: TOKEN, data });
    expect(r.reliable).toBe(true);
    expect(r.confidence).toBe("high");
    expect(r.pattern).toBe("erc20.transfer");
    expect(r.riskRelevant).toBe(true);
    expect(r.movements).toHaveLength(1);
    expect(r.movements[0]!.token).toBe(TOKEN.toLowerCase());
    expect(r.movements[0]!.amountRaw).toBe(amount.toString());
    expect(r.movements[0]!.recipient).toBe(RECIPIENT.toLowerCase());
    expect(r.movements[0]!.role).toBe("transfer");
  });

  it("surfaces ERC-20 transferFrom token + amount", () => {
    const amount = 42n;
    const data = encodeFunctionData({
      abi: erc20TransferFromAbi,
      functionName: "transferFrom",
      args: [OTHER, RECIPIENT, amount],
    });
    const r = inspectTokenNotional({ to: TOKEN, data });
    expect(r.pattern).toBe("erc20.transferFrom");
    expect(r.confidence).toBe("high");
    expect(r.movements[0]!.amountRaw).toBe("42");
    expect(r.movements[0]!.from).toBe(OTHER.toLowerCase());
  });

  it("surfaces approve amount including unlimited", () => {
    const max =
      0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
    const data = encodeFunctionData({
      abi: erc20ApproveAbi,
      functionName: "approve",
      args: [SPENDER, max],
    });
    const r = inspectTokenNotional({ to: TOKEN, data });
    expect(r.pattern).toBe("erc20.approve");
    expect(r.confidence).toBe("high");
    expect(r.movements[0]!.amountRaw).toBe(max.toString());
    expect(r.notes.some((n) => /Unlimited/i.test(n))).toBe(true);
  });

  it("decodes PulseX router swapExactTokensForTokens amountIn + path[0]", () => {
    const amountIn = parseEther("100");
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, 1n, [TOKEN, WPLS], RECIPIENT, 9999999999n],
    });
    const r = inspectTokenNotional({
      to: ROUTER,
      data,
    });
    expect(r.pattern).toBe("router.swapExactTokensForTokens");
    expect(r.confidence).toBe("high");
    expect(r.reliable).toBe(true);
    expect(r.knownPulsexRouter).toBe(true);
    expect(r.movements[0]!.token).toBe(TOKEN.toLowerCase());
    expect(r.movements[0]!.amountRaw).toBe(amountIn.toString());
    expect(r.movements[0]!.role).toBe("swapExactIn");
  });

  it("decodes swapExactETHForTokens as native movement from valueWei", () => {
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactETHForTokens",
      args: [1n, [WPLS, TOKEN], RECIPIENT, 9999999999n],
    });
    const valueWei = parseEther("5");
    const r = inspectTokenNotional({
      to: ROUTER,
      data,
      valueWei,
    });
    expect(r.pattern).toBe("router.swapExactETHForTokens");
    expect(r.confidence).toBe("high");
    expect(r.movements[0]!.token).toBe("native");
    expect(r.movements[0]!.amountRaw).toBe(valueWei.toString());
  });

  it("fail-closed marks truncated transfer as unreliable", () => {
    const r = inspectTokenNotional({
      to: TOKEN,
      data: TOKEN_NOTIONAL_SELECTORS.transfer, // selector only
    });
    expect(r.pattern).toBe("truncated");
    expect(r.reliable).toBe(false);
    expect(r.confidence).toBe("none");
    expect(r.riskRelevant).toBe(true);
    expect(r.movements).toHaveLength(0);
  });

  it("marks unknown selector as unreliable (no silent zero notional)", () => {
    // Arbitrary non-priority selector (not deposit — that is covered as weth.deposit)
    const r = inspectTokenNotional({
      to: WPLS_ADDRESS,
      data: "0x12345678",
    });
    expect(r.pattern).toBe("unknown");
    expect(r.reliable).toBe(false);
    expect(r.confidence).toBe("none");
    expect(r.riskRelevant).toBe(true);
  });

  it("empty calldata is reliable with no risk-relevant token move", () => {
    const r = inspectTokenNotional({
      to: RECIPIENT,
      data: "0x",
    });
    expect(r.pattern).toBe("empty");
    expect(r.reliable).toBe(true);
    expect(r.riskRelevant).toBe(false);
  });
});

describe("evaluatePolicy token-notional integration", () => {
  const base = DEFAULT_POLICY(100, 1000);

  it("(a) native-only transfer: legacy PLS caps display-only (over-cap still allowed)", () => {
    const check = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 5,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
    expect(check.tokenNotional?.pattern).toBe("empty");
    expect(check.tokenNotional?.considered).toBe(true);
    expect(check.tokenNotional?.riskRelevant).toBe(false);

    const over = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 500,
      data: "0x",
      destinationIsContract: false,
    });
    expect(over.allowed).toBe(true); // operator-trust
    expect(over.reasons).toEqual([]);
  });

  it("(b) allowlisted token transfer with per-token display cap still allowed", () => {
    const amount = 100n;
    const data = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, amount],
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
    });
    expect(check.allowed).toBe(true);
    expect(check.tokenNotional?.confidence).toBe("high");
    expect(Array.isArray(check.tokenNotional?.capsApplied)).toBe(true);
  });

  it("(c) same transfer over per-token cap still allowed (operator-trust)", () => {
    const amount = 5000n;
    const data = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, amount],
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
    });
    expect(check.allowed).toBe(true); // operator-trust: not a hard gate
    expect(check.reasons).toEqual([]);
    expect(Array.isArray(check.tokenNotional?.capsApplied)).toBe(true);
  });

  it("(d) risk-relevant undecodable calldata still allowed when requireDecodableCalldata (operator-trust)", () => {
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS_ADDRESS],
        requireDecodableCalldata: true,
      },
      dailySpend: daySpend(0),
      to: WPLS_ADDRESS,
      valuePls: 1,
      data: "0x12345678", // non-priority selector
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true); // operator-trust: not a hard gate
    expect(check.reasons).toEqual([]);
    expect(check.tokenNotional?.pattern).toBe("unknown");
    // Operator-trust never hard-enforces requireDecodableCalldata
    expect(check.tokenNotional?.requireDecodableCalldata).toBe(false);
  });

  it("truncated transfer marked unreliable without hard-deny (even without requireDecodableCalldata)", () => {
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [TOKEN],
        requireDecodableCalldata: false,
      },
      dailySpend: daySpend(0),
      to: TOKEN,
      valuePls: 0,
      data: TOKEN_NOTIONAL_SELECTORS.transfer,
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true); // operator-trust: not a hard gate
    expect(check.reasons).toEqual([]);
    expect(check.tokenNotional?.reliable).toBe(false);
  });

  it("legacy tokenSpendCaps still means per-destination native PLS (not ERC-20 amount)", () => {
    const data = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, 999_999_999_999_999_999n],
    });
    // Large ERC-20 amount, zero native value, tokenSpendCaps only — must still allow
    // (tokenSpendCaps is native PLS to destination, not ERC-20 notional)
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [TOKEN],
        tokenSpendCaps: { [TOKEN.toLowerCase()]: 1 },
        // no erc20NotionalCaps
      },
      dailySpend: daySpend(0),
      to: TOKEN,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
    expect(check.tokenNotional?.movements[0]?.amountRaw).toBe(
      "999999999999999999",
    );
  });

  it("router swap exact-in surfaces path[0] notional; over erc20NotionalCaps still allowed", () => {
    const amountIn = parseEther("50");
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactTokensForTokens",
      args: [amountIn, 1n, [TOKEN, WPLS], RECIPIENT, 9999999999n],
    });
    const under = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [ROUTER],
        erc20NotionalCaps: {
          [TOKEN.toLowerCase()]: parseEther("100").toString(),
        },
      },
      dailySpend: daySpend(0),
      to: ROUTER,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(under.allowed).toBe(true);
    expect(under.tokenNotional?.knownPulsexRouter).toBe(true);

    const over = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [ROUTER],
        erc20NotionalCaps: {
          [TOKEN.toLowerCase()]: parseEther("10").toString(),
        },
      },
      dailySpend: daySpend(0),
      to: ROUTER,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(over.allowed).toBe(true); // operator-trust
    expect(over.reasons).toEqual([]);
  });

  it("unknown method still allowed when requireDecodableCalldata=false (BC)", () => {
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS_ADDRESS],
        requireDecodableCalldata: false,
      },
      dailySpend: daySpend(0),
      to: WPLS_ADDRESS,
      valuePls: 1,
      data: "0x12345678",
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
    expect(check.tokenNotional?.pattern).toBe("unknown");
    expect(check.tokenNotional?.considered).toBe(true);
  });

  it("mergePolicy / normalizePolicy preserve new notional fields", () => {
    const current = DEFAULT_POLICY(10, 100);
    const next = mergePolicy(current, {
      erc20NotionalCaps: { [TOKEN]: "12345" },
      requireDecodableCalldata: true,
    });
    expect(next.erc20NotionalCaps[TOKEN.toLowerCase()]).toBe("12345");
    expect(next.requireDecodableCalldata).toBe(true);

    const migrated = normalizePolicy({
      maxPlsPerTx: 1,
      maxPlsDaily: 2,
      // legacy record missing new fields
    });
    expect(migrated.erc20NotionalCaps).toEqual({});
    expect(migrated.requireDecodableCalldata).toBe(false);
  });

  it("mergePolicy rejects non-integer erc20NotionalCaps", () => {
    expect(() =>
      mergePolicy(DEFAULT_POLICY(10, 100), {
        erc20NotionalCaps: { [TOKEN]: "1.5" },
      }),
    ).toThrow(/integer decimal string/i);
  });
});

// ---------------------------------------------------------------------------
// v0.1.8 — exact-out, fee-supporting exact-in, one-level multicall
// ---------------------------------------------------------------------------

const routerExactOutAbi = [
  {
    type: "function",
    name: "swapTokensForExactTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountOut", type: "uint256" },
      { name: "amountInMax", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "swapETHForExactTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOut", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

const feeSupportingAbi = [
  {
    type: "function",
    name: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const multicallBytesAbi = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

const aggregate3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
] as const;

describe("inspectTokenNotional v0.1.8 router extensions", () => {
  it("decodes swapTokensForExactTokens with amountInMax notional", () => {
    const amountInMax = parseEther("25");
    const data = encodeFunctionData({
      abi: routerExactOutAbi,
      functionName: "swapTokensForExactTokens",
      args: [parseEther("1"), amountInMax, [TOKEN, WPLS], RECIPIENT, 9999999999n],
    });
    const r = inspectTokenNotional({ to: ROUTER, data });
    expect(r.pattern).toBe("router.swapTokensForExactTokens");
    expect(r.confidence).toBe("high");
    expect(r.reliable).toBe(true);
    expect(r.knownPulsexRouter).toBe(true);
    expect(r.movements[0]!.token).toBe(TOKEN.toLowerCase());
    expect(r.movements[0]!.amountRaw).toBe(amountInMax.toString());
    expect(r.movements[0]!.role).toBe("swapExactOutMaxIn");
  });

  it("decodes fee-on-transfer supporting exact-in", () => {
    const amountIn = parseEther("7");
    const data = encodeFunctionData({
      abi: feeSupportingAbi,
      functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
      args: [amountIn, 1n, [TOKEN, WPLS], RECIPIENT, 9999999999n],
    });
    const r = inspectTokenNotional({ to: ROUTER, data });
    expect(r.pattern).toBe(
      "router.swapExactTokensForTokensSupportingFeeOnTransferTokens",
    );
    expect(r.confidence).toBe("high");
    expect(r.movements[0]!.amountRaw).toBe(amountIn.toString());
    expect(r.movements[0]!.role).toBe("swapExactIn");
    expect(r.notes.some((n) => /Fee-on-transfer/i.test(n))).toBe(true);
  });

  it("fail-closed on truncated exact-out selector", () => {
    const r = inspectTokenNotional({
      to: ROUTER,
      data: TOKEN_NOTIONAL_SELECTORS.swapTokensForExactTokens,
    });
    expect(r.pattern).toBe("truncated");
    expect(r.reliable).toBe(false);
    expect(r.riskRelevant).toBe(true);
  });
});

describe("inspectTokenNotional v0.1.8 multicall", () => {
  it("expands multicall(bytes[]) with inner ERC-20 transfer", () => {
    const transferData = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, 250n],
    });
    // Self-multicall on the token contract (inners target same `to`)
    const data = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[transferData]],
    });
    const r = inspectTokenNotional({ to: TOKEN, data });
    expect(r.pattern).toBe("multicall.bytes");
    expect(r.multicallExpanded).toBe(true);
    expect(r.innerCallCount).toBe(1);
    expect(r.innerUnreliableCount).toBe(0);
    expect(r.reliable).toBe(true);
    expect(r.confidence).toBe("high");
    expect(r.movements).toHaveLength(1);
    expect(r.movements[0]!.amountRaw).toBe("250");
    expect(r.movements[0]!.fromMulticall).toBe(true);
    expect(r.movements[0]!.multicallIndex).toBe(0);
    expect(r.notes.some((n) => /one level/i.test(n))).toBe(true);
  });

  it("expands aggregate3 with inner transfer to explicit target", () => {
    const transferData = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, 99n],
    });
    const data = encodeFunctionData({
      abi: aggregate3Abi,
      functionName: "aggregate3",
      args: [
        [
          {
            target: TOKEN,
            allowFailure: false,
            callData: transferData,
          },
        ],
      ],
    });
    const r = inspectTokenNotional({
      to: getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
      data,
    });
    expect(r.pattern).toBe("multicall.aggregate3");
    expect(r.multicallExpanded).toBe(true);
    expect(r.movements[0]!.token).toBe(TOKEN.toLowerCase());
    expect(r.movements[0]!.amountRaw).toBe("99");
    expect(r.reliable).toBe(true);
  });

  it("marks multicall with unknown/truncated inner as unreliable", () => {
    const badInner = TOKEN_NOTIONAL_SELECTORS.transfer; // truncated transfer
    const data = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[badInner]],
    });
    const r = inspectTokenNotional({ to: TOKEN, data });
    expect(r.multicallExpanded).toBe(true);
    expect(r.reliable).toBe(false);
    expect(r.confidence).toBe("low");
    expect(r.innerUnreliableCount).toBeGreaterThan(0);
    expect(r.riskRelevant).toBe(true);
  });

  it("does not recurse nested multicall (one level only)", () => {
    const transferData = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, 1n],
    });
    const innerMulti = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[transferData]],
    });
    const outer = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[innerMulti]],
    });
    const r = inspectTokenNotional({ to: TOKEN, data: outer });
    expect(r.multicallExpanded).toBe(true);
    expect(r.reliable).toBe(false);
    expect(r.confidence).toBe("low");
    // Nested multicall not expanded — no transfer movements surfaced
    expect(r.movements.every((m) => m.role !== "transfer")).toBe(true);
  });
});

describe("evaluatePolicy v0.1.8 router + multicall", () => {
  const base = DEFAULT_POLICY(100, 1000);

  it("exact-out amountInMax notional inspected; over erc20NotionalCaps still allowed", () => {
    const amountInMax = parseEther("50");
    const data = encodeFunctionData({
      abi: routerExactOutAbi,
      functionName: "swapTokensForExactTokens",
      args: [1n, amountInMax, [TOKEN, WPLS], RECIPIENT, 9999999999n],
    });
    const under = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [ROUTER],
        erc20NotionalCaps: {
          [TOKEN.toLowerCase()]: parseEther("100").toString(),
        },
      },
      dailySpend: daySpend(0),
      to: ROUTER,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(under.allowed).toBe(true);

    const over = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [ROUTER],
        erc20NotionalCaps: {
          [TOKEN.toLowerCase()]: parseEther("10").toString(),
        },
      },
      dailySpend: daySpend(0),
      to: ROUTER,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(over.allowed).toBe(true); // operator-trust
    expect(over.reasons).toEqual([]);
  });

  it("multicall-aggregated inner transfer notional inspected; over caps still allowed", () => {
    const transferData = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, 500n],
    });
    const data = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[transferData]],
    });
    const under = evaluatePolicy({
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
    });
    expect(under.allowed).toBe(true);
    expect(under.tokenNotional?.multicallExpanded).toBe(true);
    expect(Array.isArray(under.tokenNotional?.capsApplied)).toBe(true);

    const over = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [TOKEN],
        erc20NotionalCaps: { [TOKEN.toLowerCase()]: "100" },
      },
      dailySpend: daySpend(0),
      to: TOKEN,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(over.allowed).toBe(true); // operator-trust
    expect(over.reasons).toEqual([]);
  });

  it("fail-closed multicall with ambiguous inner (low confidence)", () => {
    const data = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[TOKEN_NOTIONAL_SELECTORS.transfer]],
    });
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [TOKEN],
        requireDecodableCalldata: false,
      },
      dailySpend: daySpend(0),
      to: TOKEN,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true); // operator-trust: not a hard gate
    expect(check.reasons).toEqual([]);
    expect(check.tokenNotional?.reliable).toBe(false);
    expect(check.tokenNotional?.multicallExpanded).toBe(true);
  });

  it("sums same-token multicall inners for notional (per-tx total; caps not hard gates)", () => {
    // Two transfers of 600 each = 1200 total vs cap 1000 — operator-trust still allows
    const t1 = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [RECIPIENT, 600n],
    });
    const t2 = encodeFunctionData({
      abi: erc20TransferAbi,
      functionName: "transfer",
      args: [OTHER, 600n],
    });
    const data = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[t1, t2]],
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
    });
    expect(check.allowed).toBe(true); // operator-trust: not a hard gate
    expect(check.reasons).toEqual([]);
    expect(check.tokenNotional?.multicallExpanded).toBe(true);
    expect(check.tokenNotional?.movements).toHaveLength(2);
    expect(Array.isArray(check.tokenNotional?.capsApplied)).toBe(true);

    // Same batch under a higher cap still allowed
    const under = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [TOKEN],
        erc20NotionalCaps: { [TOKEN.toLowerCase()]: "1200" },
      },
      dailySpend: daySpend(0),
      to: TOKEN,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(under.allowed).toBe(true);
    expect(Array.isArray(under.tokenNotional?.capsApplied)).toBe(true);
  });

  it("native-only still PLS-only after multicall work", () => {
    const check = evaluatePolicy({
      policy: base,
      dailySpend: daySpend(0),
      to: RECIPIENT,
      valuePls: 3,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
    expect(check.tokenNotional?.pattern).toBe("empty");
    expect(check.tokenNotional?.multicallExpanded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v0.1.9 — WETH9 deposit / withdraw (WPLS wrap / unwrap)
// ---------------------------------------------------------------------------

const wethWithdrawAbi = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;

describe("inspectTokenNotional v0.1.9 WETH9 deposit/withdraw", () => {
  it("decodes WPLS deposit() as native notional from valueWei", () => {
    const valueWei = parseEther("2.5");
    const r = inspectTokenNotional({
      to: WPLS_ADDRESS,
      data: TOKEN_NOTIONAL_SELECTORS.deposit,
      valueWei,
    });
    expect(r.pattern).toBe("weth.deposit");
    expect(r.confidence).toBe("high");
    expect(r.reliable).toBe(true);
    expect(r.riskRelevant).toBe(true);
    expect(r.movements).toHaveLength(1);
    expect(r.movements[0]!.token).toBe("native");
    expect(r.movements[0]!.amountRaw).toBe(valueWei.toString());
    expect(r.movements[0]!.role).toBe("deposit");
    expect(r.notes.some((n) => /known WPLS/i.test(n))).toBe(true);
  });

  it("decodes WPLS withdraw(uint256) as WPLS notional", () => {
    const wad = parseEther("7");
    const data = encodeFunctionData({
      abi: wethWithdrawAbi,
      functionName: "withdraw",
      args: [wad],
    });
    const r = inspectTokenNotional({ to: WPLS_ADDRESS, data });
    expect(r.pattern).toBe("weth.withdraw");
    expect(r.confidence).toBe("high");
    expect(r.reliable).toBe(true);
    expect(r.movements[0]!.token).toBe(WPLS.toLowerCase());
    expect(r.movements[0]!.amountRaw).toBe(wad.toString());
    expect(r.movements[0]!.role).toBe("withdraw");
  });

  it("fail-closed on deposit with trailing calldata", () => {
    const r = inspectTokenNotional({
      to: WPLS_ADDRESS,
      data: (TOKEN_NOTIONAL_SELECTORS.deposit +
        "0000000000000000000000000000000000000000000000000000000000000001") as `0x${string}`,
      valueWei: 1n,
    });
    expect(r.pattern).toBe("invalid");
    expect(r.reliable).toBe(false);
    expect(r.riskRelevant).toBe(true);
    expect(r.movements).toHaveLength(0);
  });

  it("fail-closed on truncated withdraw", () => {
    const r = inspectTokenNotional({
      to: WPLS_ADDRESS,
      data: TOKEN_NOTIONAL_SELECTORS.withdraw,
    });
    expect(r.pattern).toBe("truncated");
    expect(r.reliable).toBe(false);
    expect(r.riskRelevant).toBe(true);
  });
});

describe("evaluatePolicy v0.1.9 WETH9 deposit/withdraw", () => {
  const base = DEFAULT_POLICY(100, 1000);

  it("allows WPLS deposit under requireDecodableCalldata when decoded", () => {
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS_ADDRESS],
        requireDecodableCalldata: true,
        erc20NotionalCaps: { native: parseEther("10").toString() },
      },
      dailySpend: daySpend(0),
      to: WPLS_ADDRESS,
      valuePls: 2,
      data: TOKEN_NOTIONAL_SELECTORS.deposit,
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
    expect(check.tokenNotional?.pattern).toBe("weth.deposit");
    expect(check.tokenNotional?.reliable).toBe(true);
    expect(Array.isArray(check.tokenNotional?.capsApplied)).toBe(true);
  });

  it("allows WPLS deposit when erc20NotionalCaps.native exceeded (operator-trust)", () => {
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS_ADDRESS],
        requireDecodableCalldata: true,
        erc20NotionalCaps: { native: parseEther("1").toString() },
      },
      dailySpend: daySpend(0),
      to: WPLS_ADDRESS,
      valuePls: 2,
      data: TOKEN_NOTIONAL_SELECTORS.deposit,
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true); // operator-trust: not a hard gate
    expect(check.reasons).toEqual([]);
    expect(Array.isArray(check.tokenNotional?.capsApplied)).toBe(true);
  });

  it("inspects WPLS withdraw notional vs erc20NotionalCaps[WPLS] without hard gate", () => {
    const wad = parseEther("50");
    const data = encodeFunctionData({
      abi: wethWithdrawAbi,
      functionName: "withdraw",
      args: [wad],
    });
    const under = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS_ADDRESS],
        requireDecodableCalldata: true,
        erc20NotionalCaps: {
          [WPLS_ADDRESS.toLowerCase()]: parseEther("100").toString(),
        },
      },
      dailySpend: daySpend(0),
      to: WPLS_ADDRESS,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(under.allowed).toBe(true);
    expect(under.tokenNotional?.pattern).toBe("weth.withdraw");

    const over = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS_ADDRESS],
        requireDecodableCalldata: true,
        erc20NotionalCaps: {
          [WPLS_ADDRESS.toLowerCase()]: parseEther("10").toString(),
        },
      },
      dailySpend: daySpend(0),
      to: WPLS_ADDRESS,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(over.allowed).toBe(true); // operator-trust
    expect(over.reasons).toEqual([]);
  });

  it("expands deposit inside one-level multicall", () => {
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "multicall",
          stateMutability: "payable",
          inputs: [{ name: "data", type: "bytes[]" }],
          outputs: [{ name: "results", type: "bytes[]" }],
        },
      ] as const,
      functionName: "multicall",
      args: [[TOKEN_NOTIONAL_SELECTORS.deposit]],
    });
    // Self-target multicall on a non-WPLS address: inner deposit still decodes,
    // but target is the multicall outer `to` for self-target multicall(bytes[]).
    const r = inspectTokenNotional({
      to: WPLS_ADDRESS,
      data,
      valueWei: 0n,
    });
    expect(r.multicallExpanded).toBe(true);
    expect(r.reliable).toBe(true);
    expect(r.movements.some((m) => m.role === "deposit")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v0.1.12 — C1: multicall outer native value not silently undercounted
// ---------------------------------------------------------------------------

describe("inspectTokenNotional v0.1.12 multicall outer native", () => {
  const multicallBytesAbi = [
    {
      type: "function",
      name: "multicall",
      stateMutability: "payable",
      inputs: [{ name: "data", type: "bytes[]" }],
      outputs: [{ name: "results", type: "bytes[]" }],
    },
  ] as const;

  it("attributes outer valueWei as native notional for multicall+deposit", () => {
    const valueWei = parseEther("3");
    const data = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[TOKEN_NOTIONAL_SELECTORS.deposit]],
    });
    const r = inspectTokenNotional({
      to: WPLS_ADDRESS,
      data,
      valueWei,
    });
    expect(r.multicallExpanded).toBe(true);
    expect(r.reliable).toBe(true);
    expect(r.confidence).toBe("high");
    const native = r.movements.filter((m) => m.token === "native");
    expect(native.length).toBe(1);
    expect(native[0]!.amountRaw).toBe(valueWei.toString());
    expect(native[0]!.role).toBe("nativeValue");
    expect(r.notes.some((n) => /outer msg\.value|attributed/i.test(n))).toBe(
      true,
    );
  });

  it("attributes outer value with ETH-in swap inner (not zero)", () => {
    const valueWei = parseEther("1.5");
    const ethIn = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "swapExactETHForTokens",
          stateMutability: "payable",
          inputs: [
            { name: "amountOutMin", type: "uint256" },
            { name: "path", type: "address[]" },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [{ name: "amounts", type: "uint256[]" }],
        },
      ] as const,
      functionName: "swapExactETHForTokens",
      args: [1n, [WPLS, TOKEN], RECIPIENT, 9999999999n],
    });
    const data = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[ethIn]],
    });
    const r = inspectTokenNotional({
      to: ROUTER,
      data,
      valueWei,
    });
    expect(r.reliable).toBe(true);
    const nativeTotal = r.movements
      .filter((m) => m.token === "native")
      .reduce((s, m) => s + BigInt(m.amountRaw), 0n);
    expect(nativeTotal).toBe(valueWei);
  });
});

describe("evaluatePolicy v0.1.12 multicall + erc20NotionalCaps.native", () => {
  const base = DEFAULT_POLICY(100, 1000);
  const multicallBytesAbi = [
    {
      type: "function",
      name: "multicall",
      stateMutability: "payable",
      inputs: [{ name: "data", type: "bytes[]" }],
      outputs: [{ name: "results", type: "bytes[]" }],
    },
  ] as const;

  it("allows multicall+deposit when outer value exceeds erc20NotionalCaps.native (operator-trust)", () => {
    const data = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[TOKEN_NOTIONAL_SELECTORS.deposit]],
    });
    // 2 PLS outer value vs native cap 1 PLS wei — notional still tracked; not a hard gate
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS_ADDRESS],
        requireDecodableCalldata: true,
        erc20NotionalCaps: { native: parseEther("1").toString() },
      },
      dailySpend: daySpend(0),
      to: WPLS_ADDRESS,
      valuePls: 2,
      data,
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true); // operator-trust: not a hard gate
    expect(check.reasons).toEqual([]);
    expect(check.tokenNotional?.multicallExpanded).toBe(true);
    expect(check.tokenNotional?.reliable).toBe(true);
    // capsApplied is empty under operator-trust (no hard notional gates)
    expect(Array.isArray(check.tokenNotional?.capsApplied)).toBe(true);
  });

  it("allows multicall+deposit when outer value is under native display cap", () => {
    const data = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[TOKEN_NOTIONAL_SELECTORS.deposit]],
    });
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [WPLS_ADDRESS],
        requireDecodableCalldata: true,
        erc20NotionalCaps: { native: parseEther("10").toString() },
      },
      dailySpend: daySpend(0),
      to: WPLS_ADDRESS,
      valuePls: 2,
      data,
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
    expect(Array.isArray(check.tokenNotional?.capsApplied)).toBe(true);
  });

  it("zero outer value multicall token transfer still sums ERC-20 only", () => {
    const t = encodeFunctionData({
      abi: [
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
      ] as const,
      functionName: "transfer",
      args: [RECIPIENT, 500n],
    });
    const data = encodeFunctionData({
      abi: multicallBytesAbi,
      functionName: "multicall",
      args: [[t]],
    });
    const check = evaluatePolicy({
      policy: {
        ...base,
        contractAllowlist: [TOKEN],
        erc20NotionalCaps: {
          [TOKEN.toLowerCase()]: "1000",
          native: parseEther("1").toString(),
        },
      },
      dailySpend: daySpend(0),
      to: TOKEN,
      valuePls: 0,
      data,
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
    // No native movement attributed when outer value is 0
    expect(
      check.tokenNotional?.movements.every((m) => m.token !== "native"),
    ).toBe(true);
  });
});


