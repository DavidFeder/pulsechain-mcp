import type { AppConfig } from "../types.js";
import { ExplorerError, TimeoutError } from "../utils/errors.js";
import { assertAddress, assertTxHash } from "../utils/safety.js";

export interface ExplorerResponse<T = unknown> {
  status: string;
  message: string;
  result: T;
}

export interface ExplorerGetOptions {
  timeoutMs?: number;
}

/**
 * Build a fully qualified explorer API URL (exported for unit tests).
 */
export function buildExplorerUrl(
  baseApi: string,
  params: Record<string, string | number | undefined | null>,
): string {
  const url = new URL(baseApi);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * BlockScout REST client for api.scan.pulsechain.com
 * Compatible with Etherscan-style module/action query API.
 * Docs: https://api.scan.pulsechain.com/api-docs
 */
export async function explorerGet<T = unknown>(
  config: AppConfig,
  params: Record<string, string | number | undefined | null>,
  options: ExplorerGetOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? config.httpTimeoutMs;
  const url = buildExplorerUrl(config.explorerApi, params);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    if (!res.ok) {
      throw new ExplorerError(`HTTP ${res.status} for ${url}`, res.status);
    }

    let body: ExplorerResponse<T>;
    try {
      body = (await res.json()) as ExplorerResponse<T>;
    } catch {
      throw new ExplorerError("Invalid JSON response from explorer API");
    }

    // BlockScout / Etherscan style: status "0" indicates error, with some soft cases
    if (body.status === "0") {
      const msg = (body.message || "").toLowerCase();
      const soft =
        msg.includes("no transactions found") ||
        msg.includes("no token transfers found") ||
        msg.includes("no records found") ||
        msg.includes("not found");
      if (soft) {
        // Return empty-ish result rather than throwing
        return (Array.isArray(body.result) ? body.result : []) as T;
      }
      throw new ExplorerError(body.message || "Explorer API error");
    }

    return body.result;
  } catch (err) {
    if (err instanceof ExplorerError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError("explorer API", timeoutMs);
    }
    throw new ExplorerError(
      err instanceof Error ? err.message : "Explorer request failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export async function getAccountBalance(
  config: AppConfig,
  address: string,
): Promise<string> {
  const addr = assertAddress(address);
  return explorerGet<string>(config, {
    module: "account",
    action: "balance",
    address: addr,
  });
}

export async function getAccountTxList(
  config: AppConfig,
  address: string,
  page = 1,
  offset = 10,
  sort: "asc" | "desc" = "desc",
): Promise<unknown> {
  const addr = assertAddress(address);
  return explorerGet(config, {
    module: "account",
    action: "txlist",
    address: addr,
    startblock: "0",
    endblock: "99999999",
    page,
    offset,
    sort,
  });
}

export async function getAccountTokenTransfers(
  config: AppConfig,
  address: string,
  options: {
    contractAddress?: string;
    page?: number;
    offset?: number;
  } = {},
): Promise<unknown> {
  const addr = assertAddress(address);
  return explorerGet(config, {
    module: "account",
    action: "tokentx",
    address: addr,
    contractaddress: options.contractAddress
      ? assertAddress(options.contractAddress)
      : undefined,
    page: options.page ?? 1,
    offset: options.offset ?? 10,
    sort: "desc",
  });
}

export async function getAccountInternalTxs(
  config: AppConfig,
  address: string,
  page = 1,
  offset = 10,
  sort: "asc" | "desc" = "desc",
): Promise<unknown> {
  const addr = assertAddress(address);
  return explorerGet(config, {
    module: "account",
    action: "txlistinternal",
    address: addr,
    startblock: "0",
    endblock: "99999999",
    page,
    offset,
    sort,
  });
}

/**
 * BlockScout tokenlist for an address (ERC-20 balances known to explorer).
 * module=account&action=tokenlist
 */
export async function getAccountTokenList(
  config: AppConfig,
  address: string,
): Promise<unknown> {
  const addr = assertAddress(address);
  return explorerGet(config, {
    module: "account",
    action: "tokenlist",
    address: addr,
  });
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export async function getTokenInfo(
  config: AppConfig,
  contractAddress: string,
): Promise<unknown> {
  const addr = assertAddress(contractAddress);
  return explorerGet(config, {
    module: "token",
    action: "getToken",
    contractaddress: addr,
  });
}

// ---------------------------------------------------------------------------
// Contract creation (Etherscan-compatible)
// ---------------------------------------------------------------------------

/**
 * Contract creator + creation tx (BlockScout/Etherscan-compatible).
 * module=contract&action=getcontractcreation
 */
export async function getContractCreation(
  config: AppConfig,
  contractAddresses: string | string[],
): Promise<unknown> {
  const list = (
    Array.isArray(contractAddresses) ? contractAddresses : [contractAddresses]
  )
    .map((a) => assertAddress(a))
    .join(",");
  return explorerGet(config, {
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: list,
  });
}

/**
 * Paginated token holders via Etherscan-compatible module API.
 * Prefer getTokenHolders (BlockScout v2) when available; this is a fallback.
 * Result items typically: { address, value }.
 */
export async function getTokenHoldersModule(
  config: AppConfig,
  contractAddress: string,
  page = 1,
  offset = 50,
): Promise<unknown> {
  const addr = assertAddress(contractAddress);
  return explorerGet(config, {
    module: "token",
    action: "getTokenHolders",
    contractaddress: addr,
    page,
    offset,
  });
}

export async function getTokenSupply(
  config: AppConfig,
  contractAddress: string,
): Promise<unknown> {
  const addr = assertAddress(contractAddress);
  return explorerGet(config, {
    module: "stats",
    action: "tokensupply",
    contractaddress: addr,
  });
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

export async function getTransactionStatus(
  config: AppConfig,
  txHash: string,
): Promise<unknown> {
  const hash = assertTxHash(txHash);
  return explorerGet(config, {
    module: "transaction",
    action: "gettxinfo",
    txhash: hash,
  });
}

export async function getTransactionReceiptStatus(
  config: AppConfig,
  txHash: string,
): Promise<unknown> {
  const hash = assertTxHash(txHash);
  return explorerGet(config, {
    module: "transaction",
    action: "gettxreceiptstatus",
    txhash: hash,
  });
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface ExplorerLogWindow {
  fromBlock: number | string;
  toBlock: number | string;
  offset: number;
  page: number;
}

export const DEFAULT_GETLOGS_OFFSET = 100;
export const DEFAULT_GETLOGS_PAGE = 1;
export const EXPLORER_LOGS_NOT_FULL_HISTORY =
  "This getLogs page is a capped explorer window, not full history.";

/**
 * Machine-readable truncation for explorer getLogs pages.
 * `truncated` is true when the raw result is an array whose length hits offset.
 */
export function explorerLogsWindow(
  logs: unknown,
  options: {
    fromBlock?: number | string;
    toBlock?: number | string;
    page?: number;
    offset?: number;
  } = {},
): { truncated: boolean; window: ExplorerLogWindow } {
  const offset = options.offset ?? DEFAULT_GETLOGS_OFFSET;
  const page = options.page ?? DEFAULT_GETLOGS_PAGE;
  const fromBlock = options.fromBlock ?? 0;
  const toBlock = options.toBlock ?? "latest";
  return {
    truncated: Array.isArray(logs) && logs.length >= offset,
    window: { fromBlock, toBlock, offset, page },
  };
}

export async function getLogs(
  config: AppConfig,
  options: {
    address?: string;
    fromBlock?: number | string;
    toBlock?: number | string;
    topic0?: string;
    topic1?: string;
    topic0_1_opr?: "and" | "or";
    page?: number;
    offset?: number;
  },
): Promise<unknown> {
  return explorerGet(config, {
    module: "logs",
    action: "getLogs",
    address: options.address ? assertAddress(options.address) : undefined,
    fromBlock: options.fromBlock ?? 0,
    toBlock: options.toBlock ?? "latest",
    topic0: options.topic0,
    topic1: options.topic1,
    topic0_1_opr: options.topic0_1_opr,
    page: options.page ?? DEFAULT_GETLOGS_PAGE,
    offset: options.offset ?? DEFAULT_GETLOGS_OFFSET,
  });
}

// ---------------------------------------------------------------------------
// Block / stats
// ---------------------------------------------------------------------------

export async function getBlockReward(
  config: AppConfig,
  blockNumber: number,
): Promise<unknown> {
  return explorerGet(config, {
    module: "block",
    action: "getblockreward",
    blockno: blockNumber,
  });
}

export async function getEthSupply(config: AppConfig): Promise<unknown> {
  // On PulseChain this is PLS supply via same endpoint name
  return explorerGet(config, {
    module: "stats",
    action: "ethsupply",
  });
}

// ---------------------------------------------------------------------------
// Contract (Etherscan-compatible)
// ---------------------------------------------------------------------------

export interface ContractSourceResult {
  SourceCode?: string;
  ABI?: string;
  ContractName?: string;
  CompilerVersion?: string;
  OptimizationUsed?: string;
  Runs?: string;
  ConstructorArguments?: string;
  EVMVersion?: string;
  Library?: string;
  LicenseType?: string;
  Proxy?: string;
  Implementation?: string;
  SwarmSource?: string;
  Address?: string;
}

export async function getContractSourceCode(
  config: AppConfig,
  address: string,
): Promise<ContractSourceResult[]> {
  const addr = assertAddress(address);
  const result = await explorerGet<ContractSourceResult[] | ContractSourceResult>(
    config,
    {
      module: "contract",
      action: "getsourcecode",
      address: addr,
    },
  );
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object") return [result];
  return [];
}

export async function getContractAbi(
  config: AppConfig,
  address: string,
): Promise<string> {
  const addr = assertAddress(address);
  const result = await explorerGet<string>(config, {
    module: "contract",
    action: "getabi",
    address: addr,
  });
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

// ---------------------------------------------------------------------------
// BlockScout REST v2 (holders, richer token metadata)
// Base: https://api.scan.pulsechain.com/api/v2/...
// ---------------------------------------------------------------------------

function explorerV2Base(config: AppConfig): string {
  // config.explorerApi is typically .../api — strip trailing /api for v2 root
  const api = config.explorerApi.replace(/\/+$/, "");
  if (api.endsWith("/api")) {
    return api.slice(0, -4);
  }
  return api;
}

export async function explorerV2Get<T = unknown>(
  config: AppConfig,
  path: string,
  query: Record<string, string | number | undefined | null> = {},
  options: ExplorerGetOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? config.httpTimeoutMs;
  const base = explorerV2Base(config);
  const url = new URL(`${base}/api/v2${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new ExplorerError(
        `HTTP ${res.status} for BlockScout v2 ${path}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ExplorerError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError("explorer API v2", timeoutMs);
    }
    throw new ExplorerError(
      err instanceof Error ? err.message : "Explorer v2 request failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface TokenHolderItem {
  address: {
    hash: string;
    is_contract?: boolean;
    name?: string | null;
    is_verified?: boolean | null;
  };
  value: string;
  token?: {
    address?: string;
    decimals?: string;
    holders?: string;
    name?: string;
    symbol?: string;
    total_supply?: string;
  };
}

export async function getTokenHolders(
  config: AppConfig,
  contractAddress: string,
  options: { limit?: number } = {},
): Promise<{
  items: TokenHolderItem[];
  next_page_params?: unknown;
}> {
  const addr = assertAddress(contractAddress);
  // BlockScout v2 returns ~50 by default; items_count is soft
  return explorerV2Get(config, `/tokens/${addr}/holders`, {
    items_count: options.limit ?? 50,
  });
}

export async function getTokenInfoV2(
  config: AppConfig,
  contractAddress: string,
): Promise<{
  address: string;
  name?: string;
  symbol?: string;
  decimals?: string;
  total_supply?: string;
  holders?: string;
  type?: string;
  circulating_market_cap?: string | null;
  exchange_rate?: string | null;
  icon_url?: string | null;
}> {
  const addr = assertAddress(contractAddress);
  return explorerV2Get(config, `/tokens/${addr}`);
}

// ---------------------------------------------------------------------------
// Soft-fail enriched helpers (agent-friendly; never throw for tool handlers)
// ---------------------------------------------------------------------------

export interface ExplorerSoftFail {
  ok: false;
  source: "blockscout";
  reason: string;
  status?: number;
  path?: string;
  warnings?: string[];
}

export interface ExplorerSoftSuccess<T> {
  ok: true;
  source: "blockscout";
  data: T;
  partial?: boolean;
  warnings?: string[];
}

export type ExplorerSoftResult<T> = ExplorerSoftSuccess<T> | ExplorerSoftFail;

function explorerSoftFail(
  reason: string,
  extra: Partial<ExplorerSoftFail> = {},
): ExplorerSoftFail {
  return { ok: false, source: "blockscout", reason, ...extra };
}

function errMsg(err: unknown): string {
  if (err instanceof ExplorerError) {
    return err.status != null
      ? `${err.message} (HTTP ${err.status})`
      : err.message;
  }
  if (err instanceof TimeoutError) return err.message;
  if (err instanceof Error) return err.message;
  return "Explorer request failed";
}

export interface TokenOverviewData {
  contractAddress: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: string | null;
  totalSupply?: string | null;
  holdersCount?: string | number | null;
  type?: string | null;
  exchangeRate?: string | null;
  circulatingMarketCap?: string | null;
  /** Top holders sample when available (address + value). */
  topHolders: Array<{ address: string; value: string }>;
  sourcesUsed: string[];
  note: string;
}

/**
 * Richer token overview: v1 getToken and/or v2 metadata + holders sample.
 * Fail-soft; partial success when only one path works.
 */
export async function getTokenOverviewSoft(
  config: AppConfig,
  contractAddress: string,
  options: { holderLimit?: number } = {},
): Promise<ExplorerSoftResult<TokenOverviewData>> {
  const addr = assertAddress(contractAddress);
  const warnings: string[] = [];
  const sourcesUsed: string[] = [];
  let name: string | null = null;
  let symbol: string | null = null;
  let decimals: string | null = null;
  let totalSupply: string | null = null;
  let holdersCount: string | number | null = null;
  let type: string | null = null;
  let exchangeRate: string | null = null;
  let circulatingMarketCap: string | null = null;
  const topHolders: Array<{ address: string; value: string }> = [];

  try {
    const info = await getTokenInfo(config, addr);
    if (info && typeof info === "object") {
      const rec = info as Record<string, unknown>;
      name = typeof rec.name === "string" ? rec.name : name;
      symbol = typeof rec.symbol === "string" ? rec.symbol : symbol;
      decimals =
        rec.decimals != null ? String(rec.decimals) : decimals;
      totalSupply =
        rec.totalSupply != null
          ? String(rec.totalSupply)
          : rec.total_supply != null
            ? String(rec.total_supply)
            : totalSupply;
      holdersCount =
        rec.holders != null
          ? (rec.holders as string | number)
          : rec.holderCount != null
            ? (rec.holderCount as string | number)
            : holdersCount;
      type = typeof rec.type === "string" ? rec.type : type;
      sourcesUsed.push("explorer_getToken");
    }
  } catch (err) {
    warnings.push(`getToken: ${errMsg(err)}`);
  }

  try {
    const v2 = await getTokenInfoV2(config, addr);
    if (v2) {
      name = v2.name ?? name;
      symbol = v2.symbol ?? symbol;
      decimals = v2.decimals ?? decimals;
      totalSupply = v2.total_supply ?? totalSupply;
      holdersCount = v2.holders ?? holdersCount;
      type = v2.type ?? type;
      exchangeRate = v2.exchange_rate ?? exchangeRate;
      circulatingMarketCap =
        v2.circulating_market_cap ?? circulatingMarketCap;
      sourcesUsed.push("explorer_v2_tokens");
    }
  } catch (err) {
    warnings.push(`getTokenInfoV2: ${errMsg(err)}`);
  }

  const holderLimit = Math.min(Math.max(options.holderLimit ?? 10, 1), 50);
  try {
    const holders = await getTokenHolders(config, addr, { limit: holderLimit });
    if (holders?.items?.length) {
      for (const h of holders.items.slice(0, holderLimit)) {
        const a = h.address?.hash;
        if (a) topHolders.push({ address: a, value: String(h.value ?? "0") });
      }
      sourcesUsed.push("explorer_v2_holders");
    }
  } catch (err) {
    warnings.push(`getTokenHolders: ${errMsg(err)}`);
    // Fallback: module API
    try {
      const mod = await getTokenHoldersModule(config, addr, 1, holderLimit);
      if (Array.isArray(mod)) {
        for (const row of mod.slice(0, holderLimit)) {
          if (row && typeof row === "object") {
            const r = row as Record<string, unknown>;
            const a =
              typeof r.address === "string"
                ? r.address
                : typeof (r.address as { hash?: string })?.hash === "string"
                  ? (r.address as { hash: string }).hash
                  : null;
            if (a) {
              topHolders.push({
                address: a,
                value: String(r.value ?? r.balance ?? "0"),
              });
            }
          }
        }
        if (topHolders.length) sourcesUsed.push("explorer_module_holders");
      }
    } catch (err2) {
      warnings.push(`getTokenHoldersModule: ${errMsg(err2)}`);
    }
  }

  if (sourcesUsed.length === 0) {
    return explorerSoftFail(
      "All BlockScout token overview sources failed",
      { path: `/tokens/${addr}`, warnings },
    );
  }

  return {
    ok: true,
    source: "blockscout",
    partial: sourcesUsed.length < 2 || topHolders.length === 0,
    warnings: warnings.length ? warnings : undefined,
    data: {
      contractAddress: addr,
      name,
      symbol,
      decimals,
      totalSupply,
      holdersCount,
      type,
      exchangeRate,
      circulatingMarketCap,
      topHolders,
      sourcesUsed,
      note:
        "BlockScout public explorer data (scan.pulsechain.com). " +
        "Holder lists and counters can lag; not a price oracle.",
    },
  };
}

export interface ContractAbiData {
  address: string;
  verified: boolean;
  abi: unknown;
  abiRaw?: string;
  contractName?: string | null;
  compilerVersion?: string | null;
  optimizationUsed?: string | null;
  proxy?: string | null;
  implementation?: string | null;
  sourcesUsed: string[];
  note: string;
}

/**
 * Verified contract ABI (+ light verification meta). Fail-soft.
 * Truncates huge ABIs only via parse; returns full ABI JSON when available.
 */
export async function getContractAbiSoft(
  config: AppConfig,
  address: string,
): Promise<ExplorerSoftResult<ContractAbiData>> {
  const addr = assertAddress(address);
  const warnings: string[] = [];
  const sourcesUsed: string[] = [];
  let abiRaw = "";
  let contractName: string | null = null;
  let compilerVersion: string | null = null;
  let optimizationUsed: string | null = null;
  let proxy: string | null = null;
  let implementation: string | null = null;

  try {
    abiRaw = await getContractAbi(config, addr);
    if (abiRaw && abiRaw !== "Contract source code not verified") {
      sourcesUsed.push("explorer_getabi");
    } else {
      warnings.push("getabi: contract not verified or empty ABI");
      abiRaw = "";
    }
  } catch (err) {
    warnings.push(`getabi: ${errMsg(err)}`);
  }

  try {
    const src = await getContractSourceCode(config, addr);
    const first = src[0];
    if (first) {
      sourcesUsed.push("explorer_getsourcecode");
      contractName = first.ContractName ?? null;
      compilerVersion = first.CompilerVersion ?? null;
      optimizationUsed = first.OptimizationUsed ?? null;
      proxy = first.Proxy ?? null;
      implementation = first.Implementation ?? null;
      if (!abiRaw && first.ABI && first.ABI !== "Contract source code not verified") {
        abiRaw = first.ABI;
      }
    }
  } catch (err) {
    warnings.push(`getsourcecode: ${errMsg(err)}`);
  }

  if (!abiRaw && sourcesUsed.length === 0) {
    return explorerSoftFail("Could not load contract ABI from BlockScout", {
      path: `contract/getabi:${addr}`,
      warnings,
    });
  }

  let abi: unknown = null;
  let verified = false;
  if (abiRaw) {
    try {
      abi = JSON.parse(abiRaw);
      verified = Array.isArray(abi) && abi.length > 0;
    } catch {
      abi = abiRaw;
      verified = abiRaw.length > 2 && !/not verified/i.test(abiRaw);
    }
  }

  return {
    ok: true,
    source: "blockscout",
    partial: !verified,
    warnings: warnings.length ? warnings : undefined,
    data: {
      address: addr,
      verified,
      abi,
      abiRaw: typeof abi === "string" ? abiRaw : undefined,
      contractName,
      compilerVersion,
      optimizationUsed,
      proxy,
      implementation,
      sourcesUsed,
      note:
        "Verified ABI from BlockScout (Etherscan-compatible). " +
        "Unverified contracts return verified=false. Proxy fields when reported.",
    },
  };
}

export interface AddressActivityData {
  address: string;
  tokenTransfers: unknown[];
  internalTxs: unknown[];
  sourcesUsed: string[];
  note: string;
}

/**
 * Token transfer + internal-tx history sample for an address. Fail-soft.
 */
export async function getAddressActivitySoft(
  config: AppConfig,
  address: string,
  options: {
    page?: number;
    offset?: number;
    contractAddress?: string;
    includeInternal?: boolean;
  } = {},
): Promise<ExplorerSoftResult<AddressActivityData>> {
  const addr = assertAddress(address);
  const page = options.page ?? 1;
  const offset = Math.min(Math.max(options.offset ?? 10, 1), 50);
  const warnings: string[] = [];
  const sourcesUsed: string[] = [];
  let tokenTransfers: unknown[] = [];
  let internalTxs: unknown[] = [];

  try {
    const transfers = await getAccountTokenTransfers(config, addr, {
      contractAddress: options.contractAddress,
      page,
      offset,
    });
    tokenTransfers = Array.isArray(transfers) ? transfers : [];
    sourcesUsed.push("explorer_tokentx");
  } catch (err) {
    warnings.push(`tokentx: ${errMsg(err)}`);
  }

  if (options.includeInternal !== false) {
    try {
      const internal = await getAccountInternalTxs(
        config,
        addr,
        page,
        offset,
        "desc",
      );
      internalTxs = Array.isArray(internal) ? internal : [];
      sourcesUsed.push("explorer_txlistinternal");
    } catch (err) {
      warnings.push(`txlistinternal: ${errMsg(err)}`);
    }
  }

  if (sourcesUsed.length === 0) {
    return explorerSoftFail(
      "BlockScout address activity sources failed",
      { path: `account/activity:${addr}`, warnings },
    );
  }

  return {
    ok: true,
    source: "blockscout",
    partial: warnings.length > 0,
    warnings: warnings.length ? warnings : undefined,
    data: {
      address: addr,
      tokenTransfers,
      internalTxs,
      sourcesUsed,
      note:
        "Recent ERC-20 transfers and internal txs from BlockScout (paginated samples). " +
        "Not a full archive; empty arrays can mean no activity or upstream gaps.",
    },
  };
}

/**
 * Event logs via explorer module API with soft-fail envelope.
 */
export async function getLogsSoft(
  config: AppConfig,
  options: {
    address?: string;
    fromBlock?: number | string;
    toBlock?: number | string;
    topic0?: string;
    topic1?: string;
    topic0_1_opr?: "and" | "or";
    page?: number;
    offset?: number;
  },
): Promise<
  ExplorerSoftResult<{
    logs: unknown[];
    count: number;
    truncated: boolean;
    window: ExplorerLogWindow;
    note: string;
  }>
> {
  const offset = options.offset ?? DEFAULT_GETLOGS_OFFSET;
  const page = options.page ?? DEFAULT_GETLOGS_PAGE;
  const fromBlock = options.fromBlock ?? 0;
  const toBlock = options.toBlock ?? "latest";
  try {
    const logs = await getLogs(config, {
      ...options,
      offset,
      page,
      fromBlock,
      toBlock,
    });
    const arr = Array.isArray(logs) ? logs : [];
    const { truncated, window } = explorerLogsWindow(logs, {
      fromBlock,
      toBlock,
      page,
      offset,
    });
    return {
      ok: true,
      source: "blockscout",
      data: {
        logs: arr,
        count: arr.length,
        truncated,
        window,
        note: EXPLORER_LOGS_NOT_FULL_HISTORY,
      },
    };
  } catch (err) {
    return explorerSoftFail(errMsg(err), {
      path: "logs/getLogs",
    });
  }
}
