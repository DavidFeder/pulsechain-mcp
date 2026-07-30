/**
 * Pure token-notional inspection for agent-wallet policy (no I/O).
 *
 * Coverage (priority patterns only):
 * - ERC-20 transfer / transferFrom / approve (fixed layouts)
 * - WETH9 deposit / withdraw (WPLS wrap/unwrap — fixed layouts)
 * - UniswapV2 / PulseX-style router:
 *   - exact-in: swapExactTokensForTokens, swapExactTokensForETH, swapExactETHForTokens
 *   - exact-out: swapTokensForExactTokens, swapTokensForExactETH, swapETHForExactTokens
 *     (notional = amountInMax / msg.value upper bound)
 *   - fee-on-transfer exact-in supporting variants
 *   - addLiquidity / addLiquidityETH (desired amounts = pull upper bounds)
 *   - removeLiquidity / removeLiquidityETH (LP share amount; underlyings noted)
 * - One-level multicall expansion:
 *   - multicall(bytes[]) / multicall(uint256,bytes[]) (self-target)
 *   - Multicall3-style aggregate / tryAggregate / aggregate3 (per-call target)
 *   - Outer msg.value (valueWei > 0) is attributed as a single native movement
 *     (inners cannot be given per-call value on these layouts — no silent undercount)
 *
 * Not covered: nested multicall beyond one level, V3 concentrated liquidity paths,
 * permit-liquidity variants, aggregators, per-call value multicalls (aggregate3Value),
 * proxies, NFT, bridges, arbitrary ABIs, full EVM simulation.
 */

import {
  decodeFunctionData,
  encodeFunctionData,
  type Hex,
  type Abi,
} from "viem";
import {
  MULTICALL3_ADDRESS,
  PULSEX_V1_ROUTER,
  PULSEX_V2_ROUTER,
  WPLS_ADDRESS,
} from "../constants.js";

export type TokenNotionalConfidence = "high" | "low" | "none";

export type TokenNotionalPattern =
  | "empty"
  | "erc20.transfer"
  | "erc20.transferFrom"
  | "erc20.approve"
  | "weth.deposit"
  | "weth.withdraw"
  | "router.swapExactTokensForTokens"
  | "router.swapExactTokensForETH"
  | "router.swapExactETHForTokens"
  | "router.swapTokensForExactTokens"
  | "router.swapTokensForExactETH"
  | "router.swapETHForExactTokens"
  | "router.swapExactTokensForTokensSupportingFeeOnTransferTokens"
  | "router.swapExactETHForTokensSupportingFeeOnTransferTokens"
  | "router.swapExactTokensForETHSupportingFeeOnTransferTokens"
  | "router.addLiquidity"
  | "router.addLiquidityETH"
  | "router.removeLiquidity"
  | "router.removeLiquidityETH"
  | "multicall.bytes"
  | "multicall.deadlineBytes"
  | "multicall.aggregate"
  | "multicall.tryAggregate"
  | "multicall.aggregate3"
  | "unknown"
  | "truncated"
  | "invalid";

export interface TokenMovement {
  /** Token contract for the amount, or "native" for PLS value on ETH legs */
  token: `0x${string}` | "native";
  /** Raw integer amount (token smallest units, or wei for native) */
  amountRaw: string;
  role:
    | "transfer"
    | "transferFrom"
    | "approve"
    | "deposit"
    | "withdraw"
    | "swapExactIn"
    | "swapExactOutMaxIn"
    | "addLiquidity"
    | "removeLiquidity"
    | "nativeValue";
  recipient?: `0x${string}`;
  path?: `0x${string}`[];
  spender?: `0x${string}`;
  from?: `0x${string}`;
  /** When movement came from a one-level multicall inner call */
  fromMulticall?: boolean;
  /** Index of the inner call (0-based) when fromMulticall */
  multicallIndex?: number;
}

export interface TokenNotionalInspection {
  considered: boolean;
  confidence: TokenNotionalConfidence;
  pattern: TokenNotionalPattern;
  movements: TokenMovement[];
  notes: string[];
  riskRelevant: boolean;
  /**
   * True when empty (no calldata risk) or high-confidence full decode.
   * False for truncated/invalid/unknown/low — policy fail-closed uses this.
   */
  reliable: boolean;
  knownPulsexRouter: boolean;
  /** True when outer multicall was expanded one level */
  multicallExpanded: boolean;
  /** Number of inner calldatas inspected (multicall only) */
  innerCallCount?: number;
  /** How many risk-relevant inners were not reliable */
  innerUnreliableCount?: number;
}

const KNOWN_PULSEX_ROUTERS = new Set([
  PULSEX_V1_ROUTER.toLowerCase(),
  PULSEX_V2_ROUTER.toLowerCase(),
]);

const KNOWN_WPLS = WPLS_ADDRESS.toLowerCase();
const KNOWN_MULTICALL3 = MULTICALL3_ADDRESS.toLowerCase();

export const TOKEN_NOTIONAL_SELECTORS = {
  transfer: "0xa9059cbb",
  transferFrom: "0x23b872dd",
  approve: "0x095ea7b3",
  /** WETH9 deposit() — WPLS wrap */
  deposit: "0xd0e30db0",
  /** WETH9 withdraw(uint256) — WPLS unwrap */
  withdraw: "0x2e1a7d4d",
  swapExactTokensForTokens: "0x38ed1739",
  swapExactETHForTokens: "0x7ff36ab5",
  swapExactTokensForETH: "0x18cbafe5",
  swapTokensForExactTokens: "0x8803dbee",
  swapTokensForExactETH: "0x4a25d94a",
  swapETHForExactTokens: "0xfb3bdb41",
  swapExactTokensForTokensSupportingFeeOnTransferTokens: "0x5c11d795",
  swapExactETHForTokensSupportingFeeOnTransferTokens: "0xb6f9de95",
  swapExactTokensForETHSupportingFeeOnTransferTokens: "0x791ac947",
  /** UniV2 / PulseX router liquidity (fixed layouts) */
  addLiquidity: "0xe8e33700",
  addLiquidityETH: "0xf305d719",
  removeLiquidity: "0xbaa2abde",
  removeLiquidityETH: "0x02751cec",
  multicallBytes: "0xac9650d8",
  multicallDeadlineBytes: "0x5ae401dc",
  aggregate: "0x252dba42",
  tryAggregate: "0xbce38bd7",
  aggregate3: "0x82ad56cb",
} as const;

