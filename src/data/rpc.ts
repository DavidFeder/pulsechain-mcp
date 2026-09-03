import {
  createPublicClient,
  formatEther,
  type Address,
  type EstimateGasParameters,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { pulsechain, pulsechainV4 } from "viem/chains";
import {
  DEFAULT_EXPLORER_API,
  DEFAULT_PULSEX_SUBGRAPH_V1,
  DEFAULT_PULSEX_SUBGRAPH_V2,
} from "../constants.js";
import type { AppConfig, NetworkMismatchInfo } from "../types.js";
import { RpcError, mapUnknownError } from "../utils/errors.js";
import { assertAddress, assertTxHash } from "../utils/safety.js";
import {
  createMultiRpcTransport,
  getActiveRpcUrl,
  getMultiRpcState,
  getRpcHealthSummary,
  getRpcStatusSnapshot,
  probeRpcEndpoints,
  resetMultiRpcState,
  setMultiRpcFetch,
} from "./multiRpc.js";

let client: PublicClient | undefined;
let transport: Transport | undefined;
/** Fingerprint of urls + timeout + network used to build `client`. */
let clientKey: string | undefined;

function clientCacheKey(config: AppConfig): string {
  return `${config.network}|${config.httpTimeoutMs}|${config.rpcUrls.join(",")}`;
}

/** viem chain for this config — used by both public reads and wallet signing. */
export function chainForConfig(config: Pick<AppConfig, "network">) {
  return config.network === "testnet" ? pulsechainV4 : pulsechain;
}

/** Numeric chain id for this config (mainnet 369 / testnet 943). */
export function chainIdForConfig(config: Pick<AppConfig, "network">): number {
  return chainForConfig(config).id;
}

export const TESTNET_MAINNET_DEFAULTS_WARNING =
  "PULSECHAIN_NETWORK=testnet (chain 943) but explorer and/or PulseX subgraph URLs still use the mainnet defaults (scan.pulsechain.com / graph.pulsechain.com). This server does not invent unofficial testnet subgraph hosts — set PULSECHAIN_EXPLORER_API and PULSEX_SUBGRAPH_V1/V2 if you have official testnet endpoints.";

/**
 * When testnet still points explorer/subgraph at shipped mainnet defaults.
 * Returns `undefined` on mainnet and on testnet with all three URLs overridden.
 */
export function networkMismatchForConfig(
  config: Pick<
    AppConfig,
    "network" | "explorerApi" | "pulseXSubgraphV1" | "pulseXSubgraphV2"
  >,
): NetworkMismatchInfo | undefined {
  if (config.network !== "testnet") return undefined;
  const explorerApiIsMainnetDefault = config.explorerApi === DEFAULT_EXPLORER_API;
  const pulseXSubgraphV1IsMainnetDefault =
    config.pulseXSubgraphV1 === DEFAULT_PULSEX_SUBGRAPH_V1;
  const pulseXSubgraphV2IsMainnetDefault =
    config.pulseXSubgraphV2 === DEFAULT_PULSEX_SUBGRAPH_V2;
  if (
    !explorerApiIsMainnetDefault &&
    !pulseXSubgraphV1IsMainnetDefault &&
    !pulseXSubgraphV2IsMainnetDefault
  ) {
    return undefined;
  }
  return {
    warning: TESTNET_MAINNET_DEFAULTS_WARNING,
    explorerApiIsMainnetDefault,
    pulseXSubgraphV1IsMainnetDefault,
    pulseXSubgraphV2IsMainnetDefault,
  };
}

export const MAINNET_ONLY_AGGREGATOR_WARNING =
  "Piteas / Switch / PulseSwap quotes are PulseChain mainnet-only (chain 369) and are not valid for this server's testnet (943). Reported chainId is the aggregator's chain, not the configured network.";

/** Tool-result warnings when a mainnet-only aggregator is used on testnet. */
export function mainnetOnlyAggregatorWarnings(
  config: Pick<AppConfig, "network">,
): string[] | undefined {
  return config.network === "testnet"
    ? [MAINNET_ONLY_AGGREGATOR_WARNING]
    : undefined;
}

function ensureClient(config: AppConfig): void {
  const key = clientCacheKey(config);
  if (!client || !transport || clientKey !== key) {
    // Preserve test-injected fetch across client rebuilds
    const existingFetch = getMultiRpcState()?.fetchFn;
    transport = createMultiRpcTransport({
      urls: config.rpcUrls.length > 0 ? config.rpcUrls : [config.rpcUrl],
      timeoutMs: config.httpTimeoutMs,
      fetchFn: existingFetch,
    });
    client = createPublicClient({
      chain: chainForConfig(config),
      transport,
    });
    clientKey = key;
  }
}

/**
 * Build (or reuse) a PublicClient with multi-RPC failover transport.
 * All chain/analytics RPC reads should go through this.
 */
export function getPublicClient(config: AppConfig): PublicClient {
  ensureClient(config);
  return client!;
}

/** Multi-RPC-aware transport for wallet clients (sendTransaction, etc.). */
export function getRpcTransport(config: AppConfig): Transport {
  ensureClient(config);
  return transport!;
}

export function resetRpcClient(): void {
  client = undefined;
  transport = undefined;
  clientKey = undefined;
  resetMultiRpcState();
}

export {
  getActiveRpcUrl,
  getMultiRpcState,
  getRpcHealthSummary,
  getRpcStatusSnapshot,
  probeRpcEndpoints,
  setMultiRpcFetch,
  resetMultiRpcState,
};

export async function getBlockNumber(config: AppConfig): Promise<bigint> {
  try {
    return await getPublicClient(config).getBlockNumber();
  } catch (err) {
    throw mapUnknownError(err, "getBlockNumber");
  }
}

export async function getNativeBalance(
  config: AppConfig,
  address: string,
): Promise<{ address: `0x${string}`; balanceWei: string; balancePls: string }> {
  const addr = assertAddress(address);
  try {
    const balance = await getPublicClient(config).getBalance({ address: addr });
    return {
      address: addr,
      balanceWei: balance.toString(),
      balancePls: formatEther(balance),
    };
  } catch (err) {
    throw new RpcError(
      err instanceof Error ? err.message : "Failed to fetch balance",
    );
  }
}

export async function getBlock(
  config: AppConfig,
  blockNumberOrTag?: bigint | "latest" | "earliest" | "pending",
): Promise<{
  number: string | null;
  hash: string | null;
  timestamp: string;
  parentHash: string;
  miner: string;
  gasUsed: string;
  gasLimit: string;
  baseFeePerGas: string | null;
  transactions: string[] | number;
}> {
  try {
    const client = getPublicClient(config);
    const block =
      blockNumberOrTag === undefined || blockNumberOrTag === "latest"
        ? await client.getBlock({ blockTag: "latest" })
        : typeof blockNumberOrTag === "bigint"
          ? await client.getBlock({ blockNumber: blockNumberOrTag })
          : await client.getBlock({ blockTag: blockNumberOrTag });

    return {
      number: block.number !== null ? block.number.toString() : null,
      hash: block.hash,
      timestamp: block.timestamp.toString(),
      parentHash: block.parentHash,
      miner: block.miner,
      gasUsed: block.gasUsed.toString(),
      gasLimit: block.gasLimit.toString(),
      baseFeePerGas:
        block.baseFeePerGas !== null && block.baseFeePerGas !== undefined
          ? block.baseFeePerGas.toString()
          : null,
      // Return count for large blocks; full hash list can be huge
      transactions: Array.isArray(block.transactions)
        ? block.transactions.length
        : 0,
    };
  } catch (err) {
    throw new RpcError(
      err instanceof Error ? err.message : "Failed to fetch block",
    );
  }
}

export async function getTransaction(
  config: AppConfig,
  hash: string,
): Promise<Record<string, unknown>> {
  const txHash = assertTxHash(hash);
  try {
    const tx = await getPublicClient(config).getTransaction({ hash: txHash });
    if (!tx) {
      throw new RpcError(`Transaction not found: ${txHash}`);
    }
    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: tx.value.toString(),
      nonce: tx.nonce,
      gas: tx.gas.toString(),
      gasPrice: tx.gasPrice !== undefined ? tx.gasPrice.toString() : undefined,
      maxFeePerGas:
        tx.maxFeePerGas !== undefined ? tx.maxFeePerGas.toString() : undefined,
      maxPriorityFeePerGas:
        tx.maxPriorityFeePerGas !== undefined
          ? tx.maxPriorityFeePerGas.toString()
          : undefined,
      input: tx.input,
      blockNumber:
        tx.blockNumber !== null && tx.blockNumber !== undefined
          ? tx.blockNumber.toString()
          : null,
      blockHash: tx.blockHash,
      transactionIndex: tx.transactionIndex,
      type: tx.type,
      chainId: tx.chainId,
    };
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw new RpcError(
      err instanceof Error ? err.message : "Failed to fetch transaction",
    );
  }
}

