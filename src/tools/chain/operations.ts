/**
 * Interactive chain operations (testable, viem + explorer).
 * Pure helpers accept config / public client for unit tests with mocks.
 */

import {
  encodeFunctionData,
  formatEther,
  formatUnits,
  parseAbi,
  parseAbiItem,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  CORE_TOKENS,
  PULSECHAIN_CHAIN_ID,
  PULSECHAIN_NATIVE_DECIMALS,
  PULSECHAIN_NATIVE_SYMBOL,
  PULSEX_CONTRACTS,
  WPLS_ADDRESS,
  getTokenIdentityLabel,
  resolveCoreToken,
  tokenLabelFields,
  type TokenInfo,
} from "../../constants.js";
import {
  batchErc20Balances,
  getAccountTxList,
  getErc20Metadata,
  getFeeData,
  getNativeBalance,
  getPublicClient,
  getTransaction,
  getTransactionReceipt,
  estimateGas as rpcEstimateGas,
  getBlock as rpcGetBlock,
} from "../../data/index.js";
import type { AppConfig, TokenBalance } from "../../types.js";
import { AppError, RpcError } from "../../utils/errors.js";
import { assertAddress, assertTxHash } from "../../utils/safety.js";
import { erc20ApproveAbi, pulsexRouterAbi } from "./abis.js";

/** Warning attached to prepare_* tool descriptions and results. */
export const PREPARE_UNSIGNED_WARNING =
  "UNSIGNED ONLY: This tool builds a transaction payload and never signs or broadcasts. " +
  "Nothing is submitted unless agent wallet tools are enabled " +
  "(AGENT_WALLET_ENABLED=true, operator-trust when funded) and an explicit confirm step is used.";

export const PREPARE_SWAP_WARNINGS = [
  PREPARE_UNSIGNED_WARNING,
  "DEX swaps can fail, sandwich, or slip. Set amountOutMin / slippage carefully.",
  "Token approvals (ERC-20 approve) are separate transactions and are NOT auto-submitted.",
  "Verify router version (v1/v2), path, recipient, and deadline before signing elsewhere.",
] as const;