const SELECTOR = TOKEN_NOTIONAL_SELECTORS;

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
] as const satisfies Abi;

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
] as const satisfies Abi;

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
] as const satisfies Abi;

/** WETH9 deposit() — no args, payable (wraps msg.value). */
const wethDepositAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const satisfies Abi;

/** WETH9 withdraw(uint256 wad) — burns wrapped token for native. */
const wethWithdrawAbi = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const satisfies Abi;

/** Exact-in + fee-supporting exact-in (same static arg shapes for token/ETH variants). */
const routerExactInFamilyAbi = [
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
  {
    type: "function",
    name: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "swapExactTokensForETHSupportingFeeOnTransferTokens",
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
] as const satisfies Abi;

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
    name: "swapTokensForExactETH",
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
] as const satisfies Abi;

/** UniV2Router02 add/remove liquidity (PulseX-compatible fixed layouts). */
const liquidityRouterAbi = [
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
] as const satisfies Abi;

const multicallBytesAbi = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const satisfies Abi;

const multicallDeadlineBytesAbi = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "data", type: "bytes[]" },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const satisfies Abi;

const aggregateAbi = [
  {
    type: "function",
    name: "aggregate",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "blockNumber", type: "uint256" },
      { name: "returnData", type: "bytes[]" },
    ],
  },
] as const satisfies Abi;

const tryAggregateAbi = [
  {
    type: "function",
    name: "tryAggregate",
    stateMutability: "payable",
    inputs: [
      { name: "requireSuccess", type: "bool" },
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
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
] as const satisfies Abi;

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
] as const satisfies Abi;

/** True for missing/blank/0x/0x0 calldata (no contract method payload). */
export function isEmptyData(data: string | undefined): boolean {
  if (data === undefined || data === null) return true;
  const d = data.trim().toLowerCase();
  return d === "" || d === "0x" || d === "0x0";
}

function normalizeHexData(data: string): Hex | null {
  const d = data.trim().toLowerCase();
  if (!d.startsWith("0x")) return null;
  if (d.length % 2 !== 0) return null;
  if (!/^0x[0-9a-f]*$/.test(d)) return null;
  return d as Hex;
}

function asAddress(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const v = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(v)) return null;
  return v as `0x${string}`;
}

function parseValueWei(valueWei?: bigint | string): bigint {
  if (valueWei === undefined || valueWei === "") return 0n;
  try {
    const w = typeof valueWei === "bigint" ? valueWei : BigInt(valueWei);
    return w < 0n ? 0n : w;
  } catch {
    return 0n;
  }
}

function emptyResult(
  partial: Partial<TokenNotionalInspection> &
    Pick<TokenNotionalInspection, "pattern" | "confidence" | "reliable">,
): TokenNotionalInspection {
  return {
    considered: true,
    movements: [],
    notes: [],
    riskRelevant: false,
    knownPulsexRouter: false,
    multicallExpanded: false,
    ...partial,
  };
}

function routerNotes(knownPulsexRouter: boolean, extra: string[] = []): string[] {
  const notes: string[] = [];
  if (knownPulsexRouter) {
    notes.push("Destination is a known PulseX V1/V2 router");
  } else {
    notes.push(
      "UniswapV2-style router layout decoded; destination is not a known PulseX router",
    );
  }
  notes.push("Amount is raw token units (decimals not resolved)");
  notes.push(...extra);
  return notes;
}

function normPath(
  path: readonly `0x${string}`[] | undefined,
): `0x${string}`[] {
  return (path ?? [])
    .map((a) => asAddress(a))
    .filter((a): a is `0x${string}` => a !== null);
}

type InnerCall = { target: string; data: string };

/**
 * Expand one multicall level: inspect each inner blob with the same decoder,
 * without further multicall expansion (depth gate).
 *
 * C1 (v0.1.12): supported multicall layouts do not encode per-inner msg.value.
 * Inners are decoded with valueWei=0 so ETH-in/deposit would otherwise report
 * native 0. When the outer transaction carries valueWei > 0, attribute the
 * **full outer native value once** as a native movement so erc20NotionalCaps["native"]
 * cannot silently undercount. Does not invent per-inner splits (would over-count).
 */