export async function getTransactionReceipt(
  config: AppConfig,
  hash: string,
): Promise<Record<string, unknown> | null> {
  const txHash = assertTxHash(hash);
  try {
    const receipt = await getPublicClient(config).getTransactionReceipt({
      hash: txHash,
    });
    if (!receipt) return null;
    return {
      transactionHash: receipt.transactionHash,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      from: receipt.from,
      to: receipt.to,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      contractAddress: receipt.contractAddress,
      logsCount: receipt.logs.length,
    };
  } catch (err) {
    throw new RpcError(
      err instanceof Error ? err.message : "Failed to fetch receipt",
    );
  }
}

export async function estimateGas(
  config: AppConfig,
  params: {
    to?: string;
    from?: string;
    data?: string;
    value?: string;
  },
): Promise<{ gasEstimate: string }> {
  try {
    const estimateParams: EstimateGasParameters = {};
    if (params.to) estimateParams.to = assertAddress(params.to);
    if (params.from) estimateParams.account = assertAddress(params.from);
    if (params.data) estimateParams.data = params.data as Hex;
    if (params.value !== undefined) {
      estimateParams.value = BigInt(params.value);
    }
    const gas = await getPublicClient(config).estimateGas(estimateParams);
    return { gasEstimate: gas.toString() };
  } catch (err) {
    throw new RpcError(
      err instanceof Error ? err.message : "Failed to estimate gas",
    );
  }
}