const NATIVE_SENTINELS = new Set([
  "native",
  "pls",
  "eth",
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

export function isNativeTokenRef(value: string): boolean {
  return NATIVE_SENTINELS.has(value.trim().toLowerCase());
}

/** Resolve 0x address or core token symbol (WPLS, HEX, EHEX, DAI, PDAI, WETH, …).
 * Symbol **DAI** → bridged DAI only; **PDAI** / **FORK_DAI** → forked pDAI.
 * **HEX** / **PHEX** → state-fork pHEX; **EHEX** → bridged eHEX.
 * **USDT** / **WETH** → bridged only; **FUSDT** / **FWETH** → state forks.
 */
export function resolveTokenAddress(tokenOrSymbol: string): Address {
  const raw = tokenOrSymbol.trim();
  if (isNativeTokenRef(raw)) {
    return WPLS_ADDRESS;
  }
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    return assertAddress(raw);
  }
  const core = resolveCoreToken(raw);
  if (core) return core.address;
  throw new AppError(
    `Unknown token "${tokenOrSymbol}". Use a 0x address or core symbol (${Object.keys(CORE_TOKENS).join(", ")}, PDAI, EHEX, FUSDT, FWETH). ` +
      `Note: DAI/USDT/WETH = bridged; PDAI/FUSDT/FWETH = state-fork; HEX/PHEX = pHEX fork; EHEX = bridged HEX.`,
    "VALIDATION_ERROR",
  );
}

export function defaultCoreTokenAddresses(): Address[] {
  return Object.values(CORE_TOKENS).map((t) => t.address);
}

export function coreTokenByAddress(address: string): TokenInfo | undefined {
  const lower = address.toLowerCase();
  // Include fork/bridged extras via KNOWN map through resolveCoreToken-adjacent lookup
  const label = getTokenIdentityLabel(lower);
  if (label) {
    const fromCore = Object.values(CORE_TOKENS).find(
      (t) => t.address.toLowerCase() === lower,
    );
    if (fromCore) return fromCore;
    // Non-core known identities (forked pDAI, eHEX, forked USDT/WETH)
    if (label.isForkDai) return resolveCoreToken("PDAI");
    if (label.isEhex) return resolveCoreToken("EHEX");
    if (label.isForkUsdt) return resolveCoreToken("FUSDT");
    if (label.isForkWeth) return resolveCoreToken("FWETH");
  }
  return Object.values(CORE_TOKENS).find(
    (t) => t.address.toLowerCase() === lower,
  );
}

export function routerAddressForVersion(
  version: "v1" | "v2" = "v2",
): Address {
  return version === "v1"
    ? PULSEX_CONTRACTS.v1.router
    : PULSEX_CONTRACTS.v2.router;
}

/**
 * Build a swap path. Default routes tokenIn → WPLS → tokenOut when needed.
 */
export function buildSwapPath(
  tokenIn: string,
  tokenOut: string,
  explicitPath?: string[],
): Address[] {
  if (explicitPath && explicitPath.length >= 2) {
    const path = explicitPath.map((a) => assertAddress(a));
    const expectedIn = resolveTokenAddress(tokenIn).toLowerCase();
    const expectedOut = resolveTokenAddress(tokenOut).toLowerCase();
    const pathIn = path[0]!.toLowerCase();
    const pathOut = path[path.length - 1]!.toLowerCase();
    if (pathIn !== expectedIn || pathOut !== expectedOut) {
      throw new AppError(
        `explicit path must start with tokenIn (${expectedIn}) and end with tokenOut (${expectedOut}); ` +
          `got ${pathIn} → ${pathOut}`,
        "VALIDATION_ERROR",
      );
    }
    return path;
  }
  const a = resolveTokenAddress(tokenIn);
  const b = resolveTokenAddress(tokenOut);
  if (a.toLowerCase() === b.toLowerCase()) {
    throw new AppError(
      "tokenIn and tokenOut resolve to the same address",
      "VALIDATION_ERROR",
    );
  }
  const wpls = WPLS_ADDRESS.toLowerCase();
  if (a.toLowerCase() === wpls || b.toLowerCase() === wpls) {
    return [a, b];
  }
  return [a, WPLS_ADDRESS, b];
}

export function parseAmountIn(amountIn: string): bigint {
  const s = amountIn.trim();
  if (!/^\d+$/.test(s)) {
    throw new AppError(
      "amountIn must be a positive integer string in token base units (wei)",
      "VALIDATION_ERROR",
    );
  }
  const n = BigInt(s);
  if (n <= 0n) {
    throw new AppError("amountIn must be > 0", "VALIDATION_ERROR");
  }
  return n;
}

/** Apply basis-point slippage to an amountOut (e.g. 50 = 0.5%). */
export function applySlippageBps(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new AppError(
      "slippageBps must be between 0 and 10000",
      "VALIDATION_ERROR",
    );
  }
  const bps = BigInt(Math.floor(slippageBps));
  return (amountOut * (10_000n - bps)) / 10_000n;
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export async function opGetBalance(config: AppConfig, address: string) {
  const data = await getNativeBalance(config, address);
  return {
    ...data,
    symbol: PULSECHAIN_NATIVE_SYMBOL,
    decimals: PULSECHAIN_NATIVE_DECIMALS,
    chainId: PULSECHAIN_CHAIN_ID,
  };
}

export async function opGetTokenBalance(
  config: AppConfig,
  owner: string,
  token: string,
) {
  const ownerAddr = assertAddress(owner);
  const tokenAddr = resolveTokenAddress(token);
  const [meta, balances] = await Promise.all([
    getErc20Metadata(config, tokenAddr),
    batchErc20Balances(config, ownerAddr, [tokenAddr], false),
  ]);
  const bal = balances[0];
  const balanceRaw = bal?.balanceRaw ?? "0";
  const balanceOk = bal?.balanceOk !== false && bal !== undefined;
  const identity = tokenLabelFields(tokenAddr);
  return {
    owner: ownerAddr,
    token: tokenAddr,
    name: meta.name,
    symbol: meta.symbol,
    decimals: meta.decimals,
    balanceRaw,
    balanceFormatted: formatUnits(BigInt(balanceRaw), meta.decimals),
    chainId: PULSECHAIN_CHAIN_ID,
    balanceOk,
    ...(balanceOk ? {} : { balanceError: bal?.balanceError ?? "balance_read_failed" }),
    ...(identity ?? {}),
  };
}

export async function opGetPortfolio(
  config: AppConfig,
  owner: string,
  tokens?: string[],
  includeNative = true,
) {
  const ownerAddr = assertAddress(owner);
  const tokenList =
    tokens && tokens.length > 0
      ? tokens.map((t) => resolveTokenAddress(t))
      : defaultCoreTokenAddresses();

  const unique = [
    ...new Map(tokenList.map((t) => [t.toLowerCase(), t])).values(),
  ];

  const [native, erc20] = await Promise.all([
    includeNative ? getNativeBalance(config, ownerAddr) : null,
    batchErc20Balances(config, ownerAddr, unique, true),
  ]);

  const tokensOut: Array<
    TokenBalance & {
      kind: "erc20" | "native";
      knownSymbol?: string;
      [key: string]: unknown;
    }
  > = erc20.map((b) => {
    const known = coreTokenByAddress(b.token);
    // Core registry is authoritative for known tokens (HEX=8, USDC=6, …).
    const decimals = known?.decimals ?? b.decimals;
    let balanceFormatted = b.balanceFormatted;
    if (known && decimals !== b.decimals && b.balanceRaw) {
      try {
        balanceFormatted = formatUnits(BigInt(b.balanceRaw), decimals);
      } catch {
        balanceFormatted = b.balanceFormatted;
      }
    }
    const identity = tokenLabelFields(b.token) ?? {};
    return {
      ...b,
      decimals,
      name: b.name ?? known?.name,
      symbol: b.symbol ?? known?.symbol,
      balanceFormatted,
      kind: "erc20" as const,
      knownSymbol:
        known?.displaySymbol ??
        known?.symbol ??
        (b as { knownSymbol?: string }).knownSymbol,
      ...identity,
    };
  });

  return {
    owner: ownerAddr,
    chainId: PULSECHAIN_CHAIN_ID,
    native: native
      ? {
          kind: "native" as const,
          symbol: PULSECHAIN_NATIVE_SYMBOL,
          decimals: PULSECHAIN_NATIVE_DECIMALS,
          balanceWei: native.balanceWei,
          balanceFormatted: native.balancePls,
          address: ownerAddr,
        }
      : null,
    tokens: tokensOut,
    tokenCount: tokensOut.length,
    dual_dai_note:
      "CORE portfolio uses bridged DAI (0xefD7…) as symbol DAI. Forked pDAI (0x6B17…) is a separate non-stable state-fork asset — never treat them as interchangeable.",
  };
}

// ---------------------------------------------------------------------------
// Transactions / blocks / gas
// ---------------------------------------------------------------------------

export async function opGetTransaction(config: AppConfig, hash: string) {
  const txHash = assertTxHash(hash);
  let tx: Record<string, unknown>;
  try {
    tx = await getTransaction(config, txHash);
  } catch (err) {
    throw err instanceof RpcError
      ? err
      : new RpcError(err instanceof Error ? err.message : "tx fetch failed");
  }

  let receipt: Record<string, unknown> | null = null;
  try {
    receipt = await getTransactionReceipt(config, txHash);
  } catch {
    receipt = null;
  }

  const status =
    receipt === null
      ? tx.blockNumber
        ? "unknown"
        : "pending"
      : receipt.status === "success"
        ? "success"
        : receipt.status === "reverted"
          ? "reverted"
          : String(receipt.status ?? "unknown");

  return {
    transaction: tx,
    receipt,
    status,
    chainId: PULSECHAIN_CHAIN_ID,
  };
}

export async function opGetTransactionHistory(
  config: AppConfig,
  address: string,
  page = 1,
  offset = 20,
) {
  const addr = assertAddress(address);
  const txs = await getAccountTxList(config, addr, page, offset, "desc");
  return {
    address: addr,
    page,
    offset,
    transactions: txs,
    chainId: PULSECHAIN_CHAIN_ID,
    source: "explorer",
  };
}

export async function opGetGasPrice(config: AppConfig) {
  const fees = await getFeeData(config);
  return {
    ...fees,
    chainId: PULSECHAIN_CHAIN_ID,
    gasPriceGwei: formatUnits(BigInt(fees.gasPriceWei), 9),
  };
}

export async function opEstimateGas(
  config: AppConfig,
  params: {
    to?: string;
    from?: string;
    data?: string;
    value?: string;
  },
) {
  const result = await rpcEstimateGas(config, params);
  const fees = await getFeeData(config).catch(() => null);
  return {
    ...result,
    feeData: fees,
    chainId: PULSECHAIN_CHAIN_ID,
  };
}

export async function opGetBlock(
  config: AppConfig,
  blockNumber?: string,
) {
  const block =
    blockNumber === undefined || blockNumber === "" || blockNumber === "latest"
      ? await rpcGetBlock(config, "latest")
      : await rpcGetBlock(config, BigInt(blockNumber));
  return { ...block, chainId: PULSECHAIN_CHAIN_ID };
}

// ---------------------------------------------------------------------------
// read_contract
// ---------------------------------------------------------------------------

/**
 * Normalize ABI input: JSON array string, ABI object array, or human-readable fragments.
 */
export function normalizeAbi(abiInput: unknown): Abi {
  if (typeof abiInput === "string") {
    const trimmed = abiInput.trim();
    if (trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed) as Abi;
      } catch {
        throw new AppError("Invalid ABI JSON string", "VALIDATION_ERROR");
      }
    }
    // Single human-readable fragment
    try {
      return [parseAbiItem(trimmed)] as Abi;
    } catch {
      throw new AppError(
        `Could not parse ABI fragment: ${trimmed}`,
        "VALIDATION_ERROR",
      );
    }
  }
  if (Array.isArray(abiInput)) {
    if (abiInput.length === 0) {
      throw new AppError("ABI array is empty", "VALIDATION_ERROR");
    }
    if (typeof abiInput[0] === "string") {
      try {
        return parseAbi(abiInput as string[]) as Abi;
      } catch {
        throw new AppError(
          "Could not parse human-readable ABI fragments",
          "VALIDATION_ERROR",
        );
      }
    }
    return abiInput as Abi;
  }
  throw new AppError(
    "abi must be a JSON ABI array, ABI object array, or human-readable fragment(s)",
    "VALIDATION_ERROR",
  );
}

