import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  type Address,
  type ContractFunctionParameters,
  type Hex,
} from "viem";
import {
  CORE_TOKENS,
  KNOWN_TOKENS_BY_ADDRESS,
  tokenLabelFields,
  type TokenInfo,
} from "../constants.js";
import type { AppConfig, Erc20Metadata, TokenBalance } from "../types.js";
import { RpcError } from "../utils/errors.js";
import { assertAddress } from "../utils/safety.js";
import { getPublicClient } from "./rpc.js";

/**
 * Batch read via client.multicall (uses Multicall3 under the hood on PulseChain).
 */
export async function multicallRead(
  config: AppConfig,
  contracts: readonly ContractFunctionParameters[],
  allowFailure = true,
): Promise<
  Array<{ status: "success" | "failure"; result?: unknown; error?: Error }>
> {
  try {
    const client = getPublicClient(config);
    const results = await client.multicall({
      contracts: contracts as ContractFunctionParameters[],
      allowFailure,
    });
    return results as Array<{
      status: "success" | "failure";
      result?: unknown;
      error?: Error;
    }>;
  } catch (err) {
    throw new RpcError(
      err instanceof Error ? err.message : "multicall failed",
    );
  }
}

/** Encode balanceOf(owner) calldata for packing / tests. */
export function encodeBalanceOf(owner: Address): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

/** Encode decimals() calldata. */
export function encodeDecimals(): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "decimals",
  });
}

/** Encode symbol() calldata. */
export function encodeSymbol(): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "symbol",
  });
}

/** Encode name() calldata. */
export function encodeName(): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "name",
  });
}

/**
 * Build multicall contract params for ERC-20 balanceOf across tokens for one owner.
 */
export function packErc20BalanceCalls(
  tokens: readonly Address[],
  owner: Address,
): ContractFunctionParameters[] {
  return tokens.map((token) => ({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf" as const,
    args: [owner] as const,
  }));
}

/**
 * Build multicall params for name/symbol/decimals for one token.
 */
export function packErc20MetadataCalls(
  token: Address,
): ContractFunctionParameters[] {
  return [
    {
      address: token,
      abi: erc20Abi,
      functionName: "name" as const,
    },
    {
      address: token,
      abi: erc20Abi,
      functionName: "symbol" as const,
    },
    {
      address: token,
      abi: erc20Abi,
      functionName: "decimals" as const,
    },
  ];
}

/** Lookup known token registry by address (core + forked pDAI). Pure / unit-testable. */
export function knownCoreToken(address: string): TokenInfo | undefined {
  const lower = address.toLowerCase();
  return (
    KNOWN_TOKENS_BY_ADDRESS[lower] ??
    Object.values(CORE_TOKENS).find((t) => t.address.toLowerCase() === lower)
  );
}

/**
 * Merge on-chain ERC-20 metadata with CORE_TOKENS fallback.
 * Prefer successful on-chain fields; when decimals/name/symbol are missing,
 * fill from the core registry (HEX = 8, USDC = 6, etc.) instead of silent 18.
 * Pure / unit-testable.
 */
export function mergeErc20Metadata(
  tokenAddress: string,
  onChain: {
    name?: string;
    symbol?: string;
    decimals?: number | null;
  },
): {
  name?: string;
  symbol?: string;
  decimals: number;
  knownSymbol?: string;
  metadataSource: "rpc" | "core_registry" | "mixed" | "default";
} {
  const known = knownCoreToken(tokenAddress);
  const onChainDecimals =
    onChain.decimals !== undefined &&
    onChain.decimals !== null &&
    Number.isFinite(onChain.decimals) &&
    onChain.decimals >= 0 &&
    onChain.decimals <= 36
      ? Math.floor(onChain.decimals)
      : undefined;

  const decimals = onChainDecimals ?? known?.decimals ?? 18;
  const name = onChain.name ?? known?.name;
  const symbol = onChain.symbol ?? known?.symbol;

  let metadataSource: "rpc" | "core_registry" | "mixed" | "default";
  if (onChainDecimals !== undefined && onChain.name && onChain.symbol) {
    metadataSource = "rpc";
  } else if (
    onChainDecimals === undefined &&
    !onChain.name &&
    !onChain.symbol &&
    known
  ) {
    metadataSource = "core_registry";
  } else if (onChainDecimals !== undefined || onChain.name || onChain.symbol) {
    metadataSource = known ? "mixed" : "rpc";
  } else {
    metadataSource = known ? "core_registry" : "default";
  }

  return {
    name,
    symbol,
    decimals,
    knownSymbol: known?.displaySymbol ?? known?.symbol,
    metadataSource,
  };
}