export async function ethCall(
  config: AppConfig,
  params: {
    to: string;
    data: string;
    from?: string;
    value?: string;
    blockNumber?: bigint;
  },
): Promise<{ data: Hex }> {
  try {
    const client = getPublicClient(config);
    const data = await client.call({
      to: assertAddress(params.to),
      data: params.data as Hex,
      ...(params.from
        ? { account: assertAddress(params.from) }
        : {}),
      ...(params.value !== undefined ? { value: BigInt(params.value) } : {}),
      ...(params.blockNumber !== undefined
        ? { blockNumber: params.blockNumber }
        : {}),
    });
    return { data: (data.data ?? "0x") as Hex };
  } catch (err) {
    throw new RpcError(
      err instanceof Error ? err.message : "eth_call failed",
    );
  }
}

export async function getChainId(config: AppConfig): Promise<number> {
  try {
    const id = await getPublicClient(config).getChainId();
    return id;
  } catch (err) {
    throw new RpcError(
      err instanceof Error ? err.message : "Failed to fetch chain id",
    );
  }
}

export async function getGasPrice(config: AppConfig): Promise<{
  gasPriceWei: string;
}> {
  try {
    const price = await getPublicClient(config).getGasPrice();
    return { gasPriceWei: price.toString() };
  } catch (err) {
    throw new RpcError(
      err instanceof Error ? err.message : "Failed to fetch gas price",
    );
  }
}

/**
 * Current fee market data (legacy gasPrice + EIP-1559 fields when available).
 */
export async function getFeeData(config: AppConfig): Promise<{
  gasPriceWei: string;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
}> {
  try {
    const client = getPublicClient(config);
    const [gasPrice, fees] = await Promise.all([
      client.getGasPrice(),
      client.estimateFeesPerGas().catch(() => null),
    ]);
    return {
      gasPriceWei: gasPrice.toString(),
      maxFeePerGas:
        fees?.maxFeePerGas !== undefined && fees.maxFeePerGas !== null
          ? fees.maxFeePerGas.toString()
          : null,
      maxPriorityFeePerGas:
        fees?.maxPriorityFeePerGas !== undefined &&
        fees.maxPriorityFeePerGas !== null
          ? fees.maxPriorityFeePerGas.toString()
          : null,
    };
  } catch (err) {
    throw new RpcError(
      err instanceof Error ? err.message : "Failed to fetch fee data",
    );
  }
}

export type { Address, PublicClient };