export function normalizeArgs(args: unknown): unknown[] {
  if (args === undefined || args === null) return [];
  if (typeof args === "string") {
    const t = args.trim();
    if (t === "") return [];
    try {
      const parsed = JSON.parse(t) as unknown;
      if (!Array.isArray(parsed)) {
        throw new AppError("args JSON must be an array", "VALIDATION_ERROR");
      }
      return parsed;
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("args must be a JSON array string", "VALIDATION_ERROR");
    }
  }
  if (Array.isArray(args)) return args;
  throw new AppError("args must be an array", "VALIDATION_ERROR");
}

export async function opReadContract(
  config: AppConfig,
  params: {
    address: string;
    abi: unknown;
    functionName: string;
    args?: unknown;
    blockNumber?: string;
  },
  client?: PublicClient,
) {
  const address = assertAddress(params.address);
  const abi = normalizeAbi(params.abi);
  const args = normalizeArgs(params.args);
  const publicClient = client ?? getPublicClient(config);

  try {
    const result = await publicClient.readContract({
      address,
      abi,
      functionName: params.functionName,
      args: args as never,
      ...(params.blockNumber
        ? { blockNumber: BigInt(params.blockNumber) }
        : {}),
    });

    return {
      address,
      functionName: params.functionName,
      args,
      result: serializeViemResult(result),
      chainId: PULSECHAIN_CHAIN_ID,
    };
  } catch (err) {
    throw new RpcError(
      err instanceof Error ? err.message : "readContract failed",
    );
  }
}