/**
 * Count ERC-20 rows with a confirmed non-zero balance.
 * Ignores failed reads (`balanceOk === false`) even if balanceRaw is non-zero,
 * so summary counts never treat RPC failures as holdings.
 * Pure / unit-testable.
 */
export function countNonZeroSuccessfulBalances(
  balances: ReadonlyArray<{ balanceRaw?: string; balanceOk?: boolean }>,
): number {
  return balances.filter(
    (b) =>
      b.balanceOk !== false &&
      b.balanceRaw !== undefined &&
      b.balanceRaw !== null &&
      String(b.balanceRaw) !== "0",
  ).length;
}

/**
 * Assemble a TokenBalance from raw balance + optional metadata.
 * Never zeros a successful balanceRaw; formats with resolved decimals.
 * Failed reads surface balanceOk=false + balanceError so callers can
 * distinguish RPC failure from a confirmed zero holding.
 * Pure / unit-testable.
 *
 * When the address is in the known catalog, `knownSymbol` prefers
 * `displaySymbol` (e.g. pDAI, pHEX) so agents can disambiguate fork assets
 * even when on-chain `symbol` still says DAI/HEX.
 */
export function assembleTokenBalance(params: {
  token: Address;
  owner: Address;
  balanceRaw: string | bigint | null | undefined;
  balanceOk: boolean;
  name?: string;
  symbol?: string;
  decimals?: number | null;
}): TokenBalance & { knownSymbol?: string; metadataSource?: string } {
  const balanceRaw =
    params.balanceOk && params.balanceRaw !== undefined && params.balanceRaw !== null
      ? params.balanceRaw.toString()
      : "0";

  const meta = mergeErc20Metadata(params.token, {
    name: params.name,
    symbol: params.symbol,
    decimals: params.decimals,
  });

  let balanceFormatted: string | undefined;
  try {
    balanceFormatted = formatUnits(BigInt(balanceRaw), meta.decimals);
  } catch {
    balanceFormatted = balanceRaw;
  }

  const identity = tokenLabelFields(params.token) ?? {};
  return {
    token: params.token,
    owner: params.owner,
    balanceRaw,
    decimals: meta.decimals,
    name: meta.name,
    symbol: meta.symbol,
    balanceFormatted,
    knownSymbol: meta.knownSymbol,
    metadataSource: meta.metadataSource,
    balanceOk: params.balanceOk,
    ...(params.balanceOk
      ? {}
      : { balanceError: "balance_read_failed" as const }),
    ...identity,
  };
}

/** Fetch ERC-20 name, symbol, decimals via multicall (+ core registry fallback). */
export async function getErc20Metadata(
  config: AppConfig,
  tokenAddress: string,
): Promise<Erc20Metadata> {
  const token = assertAddress(tokenAddress);
  const known = knownCoreToken(token);

  try {
    const results = await multicallRead(config, packErc20MetadataCalls(token));
    const [nameR, symbolR, decimalsR] = results;

    const onChain = {
      name: nameR?.status === "success" ? String(nameR.result) : undefined,
      symbol:
        symbolR?.status === "success" ? String(symbolR.result) : undefined,
      decimals:
        decimalsR?.status === "success"
          ? Number(decimalsR.result)
          : undefined,
    };

    const merged = mergeErc20Metadata(token, onChain);

    // If we got nothing on-chain and nothing known, hard-fail like before
    if (
      nameR?.status !== "success" &&
      symbolR?.status !== "success" &&
      decimalsR?.status !== "success" &&
      !known
    ) {
      throw new RpcError(
        `Failed to read ERC-20 metadata for ${token}. Is it a valid token contract?`,
      );
    }

    return {
      address: token,
      name: merged.name ?? "Unknown",
      symbol: merged.symbol ?? "UNKNOWN",
      decimals: merged.decimals,
    };
  } catch (err) {
    if (known) {
      return {
        address: token,
        name: known.name,
        symbol: known.symbol,
        decimals: known.decimals,
      };
    }
    if (err instanceof RpcError) throw err;
    throw new RpcError(
      err instanceof Error ? err.message : "ERC-20 metadata read failed",
    );
  }
}