function expandMulticall(params: {
  pattern: TokenNotionalPattern;
  outerTo: string;
  knownPulsexRouter: boolean;
  inners: InnerCall[];
  notes: string[];
  /** Outer tx msg.value (wei) — attributed when > 0 */
  outerValueWei: bigint;
}): TokenNotionalInspection {
  const { pattern, knownPulsexRouter, inners, notes, outerValueWei } = params;
  const movements: TokenMovement[] = [];
  let innerUnreliable = 0;
  let anyRisk = false;
  const allNotes = [
    ...notes,
    "Multicall expanded one level only (no nested multicall recursion)",
  ];

  if (inners.length === 0) {
    const emptyMovements: TokenMovement[] = [];
    if (outerValueWei > 0n) {
      emptyMovements.push({
        token: "native",
        amountRaw: outerValueWei.toString(),
        role: "nativeValue",
      });
      allNotes.push(
        "Empty multicall batch with outer msg.value — native notional attributed from outer valueWei",
      );
    } else {
      allNotes.push("Empty multicall batch");
    }
    return {
      considered: true,
      pattern,
      confidence: "high",
      reliable: true,
      riskRelevant: emptyMovements.length > 0,
      knownPulsexRouter,
      multicallExpanded: true,
      innerCallCount: 0,
      innerUnreliableCount: 0,
      movements: emptyMovements,
      notes: allNotes,
    };
  }

  for (let i = 0; i < inners.length; i++) {
    const inner = inners[i]!;
    // Inners: no per-call value on these ABIs — do not invent splits.
    const sub = inspectTokenNotional({
      to: inner.target,
      data: inner.data,
      valueWei: 0n,
      _depth: 1,
    });
    if (sub.riskRelevant) {
      anyRisk = true;
      if (!sub.reliable) {
        innerUnreliable += 1;
        allNotes.push(
          `Inner[${i}] unreliable: pattern=${sub.pattern} confidence=${sub.confidence}` +
            (sub.notes[0] ? ` (${sub.notes[0]})` : ""),
        );
      }
    }
    for (const m of sub.movements) {
      movements.push({
        ...m,
        fromMulticall: true,
        multicallIndex: i,
      });
    }
    // Nested multicall at depth≥1 is already returned unreliable by the inner inspect
  }

  // Attribute outer msg.value once (conservative; prevents silent undercount of native caps)
  if (outerValueWei > 0n) {
    // Drop zero native from ETH-in/deposit decoded with valueWei=0 (would clutter sum)
    const kept: TokenMovement[] = [];
    let existingNative = 0n;
    for (const m of movements) {
      if (m.token === "native") {
        try {
          const amt = BigInt(m.amountRaw);
          if (amt === 0n) continue;
          existingNative += amt;
          kept.push(m);
        } catch {
          kept.push(m);
        }
      } else {
        kept.push(m);
      }
    }
    movements.length = 0;
    movements.push(...kept);

    if (existingNative > 0n) {
      // Unexpected non-zero native from inners without value attribution model
      allNotes.push(
        "Multicall had non-zero native movements from inners while outer valueWei > 0 — " +
          "fail-closed (cannot attribute without double-count risk)",
      );
      return {
        considered: true,
        pattern,
        confidence: "low",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: true,
        innerCallCount: inners.length,
        innerUnreliableCount: innerUnreliable + 1,
        movements,
        notes: allNotes,
      };
    }
    movements.push({
      token: "native",
      amountRaw: outerValueWei.toString(),
      role: "nativeValue",
    });
    allNotes.push(
      `Outer msg.value ${outerValueWei} wei attributed as single native notional ` +
        `(multicall layouts do not encode per-inner value; no silent undercount)`,
    );
    anyRisk = true;
  }

  const reliable = innerUnreliable === 0;
  const confidence: TokenNotionalConfidence = !anyRisk
    ? "high"
    : reliable
      ? "high"
      : "low";

  return {
    considered: true,
    pattern,
    confidence,
    reliable,
    riskRelevant: anyRisk || movements.length > 0,
    knownPulsexRouter,
    multicallExpanded: true,
    innerCallCount: inners.length,
    innerUnreliableCount: innerUnreliable,
    movements,
    notes: allNotes,
  };
}