function serializeViemResult(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeViemResult);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeViemResult(v);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// prepare_transaction
// ---------------------------------------------------------------------------

export async function opPrepareTransaction(
  config: AppConfig,
  params: {
    to: string;
    data?: string;
    value?: string;
    from?: string;
    gas?: string;
  },
) {
  const to = assertAddress(params.to);
  const from = params.from ? assertAddress(params.from) : undefined;
  const data = (params.data as Hex | undefined) ?? "0x";
  const value = params.value !== undefined ? BigInt(params.value) : 0n;

  let gasEstimate: string | undefined = params.gas;
  if (!gasEstimate) {
    try {
      const est = await rpcEstimateGas(config, {
        to,
        from,
        data,
        value: value.toString(),
      });
      gasEstimate = est.gasEstimate;
    } catch {
      gasEstimate = undefined;
    }
  }

  const fees = await getFeeData(config).catch(() => null);

  const unsignedTx = {
    chainId: PULSECHAIN_CHAIN_ID,
    to,
    data,
    value: value.toString(),
    valuePls: formatEther(value),
    from: from ?? null,
    gas: gasEstimate ?? null,
    gasPrice: fees?.gasPriceWei ?? null,
    maxFeePerGas: fees?.maxFeePerGas ?? null,
    maxPriorityFeePerGas: fees?.maxPriorityFeePerGas ?? null,
  };

  return {
    unsignedTransaction: unsignedTx,
    signed: false,
    broadcast: false,
    warnings: [PREPARE_UNSIGNED_WARNING],
  };
}