/**
 * Batch ERC-20 balanceOf for many tokens owned by one address.
 *
 * Robust path (v0.1.21+):
 * 1. Multicall balances only (no metadata mixed in — avoids partial-decode pollution)
 * 2. Retry any failed balanceOf individually
 * 3. Separate multicall for metadata when requested
 * 4. CORE_TOKENS fallback for decimals/name/symbol (HEX=8, not silent 18)
 */
export async function batchErc20Balances(
  config: AppConfig,
  ownerAddress: string,
  tokenAddresses: string[],
  withMetadata = true,
): Promise<TokenBalance[]> {
  const owner = assertAddress(ownerAddress);
  if (tokenAddresses.length === 0) return [];

  const tokens = tokenAddresses.map((t) => assertAddress(t));
  const balanceCalls = packErc20BalanceCalls(tokens, owner);

  // 1) Balances-only multicall
  let balanceResults: Array<{
    status: "success" | "failure";
    result?: unknown;
    error?: Error;
  }>;
  try {
    balanceResults = await multicallRead(config, balanceCalls);
  } catch {
    // Whole multicall failed — fall back to per-token reads
    balanceResults = tokens.map(() => ({
      status: "failure" as const,
    }));
  }

  // 2) Retry failures individually so one bad token does not zero the portfolio
  const client = getPublicClient(config);
  const balanceRaws: Array<{ ok: boolean; raw: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const bal = balanceResults[i];
    if (bal?.status === "success" && bal.result !== undefined) {
      balanceRaws.push({ ok: true, raw: (bal.result as bigint).toString() });
      continue;
    }
    try {
      const result = await client.readContract({
        address: tokens[i]!,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      });
      balanceRaws.push({ ok: true, raw: (result as bigint).toString() });
    } catch {
      balanceRaws.push({ ok: false, raw: "0" });
    }
  }

  // 3) Metadata multicall (separate) when requested
  const metaByIndex: Array<{
    name?: string;
    symbol?: string;
    decimals?: number;
  }> = tokens.map(() => ({}));

  if (withMetadata) {
    try {
      const metadataCalls = tokens.flatMap((token) =>
        packErc20MetadataCalls(token),
      );
      const metaResults = await multicallRead(config, metadataCalls);
      for (let i = 0; i < tokens.length; i++) {
        const base = i * 3;
        const nameR = metaResults[base];
        const symbolR = metaResults[base + 1];
        const decimalsR = metaResults[base + 2];
        if (nameR?.status === "success") {
          metaByIndex[i]!.name = String(nameR.result);
        }
        if (symbolR?.status === "success") {
          metaByIndex[i]!.symbol = String(symbolR.result);
        }
        if (decimalsR?.status === "success") {
          metaByIndex[i]!.decimals = Number(decimalsR.result);
        }
      }
    } catch {
      // Metadata optional — core registry / defaults still apply in assemble
    }
  }

  // 4) Assemble with core-token decimal/name/symbol fallback
  return tokens.map((token, i) => {
    const br = balanceRaws[i]!;
    const meta = metaByIndex[i]!;
    if (withMetadata) {
      return assembleTokenBalance({
        token,
        owner,
        balanceRaw: br.raw,
        balanceOk: br.ok,
        name: meta.name,
        symbol: meta.symbol,
        decimals: meta.decimals,
      });
    }
    // Balance-only: still apply core decimals so callers don't default to 18
    const merged = mergeErc20Metadata(token, {});
    return {
      token,
      owner,
      balanceRaw: br.ok ? br.raw : "0",
      decimals: merged.decimals,
      name: merged.name,
      symbol: merged.symbol,
      balanceOk: br.ok,
      ...(br.ok ? {} : { balanceError: "balance_read_failed" as const }),
    };
  });
}

/**
 * Batch native PLS balances for many addresses via parallel getBalance
 * (Multicall3 getEthBalance can be used; this keeps a simple path + RPC multicall).
 */
export async function batchNativeBalances(
  config: AppConfig,
  addresses: string[],
): Promise<{ address: Address; balanceWei: string; balancePls: string }[]> {
  const addrs = addresses.map((a) => assertAddress(a));
  const client = getPublicClient(config);
  const results = await Promise.all(
    addrs.map(async (address) => {
      const balance = await client.getBalance({ address });
      return {
        address,
        balanceWei: balance.toString(),
        balancePls: formatUnits(balance, 18),
      };
    }),
  );
  return results;
}