function tryDecodeExactInFamily(
  hex: Hex,
  selector: string,
  knownPulsexRouter: boolean,
  valueWei: bigint,
  bodyLen: number,
): TokenNotionalInspection | null {
  const exactInSelectors = new Set<string>([
    SELECTOR.swapExactTokensForTokens,
    SELECTOR.swapExactETHForTokens,
    SELECTOR.swapExactTokensForETH,
    SELECTOR.swapExactTokensForTokensSupportingFeeOnTransferTokens,
    SELECTOR.swapExactETHForTokensSupportingFeeOnTransferTokens,
    SELECTOR.swapExactTokensForETHSupportingFeeOnTransferTokens,
  ]);
  if (!exactInSelectors.has(selector)) return null;

  if (bodyLen < 128) {
    return emptyResult({
      pattern: "truncated",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: ["Router exact-in / fee-supporting selector with truncated arguments"],
    });
  }

  const feeSupporting =
    selector ===
      SELECTOR.swapExactTokensForTokensSupportingFeeOnTransferTokens ||
    selector === SELECTOR.swapExactETHForTokensSupportingFeeOnTransferTokens ||
    selector === SELECTOR.swapExactTokensForETHSupportingFeeOnTransferTokens;

  try {
    const decoded = decodeFunctionData({
      abi: routerExactInFamilyAbi,
      data: hex,
    });
    const extra = feeSupporting
      ? [
          "Fee-on-transfer supporting variant: amountIn is what the wallet sends; residual received may be lower",
        ]
      : [
          "amountIn is exact-in only; fee-on-transfer / tax tokens may move differently on-chain",
        ];
    const notes = routerNotes(knownPulsexRouter, extra);

    const ethIn =
      decoded.functionName === "swapExactETHForTokens" ||
      decoded.functionName ===
        "swapExactETHForTokensSupportingFeeOnTransferTokens";

    if (ethIn) {
      const [, path, recipient] = decoded.args as [
        bigint,
        readonly `0x${string}`[],
        `0x${string}`,
        bigint,
      ];
      const pathNorm = normPath(path);
      const rec = asAddress(recipient);
      const pattern: TokenNotionalPattern =
        decoded.functionName ===
        "swapExactETHForTokensSupportingFeeOnTransferTokens"
          ? "router.swapExactETHForTokensSupportingFeeOnTransferTokens"
          : "router.swapExactETHForTokens";
      if (pathNorm.length < 2 || !rec) {
        return emptyResult({
          pattern,
          confidence: "low",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: [...notes, "Path length < 2 or invalid recipient — low confidence"],
        });
      }
      return {
        considered: true,
        confidence: "high",
        pattern,
        reliable: true,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: false,
        notes: [
          ...notes,
          "Native PLS in is msg.value (legacy maxPls* fields are display-only under operator-trust)",
        ],
        movements: [
          {
            token: "native",
            amountRaw: valueWei.toString(),
            role: "nativeValue",
            recipient: rec,
            path: pathNorm,
          },
        ],
      };
    }

    const [amountIn, , path, recipient] = decoded.args as [
      bigint,
      bigint,
      readonly `0x${string}`[],
      `0x${string}`,
      bigint,
    ];
    const pathNorm = normPath(path);
    const rec = asAddress(recipient);
    let pattern: TokenNotionalPattern = "router.swapExactTokensForTokens";
    if (decoded.functionName === "swapExactTokensForETH") {
      pattern = "router.swapExactTokensForETH";
    } else if (
      decoded.functionName ===
      "swapExactTokensForTokensSupportingFeeOnTransferTokens"
    ) {
      pattern = "router.swapExactTokensForTokensSupportingFeeOnTransferTokens";
    } else if (
      decoded.functionName ===
      "swapExactTokensForETHSupportingFeeOnTransferTokens"
    ) {
      pattern = "router.swapExactTokensForETHSupportingFeeOnTransferTokens";
    }

    if (pathNorm.length < 2 || !rec) {
      return emptyResult({
        pattern,
        confidence: "low",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: [...notes, "Path length < 2 or invalid recipient — low confidence"],
      });
    }

    return {
      considered: true,
      confidence: "high",
      pattern,
      reliable: true,
      riskRelevant: true,
      knownPulsexRouter,
      multicallExpanded: false,
      notes,
      movements: [
        {
          token: pathNorm[0]!,
          amountRaw: amountIn.toString(),
          role: "swapExactIn",
          recipient: rec,
          path: pathNorm,
        },
      ],
    };
  } catch (err) {
    return emptyResult({
      pattern: "truncated",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: [
        `Router exact-in family decode failed (truncated or corrupt): ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    });
  }
}

function tryDecodeExactOut(
  hex: Hex,
  selector: string,
  knownPulsexRouter: boolean,
  valueWei: bigint,
  bodyLen: number,
): TokenNotionalInspection | null {
  const exactOut = new Set<string>([
    SELECTOR.swapTokensForExactTokens,
    SELECTOR.swapTokensForExactETH,
    SELECTOR.swapETHForExactTokens,
  ]);
  if (!exactOut.has(selector)) return null;

  if (bodyLen < 128) {
    return emptyResult({
      pattern: "truncated",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: ["Router exact-out selector with truncated arguments"],
    });
  }

  try {
    const decoded = decodeFunctionData({
      abi: routerExactOutAbi,
      data: hex,
    });
    const notes = routerNotes(knownPulsexRouter, [
      "Exact-out: notional uses amountInMax (or msg.value) as upper bound on spend",
      "Actual pull may be lower than amountInMax",
    ]);

    if (decoded.functionName === "swapETHForExactTokens") {
      const [, path, recipient] = decoded.args as [
        bigint,
        readonly `0x${string}`[],
        `0x${string}`,
        bigint,
      ];
      const pathNorm = normPath(path);
      const rec = asAddress(recipient);
      if (pathNorm.length < 2 || !rec) {
        return emptyResult({
          pattern: "router.swapETHForExactTokens",
          confidence: "low",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: [...notes, "Path length < 2 or invalid recipient — low confidence"],
        });
      }
      return {
        considered: true,
        confidence: "high",
        pattern: "router.swapETHForExactTokens",
        reliable: true,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: false,
        notes: [
          ...notes,
          "Native PLS upper bound is msg.value (legacy maxPls* fields are display-only under operator-trust)",
        ],
        movements: [
          {
            token: "native",
            amountRaw: valueWei.toString(),
            role: "nativeValue",
            recipient: rec,
            path: pathNorm,
          },
        ],
      };
    }

    const [, amountInMax, path, recipient] = decoded.args as [
      bigint,
      bigint,
      readonly `0x${string}`[],
      `0x${string}`,
      bigint,
    ];
    const pathNorm = normPath(path);
    const rec = asAddress(recipient);
    const pattern: TokenNotionalPattern =
      decoded.functionName === "swapTokensForExactETH"
        ? "router.swapTokensForExactETH"
        : "router.swapTokensForExactTokens";

    if (pathNorm.length < 2 || !rec) {
      return emptyResult({
        pattern,
        confidence: "low",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: [...notes, "Path length < 2 or invalid recipient — low confidence"],
      });
    }

    return {
      considered: true,
      confidence: "high",
      pattern,
      reliable: true,
      riskRelevant: true,
      knownPulsexRouter,
      multicallExpanded: false,
      notes,
      movements: [
        {
          token: pathNorm[0]!,
          amountRaw: amountInMax.toString(),
          role: "swapExactOutMaxIn",
          recipient: rec,
          path: pathNorm,
        },
      ],
    };
  } catch (err) {
    return emptyResult({
      pattern: "truncated",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: [
        `Router exact-out decode failed (truncated or corrupt): ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    });
  }
}

function tryDecodeMulticall(
  hex: Hex,
  selector: string,
  toLower: string,
  knownPulsexRouter: boolean,
  bodyLen: number,
  depth: number,
  outerValueWei: bigint,
): TokenNotionalInspection | null {
  const multi = new Set<string>([
    SELECTOR.multicallBytes,
    SELECTOR.multicallDeadlineBytes,
    SELECTOR.aggregate,
    SELECTOR.tryAggregate,
    SELECTOR.aggregate3,
  ]);
  if (!multi.has(selector)) return null;

  // Nested multicall: do not expand further
  if (depth >= 1) {
    return emptyResult({
      pattern:
        selector === SELECTOR.aggregate3
          ? "multicall.aggregate3"
          : selector === SELECTOR.aggregate
            ? "multicall.aggregate"
            : selector === SELECTOR.tryAggregate
              ? "multicall.tryAggregate"
              : selector === SELECTOR.multicallDeadlineBytes
                ? "multicall.deadlineBytes"
                : "multicall.bytes",
      confidence: "low",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      multicallExpanded: false,
      notes: [
        "Nested multicall detected at depth>0 — not expanded (one-level limit)",
      ],
    });
  }

  if (bodyLen < 64) {
    return emptyResult({
      pattern: "truncated",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: ["Multicall selector with truncated arguments"],
    });
  }

  const baseNotes: string[] = [];
  if (toLower === KNOWN_MULTICALL3) {
    baseNotes.push("Destination is Multicall3");
  }
  if (knownPulsexRouter) {
    baseNotes.push("Destination is a known PulseX V1/V2 router");
  }

  try {
    if (selector === SELECTOR.multicallBytes) {
      const decoded = decodeFunctionData({
        abi: multicallBytesAbi,
        data: hex,
      });
      const data = decoded.args[0] as readonly Hex[];
      return expandMulticall({
        pattern: "multicall.bytes",
        outerTo: toLower,
        knownPulsexRouter,
        outerValueWei,
        inners: (data ?? []).map((d) => ({
          target: toLower,
          data: d,
        })),
        notes: [
          ...baseNotes,
          "Self-multicall: each inner calldata targets the same contract as tx `to`",
        ],
      });
    }

    if (selector === SELECTOR.multicallDeadlineBytes) {
      const decoded = decodeFunctionData({
        abi: multicallDeadlineBytesAbi,
        data: hex,
      });
      const data = decoded.args[1] as readonly Hex[];
      return expandMulticall({
        pattern: "multicall.deadlineBytes",
        outerTo: toLower,
        knownPulsexRouter,
        outerValueWei,
        inners: (data ?? []).map((d) => ({
          target: toLower,
          data: d,
        })),
        notes: [
          ...baseNotes,
          "Self-multicall (deadline + bytes[]): inners target tx `to`",
        ],
      });
    }

    if (selector === SELECTOR.aggregate) {
      const decoded = decodeFunctionData({
        abi: aggregateAbi,
        data: hex,
      });
      const calls = decoded.args[0] as readonly {
        target: `0x${string}`;
        callData: Hex;
      }[];
      return expandMulticall({
        pattern: "multicall.aggregate",
        outerTo: toLower,
        knownPulsexRouter,
        outerValueWei,
        inners: (calls ?? []).map((c) => ({
          target: (asAddress(c.target) ?? c.target).toLowerCase(),
          data: c.callData,
        })),
        notes: [...baseNotes, "Multicall3-style aggregate: per-call target"],
      });
    }

    if (selector === SELECTOR.tryAggregate) {
      const decoded = decodeFunctionData({
        abi: tryAggregateAbi,
        data: hex,
      });
      const calls = decoded.args[1] as readonly {
        target: `0x${string}`;
        callData: Hex;
      }[];
      return expandMulticall({
        pattern: "multicall.tryAggregate",
        outerTo: toLower,
        knownPulsexRouter,
        outerValueWei,
        inners: (calls ?? []).map((c) => ({
          target: (asAddress(c.target) ?? c.target).toLowerCase(),
          data: c.callData,
        })),
        notes: [...baseNotes, "Multicall3 tryAggregate: per-call target"],
      });
    }

    // aggregate3
    const decoded = decodeFunctionData({
      abi: aggregate3Abi,
      data: hex,
    });
    const calls = decoded.args[0] as readonly {
      target: `0x${string}`;
      allowFailure: boolean;
      callData: Hex;
    }[];
    return expandMulticall({
      pattern: "multicall.aggregate3",
      outerTo: toLower,
      knownPulsexRouter,
      outerValueWei,
      inners: (calls ?? []).map((c) => ({
        target: (asAddress(c.target) ?? c.target).toLowerCase(),
        data: c.callData,
      })),
      notes: [...baseNotes, "Multicall3 aggregate3: per-call target"],
    });
  } catch (err) {
    return emptyResult({
      pattern: "truncated",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: [
        `Multicall decode failed (truncated or corrupt): ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    });
  }
}

/**
 * Inspect tx calldata for token movements / authorizations.
 * Pure: no RPC. Prefer high-confidence fixed layouts only.
 *
 * @param params._depth Internal multicall depth (0 = top-level; nested multicall not expanded).
 */
export function inspectTokenNotional(params: {
  to: string;
  data?: string;
  /** Native value (wei) — used for ETH-in swap amount surface */
  valueWei?: bigint | string;
  /** @internal multicall recursion depth; do not set from outside */
  _depth?: number;
}): TokenNotionalInspection {
  const toLower = (params.to ?? "").toLowerCase();
  const knownPulsexRouter = KNOWN_PULSEX_ROUTERS.has(toLower);
  const depth = params._depth ?? 0;

  if (isEmptyData(params.data)) {
    return emptyResult({
      pattern: "empty",
      confidence: "high",
      reliable: true,
      riskRelevant: false,
      knownPulsexRouter,
      notes: ["No calldata — native PLS value only (if any)"],
    });
  }

  const hex = normalizeHexData(params.data!);
  if (!hex) {
    return emptyResult({
      pattern: "invalid",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: ["Calldata is not valid even-length hex"],
    });
  }

  if (hex.length < 10) {
    return emptyResult({
      pattern: "truncated",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: ["Calldata shorter than a 4-byte selector"],
    });
  }

  const selector = hex.slice(0, 10) as string;
  const bodyLen = (hex.length - 10) / 2;
  const valueWei = parseValueWei(params.valueWei);

  // --- ERC-20 transfer ---
  if (selector === SELECTOR.transfer) {
    if (bodyLen < 64) {
      return emptyResult({
        pattern: "truncated",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: ["erc20.transfer selector with truncated arguments"],
      });
    }
    try {
      const decoded = decodeFunctionData({
        abi: erc20TransferAbi,
        data: hex,
      });
      const [recipient, amount] = decoded.args as [`0x${string}`, bigint];
      const rec = asAddress(recipient);
      if (!rec || !/^0x[0-9a-f]{40}$/.test(toLower)) {
        return emptyResult({
          pattern: "invalid",
          confidence: "none",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: ["erc20.transfer decode produced invalid addresses"],
        });
      }
      return {
        considered: true,
        confidence: "high",
        pattern: "erc20.transfer",
        reliable: true,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: false,
        notes: [
          "Token identity is the transaction `to` (ERC-20 contract)",
          "Amount is raw token units (decimals not resolved)",
        ],
        movements: [
          {
            token: toLower as `0x${string}`,
            amountRaw: amount.toString(),
            role: "transfer",
            recipient: rec,
          },
        ],
      };
    } catch (err) {
      return emptyResult({
        pattern: "invalid",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: [
          `erc20.transfer decode failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ],
      });
    }
  }

  // --- ERC-20 transferFrom ---
  if (selector === SELECTOR.transferFrom) {
    if (bodyLen < 96) {
      return emptyResult({
        pattern: "truncated",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: ["erc20.transferFrom selector with truncated arguments"],
      });
    }
    try {
      const decoded = decodeFunctionData({
        abi: erc20TransferFromAbi,
        data: hex,
      });
      const [from, recipient, amount] = decoded.args as [
        `0x${string}`,
        `0x${string}`,
        bigint,
      ];
      const fromA = asAddress(from);
      const rec = asAddress(recipient);
      if (!fromA || !rec || !/^0x[0-9a-f]{40}$/.test(toLower)) {
        return emptyResult({
          pattern: "invalid",
          confidence: "none",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: ["erc20.transferFrom decode produced invalid addresses"],
        });
      }
      return {
        considered: true,
        confidence: "high",
        pattern: "erc20.transferFrom",
        reliable: true,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: false,
        notes: [
          "Token identity is the transaction `to` (ERC-20 contract)",
          "Amount is raw token units (decimals not resolved)",
        ],
        movements: [
          {
            token: toLower as `0x${string}`,
            amountRaw: amount.toString(),
            role: "transferFrom",
            from: fromA,
            recipient: rec,
          },
        ],
      };
    } catch (err) {
      return emptyResult({
        pattern: "invalid",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: [
          `erc20.transferFrom decode failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ],
      });
    }
  }

  // --- ERC-20 approve ---
  if (selector === SELECTOR.approve) {
    if (bodyLen < 64) {
      return emptyResult({
        pattern: "truncated",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: ["erc20.approve selector with truncated arguments"],
      });
    }
    try {
      const decoded = decodeFunctionData({
        abi: erc20ApproveAbi,
        data: hex,
      });
      const [spender, amount] = decoded.args as [`0x${string}`, bigint];
      const sp = asAddress(spender);
      if (!sp || !/^0x[0-9a-f]{40}$/.test(toLower)) {
        return emptyResult({
          pattern: "invalid",
          confidence: "none",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: ["erc20.approve decode produced invalid addresses"],
        });
      }
      const notes = [
        "Approve authorizes spend — not an immediate transfer",
        "Token identity is the transaction `to` (ERC-20 contract)",
        "Amount is raw token units (decimals not resolved)",
      ];
      if (
        amount ===
        0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn
      ) {
        notes.push("Unlimited approve (type(uint256).max) detected");
      }
      return {
        considered: true,
        confidence: "high",
        pattern: "erc20.approve",
        reliable: true,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: false,
        notes,
        movements: [
          {
            token: toLower as `0x${string}`,
            amountRaw: amount.toString(),
            role: "approve",
            spender: sp,
          },
        ],
      };
    } catch (err) {
      return emptyResult({
        pattern: "invalid",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: [
          `erc20.approve decode failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ],
      });
    }
  }

  // --- WETH9 deposit (WPLS wrap): deposit() — notional = msg.value native ---
  if (selector === SELECTOR.deposit) {
    // WETH9 deposit has zero ABI args; any trailing calldata is non-standard.
    if (bodyLen !== 0) {
      return emptyResult({
        pattern: "invalid",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: [
          "weth.deposit selector must have no arguments (got trailing calldata)",
        ],
      });
    }
    if (!/^0x[0-9a-f]{40}$/.test(toLower)) {
      return emptyResult({
        pattern: "invalid",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: ["weth.deposit requires a valid contract destination"],
      });
    }
    // Confirm selector-only layout via viem (no args).
    try {
      decodeFunctionData({ abi: wethDepositAbi, data: hex });
    } catch (err) {
      return emptyResult({
        pattern: "invalid",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: [
          `weth.deposit decode failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ],
      });
    }
    const knownWpls = toLower === KNOWN_WPLS;
    const notes = [
      "WETH9-style deposit — wraps native PLS into the destination token",
      "Notional is msg.value (native); minted token is transaction `to`",
      "Amount is raw wei (decimals not resolved)",
    ];
    if (knownWpls) {
      notes.push("Destination is known WPLS");
    } else {
      notes.push(
        "Destination is not the known WPLS address (generic WETH9 layout)",
      );
    }
    return {
      considered: true,
      confidence: "high",
      pattern: "weth.deposit",
      reliable: true,
      riskRelevant: true,
      knownPulsexRouter,
      multicallExpanded: false,
      notes,
      movements: [
        {
          token: "native",
          amountRaw: valueWei.toString(),
          role: "deposit",
        },
      ],
    };
  }

  // --- WETH9 withdraw (WPLS unwrap): withdraw(uint256) — notional = wad of to ---
  if (selector === SELECTOR.withdraw) {
    if (bodyLen < 32) {
      return emptyResult({
        pattern: "truncated",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: ["weth.withdraw selector with truncated arguments"],
      });
    }
    try {
      const decoded = decodeFunctionData({
        abi: wethWithdrawAbi,
        data: hex,
      });
      const [wad] = decoded.args as [bigint];
      if (!/^0x[0-9a-f]{40}$/.test(toLower)) {
        return emptyResult({
          pattern: "invalid",
          confidence: "none",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: ["weth.withdraw requires a valid contract destination"],
        });
      }
      const knownWpls = toLower === KNOWN_WPLS;
      const notes = [
        "WETH9-style withdraw — burns wrapped token for native PLS",
        "Token identity is the transaction `to` (WPLS when known)",
        "Amount is raw token units (decimals not resolved)",
      ];
      if (knownWpls) {
        notes.push("Destination is known WPLS");
      } else {
        notes.push(
          "Destination is not the known WPLS address (generic WETH9 layout)",
        );
      }
      return {
        considered: true,
        confidence: "high",
        pattern: "weth.withdraw",
        reliable: true,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: false,
        notes,
        movements: [
          {
            token: toLower as `0x${string}`,
            amountRaw: wad.toString(),
            role: "withdraw",
          },
        ],
      };
    } catch (err) {
      return emptyResult({
        pattern: "invalid",
        confidence: "none",
        reliable: false,
        riskRelevant: true,
        knownPulsexRouter,
        notes: [
          `weth.withdraw decode failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ],
      });
    }
  }

  // --- Router exact-in family (incl. fee-on-transfer supporting) ---
  const exactIn = tryDecodeExactInFamily(
    hex,
    selector,
    knownPulsexRouter,
    valueWei,
    bodyLen,
  );
  if (exactIn) return exactIn;

  // --- Router exact-out ---
  const exactOut = tryDecodeExactOut(
    hex,
    selector,
    knownPulsexRouter,
    valueWei,
    bodyLen,
  );
  if (exactOut) return exactOut;

  // --- Router add/remove liquidity (UniV2 / PulseX fixed layouts) ---
  const liquidity = tryDecodeLiquidity(
    hex,
    selector,
    knownPulsexRouter,
    valueWei,
    bodyLen,
  );
  if (liquidity) return liquidity;

  // --- Multicall (one level) ---
  const multi = tryDecodeMulticall(
    hex,
    selector,
    toLower,
    knownPulsexRouter,
    bodyLen,
    depth,
    valueWei,
  );
  if (multi) return multi;

  return emptyResult({
    pattern: "unknown",
    confidence: "none",
    reliable: false,
    riskRelevant: true,
    knownPulsexRouter,
    notes: [
      `Unrecognized selector ${selector} — not in priority ERC-20 / WETH9 / router swap-liquidity / multicall set`,
      "No silent zero-notional assumption; policy may deny via requireDecodableCalldata",
    ],
  });
}