// ---------------------------------------------------------------------------
// PulseX quote / prepare_swap
// ---------------------------------------------------------------------------

export interface PulseXQuoteParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  path?: string[];
  version?: "v1" | "v2";
}

export interface PulseXQuoteResult {
  version: "v1" | "v2";
  router: Address;
  path: Address[];
  amountIn: string;
  amounts: string[];
  amountOut: string;
  tokenIn: Address;
  tokenOut: Address;
  chainId: number;
}

/**
 * Quote exact-in swap via PulseX router getAmountsOut.
 * Accepts optional publicClient for unit tests.
 */
export async function opPulsexQuote(
  config: AppConfig,
  params: PulseXQuoteParams,
  client?: PublicClient,
): Promise<PulseXQuoteResult> {
  const version = params.version === "v1" ? "v1" : "v2";
  const router = routerAddressForVersion(version);
  const path = buildSwapPath(params.tokenIn, params.tokenOut, params.path);
  const amountIn = parseAmountIn(params.amountIn);
  const publicClient = client ?? getPublicClient(config);

  try {
    const amounts = (await publicClient.readContract({
      address: router,
      abi: pulsexRouterAbi,
      functionName: "getAmountsOut",
      args: [amountIn, path],
    })) as readonly bigint[];

    const amountStrings = amounts.map((a) => a.toString());
    const amountOut = amountStrings[amountStrings.length - 1] ?? "0";

    return {
      version,
      router,
      path,
      amountIn: amountIn.toString(),
      amounts: amountStrings,
      amountOut,
      tokenIn: path[0]!,
      tokenOut: path[path.length - 1]!,
      chainId: PULSECHAIN_CHAIN_ID,
    };
  } catch (err) {
    throw new RpcError(
      err instanceof Error
        ? `PulseX getAmountsOut failed: ${err.message}`
        : "PulseX getAmountsOut failed",
    );
  }
}

export interface PrepareSwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  /** Recipient of output tokens (required). */
  recipient: string;
  path?: string[];
  version?: "v1" | "v2";
  /** Slippage in basis points (default 50 = 0.5%). */
  slippageBps?: number;
  /** Explicit min out (overrides slippage). */
  amountOutMin?: string;
  /** Unix deadline seconds (default now+20m). */
  deadline?: number;
  from?: string;
  /** When true, tokenIn is native PLS (uses swapExactETHForTokens). */
  nativeIn?: boolean;
  /** When true, tokenOut is native PLS (uses swapExactTokensForETH). */
  nativeOut?: boolean;
}

export async function opPrepareSwap(
  config: AppConfig,
  params: PrepareSwapParams,
  client?: PublicClient,
) {
  const version = params.version === "v1" ? "v1" : "v2";
  const router = routerAddressForVersion(version);
  const recipient = assertAddress(params.recipient);
  const from = params.from ? assertAddress(params.from) : undefined;
  const amountIn = parseAmountIn(params.amountIn);
  const path = buildSwapPath(params.tokenIn, params.tokenOut, params.path);

  const nativeIn =
    params.nativeIn === true || isNativeTokenRef(params.tokenIn);
  const nativeOut =
    params.nativeOut === true || isNativeTokenRef(params.tokenOut);

  if (nativeIn && nativeOut) {
    throw new AppError(
      "Cannot swap native PLS to native PLS",
      "VALIDATION_ERROR",
    );
  }

  // Ensure path starts/ends with WPLS for native legs
  if (nativeIn && path[0]!.toLowerCase() !== WPLS_ADDRESS.toLowerCase()) {
    throw new AppError(
      "nativeIn requires path to start with WPLS",
      "VALIDATION_ERROR",
    );
  }
  if (
    nativeOut &&
    path[path.length - 1]!.toLowerCase() !== WPLS_ADDRESS.toLowerCase()
  ) {
    throw new AppError(
      "nativeOut requires path to end with WPLS",
      "VALIDATION_ERROR",
    );
  }

  const quote = await opPulsexQuote(
    config,
    {
      tokenIn: path[0]!,
      tokenOut: path[path.length - 1]!,
      amountIn: amountIn.toString(),
      path,
      version,
    },
    client,
  );

  const quotedOut = BigInt(quote.amountOut);
  const slippageBps = params.slippageBps ?? 50;
  const amountOutMin =
    params.amountOutMin !== undefined
      ? BigInt(params.amountOutMin)
      : applySlippageBps(quotedOut, slippageBps);

  const deadline =
    params.deadline ??
    Math.floor(Date.now() / 1000) + 20 * 60; // 20 minutes

  let functionName:
    | "swapExactTokensForTokens"
    | "swapExactETHForTokens"
    | "swapExactTokensForETH";
  let data: Hex;
  let value = 0n;

  if (nativeIn) {
    functionName = "swapExactETHForTokens";
    value = amountIn;
    data = encodeFunctionData({
      abi: pulsexRouterAbi,
      functionName,
      args: [amountOutMin, path, recipient, BigInt(deadline)],
    });
  } else if (nativeOut) {
    functionName = "swapExactTokensForETH";
    data = encodeFunctionData({
      abi: pulsexRouterAbi,
      functionName,
      args: [amountIn, amountOutMin, path, recipient, BigInt(deadline)],
    });
  } else {
    functionName = "swapExactTokensForTokens";
    data = encodeFunctionData({
      abi: pulsexRouterAbi,
      functionName,
      args: [amountIn, amountOutMin, path, recipient, BigInt(deadline)],
    });
  }

  let gasEstimate: string | null = null;
  try {
    const est = await rpcEstimateGas(config, {
      to: router,
      from,
      data,
      value: value.toString(),
    });
    gasEstimate = est.gasEstimate;
  } catch {
    gasEstimate = null;
  }

  const fees = await getFeeData(config).catch(() => null);

  const approveCalldata =
    !nativeIn
      ? encodeFunctionData({
          abi: erc20ApproveAbi,
          functionName: "approve",
          args: [router, amountIn],
        })
      : null;

  return {
    version,
    router,
    functionName,
    path,
    amountIn: amountIn.toString(),
    amountOutQuoted: quote.amountOut,
    amountOutMin: amountOutMin.toString(),
    slippageBps,
    deadline,
    recipient,
    quote,
    unsignedTransaction: {
      chainId: PULSECHAIN_CHAIN_ID,
      to: router,
      data,
      value: value.toString(),
      from: from ?? null,
      gas: gasEstimate,
      gasPrice: fees?.gasPriceWei ?? null,
      maxFeePerGas: fees?.maxFeePerGas ?? null,
      maxPriorityFeePerGas: fees?.maxPriorityFeePerGas ?? null,
    },
    /** Suggested ERC-20 approve (separate unsigned tx) when swapping ERC-20 in. */
    suggestedApprove:
      approveCalldata && path[0]
        ? {
            to: path[0],
            data: approveCalldata,
            value: "0",
            spender: router,
            amount: amountIn.toString(),
            note: "Submit approve before swap if allowance is insufficient. Not auto-broadcast.",
          }
        : null,
    signed: false,
    broadcast: false,
    warnings: [...PREPARE_SWAP_WARNINGS],
  };
}