/**
 * UniV2 / PulseX router addLiquidity / addLiquidityETH / removeLiquidity / removeLiquidityETH.
 * add*: notional = desired amounts (upper bound of tokens that may be pulled).
 * remove*: LP share amount only (pair address not in calldata) — underlyings noted, not capped as ERC-20.
 */
function tryDecodeLiquidity(
  hex: Hex,
  selector: string,
  knownPulsexRouter: boolean,
  valueWei: bigint,
  bodyLen: number,
): TokenNotionalInspection | null {
  const liquiditySelectors = new Set<string>([
    SELECTOR.addLiquidity,
    SELECTOR.addLiquidityETH,
    SELECTOR.removeLiquidity,
    SELECTOR.removeLiquidityETH,
  ]);
  if (!liquiditySelectors.has(selector)) return null;

  // Minimum arg body sizes (approx): addLiquidity 8*32, addLiquidityETH 6*32,
  // removeLiquidity 7*32, removeLiquidityETH 6*32
  if (bodyLen < 6 * 32) {
    return emptyResult({
      pattern: "truncated",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: ["Router liquidity selector with truncated arguments"],
    });
  }

  try {
    const decoded = decodeFunctionData({
      abi: liquidityRouterAbi,
      data: hex,
    });

    if (decoded.functionName === "addLiquidity") {
      const [tokenA, tokenB, amountADesired, amountBDesired, , , to] =
        decoded.args as [
          `0x${string}`,
          `0x${string}`,
          bigint,
          bigint,
          bigint,
          bigint,
          `0x${string}`,
          bigint,
        ];
      const a = asAddress(tokenA);
      const b = asAddress(tokenB);
      const recipient = asAddress(to);
      if (!a || !b || !recipient) {
        return emptyResult({
          pattern: "invalid",
          confidence: "none",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: ["addLiquidity decode produced invalid addresses"],
        });
      }
      if (amountADesired < 0n || amountBDesired < 0n) {
        return emptyResult({
          pattern: "invalid",
          confidence: "none",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: ["addLiquidity negative desired amount"],
        });
      }
      return {
        considered: true,
        confidence: "high",
        reliable: true,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: false,
        pattern: "router.addLiquidity",
        notes: routerNotes(knownPulsexRouter, [
          "addLiquidity notional uses amountADesired/amountBDesired (upper bound; actual pull may be lower)",
        ]),
        movements: [
          {
            token: a,
            amountRaw: amountADesired.toString(),
            role: "addLiquidity",
            recipient,
            path: [a, b],
          },
          {
            token: b,
            amountRaw: amountBDesired.toString(),
            role: "addLiquidity",
            recipient,
            path: [a, b],
          },
        ],
      };
    }

    if (decoded.functionName === "addLiquidityETH") {
      const [token, amountTokenDesired, , , to] = decoded.args as [
        `0x${string}`,
        bigint,
        bigint,
        bigint,
        `0x${string}`,
        bigint,
      ];
      const t = asAddress(token);
      const recipient = asAddress(to);
      if (!t || !recipient) {
        return emptyResult({
          pattern: "invalid",
          confidence: "none",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: ["addLiquidityETH decode produced invalid addresses"],
        });
      }
      if (amountTokenDesired < 0n) {
        return emptyResult({
          pattern: "invalid",
          confidence: "none",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: ["addLiquidityETH negative amountTokenDesired"],
        });
      }
      const movements: TokenMovement[] = [
        {
          token: t,
          amountRaw: amountTokenDesired.toString(),
          role: "addLiquidity",
          recipient,
          path: [t],
        },
      ];
      if (valueWei > 0n) {
        movements.push({
          token: "native",
          amountRaw: valueWei.toString(),
          role: "addLiquidity",
          recipient,
          path: [t],
        });
      }
      return {
        considered: true,
        confidence: "high",
        reliable: true,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: false,
        pattern: "router.addLiquidityETH",
        notes: routerNotes(knownPulsexRouter, [
          "addLiquidityETH: token desired + msg.value native (upper bounds)",
          valueWei === 0n
            ? "WARNING: addLiquidityETH with zero msg.value — native leg notional is 0"
            : "native notional = outer msg.value (not amountETHMin)",
        ]),
        movements,
      };
    }

    if (decoded.functionName === "removeLiquidity") {
      const [tokenA, tokenB, liquidity, , , to] = decoded.args as [
        `0x${string}`,
        `0x${string}`,
        bigint,
        bigint,
        bigint,
        `0x${string}`,
        bigint,
      ];
      const a = asAddress(tokenA);
      const b = asAddress(tokenB);
      const recipient = asAddress(to);
      if (!a || !b || !recipient || liquidity < 0n) {
        return emptyResult({
          pattern: "invalid",
          confidence: "none",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: ["removeLiquidity decode produced invalid fields"],
        });
      }
      // LP pair address is not in calldata — cannot key erc20NotionalCaps by pair.
      // Still high-confidence pattern for requireDecodableCalldata; no underlying amount invent.
      return {
        considered: true,
        confidence: "high",
        reliable: true,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: false,
        pattern: "router.removeLiquidity",
        notes: routerNotes(knownPulsexRouter, [
          `removeLiquidity: burns ${liquidity.toString()} LP shares for pair (${a},${b}) → ${recipient}`,
          "LP pair address is not in calldata — underlying amounts not invented (mins only on-chain)",
          "erc20NotionalCaps on underlyings are NOT applied to LP share amount",
        ]),
        movements: [
          {
            // Informational: amount is LP shares; token field is first underlying for path context only
            token: a,
            amountRaw: "0",
            role: "removeLiquidity",
            recipient,
            path: [a, b],
          },
          {
            token: b,
            amountRaw: "0",
            role: "removeLiquidity",
            recipient,
            path: [a, b],
          },
        ],
      };
    }

    if (decoded.functionName === "removeLiquidityETH") {
      const [token, liquidity, , , to] = decoded.args as [
        `0x${string}`,
        bigint,
        bigint,
        bigint,
        `0x${string}`,
        bigint,
      ];
      const t = asAddress(token);
      const recipient = asAddress(to);
      if (!t || !recipient || liquidity < 0n) {
        return emptyResult({
          pattern: "invalid",
          confidence: "none",
          reliable: false,
          riskRelevant: true,
          knownPulsexRouter,
          notes: ["removeLiquidityETH decode produced invalid fields"],
        });
      }
      return {
        considered: true,
        confidence: "high",
        reliable: true,
        riskRelevant: true,
        knownPulsexRouter,
        multicallExpanded: false,
        pattern: "router.removeLiquidityETH",
        notes: routerNotes(knownPulsexRouter, [
          `removeLiquidityETH: burns ${liquidity.toString()} LP shares for token/WPLS pair → ${recipient}`,
          "LP pair address is not in calldata — underlying amounts not invented",
          "erc20NotionalCaps on underlyings are NOT applied to LP share amount",
        ]),
        movements: [
          {
            token: t,
            amountRaw: "0",
            role: "removeLiquidity",
            recipient,
            path: [t],
          },
        ],
      };
    }

    return emptyResult({
      pattern: "invalid",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: ["Liquidity family selector decode mismatch"],
    });
  } catch (err) {
    return emptyResult({
      pattern: "truncated",
      confidence: "none",
      reliable: false,
      riskRelevant: true,
      knownPulsexRouter,
      notes: [
        `Router liquidity decode failed (truncated or corrupt): ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    });
  }
}

/**
 * Helper for tests: encode multicall(bytes[]) with viem (same ABI as inspector).
 */
export function encodeMulticallBytes(datas: Hex[]): Hex {
  return encodeFunctionData({
    abi: multicallBytesAbi,
    functionName: "multicall",
    args: [datas],
  });
}

export function encodeAggregate3(
  calls: { target: `0x${string}`; allowFailure: boolean; callData: Hex }[],
): Hex {
  return encodeFunctionData({
    abi: aggregate3Abi,
    functionName: "aggregate3",
    args: [calls],
  });
}
