/**
 * Read-only PulseX buy-and-burn status on chain 369.
 *
 * Checked against live RPC and BlockScout before these addresses were fixed:
 * - Proxy 0xd6cA7ee047a6F45d20d2962E4394E070cF27724F is an ERC1967Proxy
 *   (BlockScout contract name ERC1967Proxy).
 * - ERC-1967 implementation slot held
 *   0x5F02FbB0f8D924E9b67c7DAae523FF51175699f9
 *   (BlockScout contract name PLSXBuyAndBurnUpgradeable).
 * - That implementation's verified source has view `anyAuth` and public
 *   `convertLps`. It has no `paused()`, `enabled()`, or `buyAndBurn`.
 * - `convertLps` swaps held fee tokens toward PLSX and calls `PLSX.burn`.
 *   OpenZeppelin burn emits Transfer to the zero address. It does not
 *   transfer PLSX to the dead address.
 * - PLSX() on the proxy returned the catalog PLSX token.
 * - WPLS() returned catalog WPLS.
 *
 * This module's ABI is view-only. It does not encode buyAndBurn, convertLps,
 * or any other write.
 */

import {
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  BRIDGED_DAI_ADDRESS,
  BRIDGED_WETH_ADDRESS,
  EWBTC_ADDRESS,
  HEX_ADDRESS,
  INC_ADDRESS,
  KNOWN_TOKENS_BY_ADDRESS,
  PLSX_ADDRESS,
  PULSECHAIN_CHAIN_ID,
  USDC_FROM_ETH_ADDRESS,
  USDT_FROM_ETH_ADDRESS,
  WPLS_ADDRESS,
} from "../constants.js";
import type { AppConfig } from "../types.js";
import { AppError, PolicyError, RpcError } from "../utils/errors.js";
import { getAccountTokenTransfers } from "./explorer.js";
import { getChainId, getPublicClient } from "./rpc.js";
import { fetchToken } from "./subgraph.js";

/** ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const satisfies Hex;

export const PULSEX_BUY_AND_BURN_PROXY =
  "0xd6cA7ee047a6F45d20d2962E4394E070cF27724F" as const satisfies Address;

/** Implementation at the ERC-1967 slot when this reader was checked. */
export const PULSEX_BUY_AND_BURN_IMPLEMENTATION_SEEN =
  "0x5F02FbB0f8D924E9b67c7DAae523FF51175699f9" as const satisfies Address;

export const PULSEX_BURN_DEAD_ADDRESS =
  "0x000000000000000000000000000000000000dEaD" as const satisfies Address;

/**
 * Catalog tokens balanceOf'd on the buyback, besides PLSX (reported on its own).
 * Not an LP-token enumeration.
 */
export const PULSEX_BUY_AND_BURN_KNOWN_FEE_TOKENS = [
  WPLS_ADDRESS,
  HEX_ADDRESS,
  INC_ADDRESS,
  BRIDGED_DAI_ADDRESS,
  USDC_FROM_ETH_ADDRESS,
  USDT_FROM_ETH_ADDRESS,
  BRIDGED_WETH_ADDRESS,
  EWBTC_ADDRESS,
] as const;

export const FEE_TOKEN_BALANCE_CAP = 8;

/** View fragments only. No buyAndBurn, convertLps, or other writes. */
export const PULSEX_BUY_AND_BURN_READ_FRAGMENTS = [
  "function paused() view returns (bool)",
  "function enabled() view returns (bool)",
  "function anyAuth() view returns (bool)",
  "function PLSX() view returns (address)",
  "function WPLS() view returns (address)",
] as const;

export const PULSEX_BUY_AND_BURN_TOOL_DESCRIPTION =
  "Read-only PulseX buy-and-burn status on chain 369. " +
  "Reads the buyback proxy: paused() or enabled() when that view exists, PLSX balances of the dead address and the buyback, native PLS, and a capped fee-token list. " +
  "Does not call buyAndBurn, convertLps, or any other write. " +
  "Contract read, not financial advice. Not a price promise and not proof the next call will succeed.";

const FEE_SPLIT_NOTE =
  "21% of PulseX fees can fund this; 76% to LPs. " +
  "The caller who converts those fees pays gas. On the checked implementation the public entry is convertLps, not a function named buyAndBurn. " +
  "This is not a price promise and not proof the next call will succeed.";

const MECHANISM_NOTE =
  "Checked implementation PLSXBuyAndBurnUpgradeable swaps fee tokens toward PLSX inside convertLps and then calls PLSX.burn. " +
  "That burn emits a PLSX Transfer to the zero address and reduces supply. It does not send PLSX to the dead address. " +
  "This tool does not call convertLps, buyAndBurn, or any other write.";

const DEAD_BALANCE_NOTE =
  "PLSX balance of the dead address is every PLSX sitting there, not only buyback burns.";

const BUYBACK_PLSX_NOTE =
  "PLSX still held by the buyback proxy (bought or received, not yet burned). Separate from the dead-address balance.";

const ZERO_BALANCE_NOTE =
  "PLSX.burn does not leave a balance at the zero address. A burn still shows up as a Transfer to the zero address.";

export type RunningState = true | false | "unknown";

export interface RunningReading {
  running: RunningState;
  /** Successful view that decided `running`. Null when neither view returned a boolean. */
  view: "paused()" | "enabled()" | null;
  checked: readonly ["paused()", "enabled()"];
  note: string;
}

export function interpretBuyAndBurnRunning(input: {
  paused: boolean | null;
  enabled: boolean | null;
}): RunningReading {
  const checked = ["paused()", "enabled()"] as const;
  if (typeof input.paused === "boolean") {
    if (input.paused) {
      return {
        running: false,
        view: "paused()",
        checked,
        note:
          "paused() is true. Fees may be sitting in the contract, and burns are not happening until someone can call it again.",
      };
    }
    return {
      running: true,
      view: "paused()",
      checked,
      note:
        "paused() is false. Fees still sit until a caller pays gas to convert them. " +
        "This does not mean every trade burns PLSX, and it is not proof the next call will succeed.",
    };
  }
  if (typeof input.enabled === "boolean") {
    if (!input.enabled) {
      return {
        running: false,
        view: "enabled()",
        checked,
        note:
          "enabled() is false. Fees may be sitting in the contract, and burns are not happening until someone can call it again.",
      };
    }
    return {
      running: true,
      view: "enabled()",
      checked,
      note:
        "enabled() is true. Fees still sit until a caller pays gas to convert them. " +
        "This does not mean every trade burns PLSX, and it is not proof the next call will succeed.",
    };
  }
  return {
    running: "unknown",
    view: null,
    checked,
    note:
      "paused() and enabled() did not return a boolean (absent or reverted on this implementation). " +
      "running is unknown. anyAuth is not treated as a pause flag.",
  };
}

export function addressFromImplementationSlot(slot: string | null | undefined): Address {
  if (typeof slot !== "string" || !/^0x[0-9a-fA-F]*$/.test(slot)) {
    throw new PolicyError(
      "Refusing PulseX buy-and-burn read: ERC-1967 implementation slot was not hex.",
    );
  }
  const body = slot.slice(2).padStart(64, "0");
  if (body.length !== 64) {
    throw new PolicyError(
      "Refusing PulseX buy-and-burn read: ERC-1967 implementation slot is not 32 bytes.",
    );
  }
  let implementation: Address;
  try {
    implementation = getAddress(`0x${body.slice(-40)}`);
  } catch {
    throw new PolicyError(
      "Refusing PulseX buy-and-burn read: ERC-1967 implementation slot is not an address.",
    );
  }
  if (implementation === zeroAddress) {
    throw new PolicyError(
      "Refusing PulseX buy-and-burn read: ERC-1967 implementation is the zero address.",
    );
  }
  return implementation;
}

export function assertCatalogPlsx(address: string | null | undefined): Address {
  if (typeof address !== "string" || !isAddress(address)) {
    throw new PolicyError(
      "Refusing PulseX buy-and-burn read: PLSX() did not return an address. The PLSX token was not guessed.",
    );
  }
  const plsx = getAddress(address);
  if (plsx !== getAddress(PLSX_ADDRESS)) {
    throw new PolicyError(
      `Refusing PulseX buy-and-burn read: PLSX() returned ${plsx}, not catalog PLSX ${getAddress(PLSX_ADDRESS)}.`,
    );
  }
  return plsx;
}

export interface FeeTokenCandidate {
  address: string;
  balanceRaw: bigint | null;
  source: "abi" | "known-list";
}

export interface FeeTokenRow {
  address: Address;
  symbol: string | null;
  displaySymbol: string | null;
  origin: string | null;
  source: "abi" | "known-list";
  /** "catalogued" when the address is in the repo token catalog. Otherwise "unverified". */
  label: "catalogued" | "unverified";
  decimals: number | null;
  balanceRaw: string | null;
  /** Null when decimals are unknown or the balanceOf failed. Never a guessed decimal scaling. */
  balance: string | null;
  readFailed: boolean;
}

export interface FeeTokenPlanEntry {
  address: Address;
  source: "abi" | "known-list";
}

/**
 * WPLS from the ABI view, plus the small catalog. PLSX is omitted here because
 * the report has its own buyback PLSX balance. Duplicate addresses collapse to
 * the ABI source.
 */
export function feeTokenReadPlan(wplsFromAbi: string | null): FeeTokenPlanEntry[] {
  const rows: FeeTokenPlanEntry[] = [];
  const seen = new Set<string>();
  const push = (address: string, source: "abi" | "known-list") => {
    if (!isAddress(address)) {
      throw new PolicyError(
        "Refusing PulseX buy-and-burn read: fee-token address is not a valid address.",
      );
    }
    const checksum = getAddress(address);
    const key = checksum.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ address: checksum, source });
  };
  if (wplsFromAbi) push(wplsFromAbi, "abi");
  for (const address of PULSEX_BUY_AND_BURN_KNOWN_FEE_TOKENS) {
    push(address, "known-list");
  }
  if (rows.some((row) => row.address === getAddress(PLSX_ADDRESS))) {
    throw new PolicyError(
      "Refusing PulseX buy-and-burn read: PLSX was included in the fee-token list.",
    );
  }
  return rows;
}

export function selectFeeTokenBalances(
  rows: readonly FeeTokenCandidate[],
  cap = FEE_TOKEN_BALANCE_CAP,
): { tokens: FeeTokenRow[]; truncated: boolean; cap: number } {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new PolicyError(
      "Refusing PulseX buy-and-burn read: fee-token cap is not a positive integer.",
    );
  }
  const deduped = dedupeFeeTokens(rows);
  const abi = deduped.filter((row) => row.source === "abi");
  const rest = deduped
    .filter((row) => row.source !== "abi")
    .sort(compareFeeTokens);
  const abiKept = abi.slice(0, cap);
  const room = cap - abiKept.length;
  const picked = [...abiKept, ...rest.slice(0, room)].sort(compareFeeTokens);
  return {
    tokens: picked.map(toFeeTokenRow),
    truncated: deduped.length > picked.length,
    cap,
  };
}

export interface NormalizedPlsxTransfer {
  from: Address;
  to: Address;
  toDead: boolean;
  toZero: boolean;
  valueRaw: string;
  value: string | null;
  decimals: number | null;
  blockNumber: string;
  logIndex: string;
  timestamp: string | null;
  timestampIso: string | null;
  txHash: string | null;
}

export interface LastBurnEvidence {
  ok: boolean;
  softFail: boolean;
  source: "blockscout-tokentx" | null;
  reason: string | null;
  pageCount: number;
  matchedCount: number;
  latest: NormalizedPlsxTransfer | null;
  latestToDead: NormalizedPlsxTransfer | null;
  latestToZero: NormalizedPlsxTransfer | null;
  note: string;
}

const BURN_SOFT_FAIL_NOTE =
  "Explorer transfer query failed. On-chain balances are still returned. No burn transfer was invented.";

/**
 * Latest PLSX transfers from the buyback in one explorer page.
 * `rows` is a BlockScout tokentx result (or the same from/to/value shape).
 * Non-array payloads soft-fail. This does not throw.
 */
export function summarizeBuybackPlsxTransfers(
  rows: unknown,
  buyback: string,
): LastBurnEvidence {
  if (!isAddress(buyback)) {
    return {
      ok: false,
      softFail: true,
      source: null,
      reason: "Buyback address was not valid while reading burn transfers.",
      pageCount: 0,
      matchedCount: 0,
      latest: null,
      latestToDead: null,
      latestToZero: null,
      note: BURN_SOFT_FAIL_NOTE,
    };
  }
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      softFail: true,
      source: "blockscout-tokentx",
      reason: "Explorer token-transfer payload was not a list.",
      pageCount: 0,
      matchedCount: 0,
      latest: null,
      latestToDead: null,
      latestToZero: null,
      note: BURN_SOFT_FAIL_NOTE,
    };
  }
  const buybackAddress = getAddress(buyback);
  const parsed = rows
    .map(parseTransferRow)
    .filter((row): row is NormalizedPlsxTransfer => row !== null)
    .filter((row) => row.from === buybackAddress);
  const latest = latestTransfer(parsed);
  const latestToDead = latestTransfer(parsed.filter((row) => row.toDead));
  const latestToZero = latestTransfer(parsed.filter((row) => row.toZero));
  return {
    ok: true,
    softFail: false,
    source: "blockscout-tokentx",
    reason: null,
    pageCount: rows.length,
    matchedCount: parsed.length,
    latest,
    latestToDead,
    latestToZero,
    note: burnEvidenceNote(latest, latestToDead, latestToZero, rows.length),
  };
}

export interface AdvisoryPlsxPrice {
  advisory: true;
  priceUsd: number | null;
  source: "pulsex-subgraph-derivedUSD" | null;
  /** Always true: this price is not multiplied into any balance. */
  appliedToBalances: false;
  note: string;
}

/** Existing PulseX derivedUSD helper output. Non-positive or non-finite values stay null. */
export function advisoryPriceFromDerivedUsd(derivedUsd: unknown): AdvisoryPlsxPrice {
  const price = typeof derivedUsd === "number"
    ? derivedUsd
    : typeof derivedUsd === "string" && derivedUsd.trim() !== ""
      ? Number(derivedUsd)
      : Number.NaN;
  if (!Number.isFinite(price) || price <= 0) {
    return {
      advisory: true,
      priceUsd: null,
      source: null,
      appliedToBalances: false,
      note:
        "No positive PulseX derivedUSD from the existing token price helper. No USD figure invented. Price is not applied to balances.",
    };
  }
  return {
    advisory: true,
    priceUsd: price,
    source: "pulsex-subgraph-derivedUSD",
    appliedToBalances: false,
    note:
      "Advisory PulseX subgraph derivedUSD for PLSX from the existing token price helper. " +
      "Not multiplied into dead or buyback balances. Not a redemption price, not a quote, and not financial advice.",
  };
}

export interface AmountReading {
  address: Address;
  balanceRaw: string;
  balance: string;
  note: string;
}

export interface PulsexBuyAndBurnReport {
  chainId: typeof PULSECHAIN_CHAIN_ID;
  proxy: Address;
  implementation: Address;
  implementationSeen: typeof PULSEX_BUY_AND_BURN_IMPLEMENTATION_SEEN;
  implementationMatchesSeen: boolean;
  implementationSlot: typeof ERC1967_IMPLEMENTATION_SLOT;
  labels: {
    proxy: "ERC1967Proxy";
    implementationSeen: "PLSXBuyAndBurnUpgradeable";
    note: string;
  };
  plsx: Address;
  dead: typeof PULSEX_BURN_DEAD_ADDRESS;
  zero: typeof zeroAddress;
  running: RunningState;
  runningView: "paused()" | "enabled()" | null;
  runningChecked: readonly ["paused()", "enabled()"];
  runningNote: string;
  anyAuth: boolean | null;
  anyAuthView: "anyAuth()";
  callerGateNote: string;
  plsxBalances: {
    decimals: 18;
    dead: AmountReading;
    zero: {
      address: typeof zeroAddress;
      balanceRaw: string | null;
      balance: string | null;
      note: string;
    };
    buyback: AmountReading;
  };
  nativePls: {
    address: Address;
    symbol: "PLS";
    decimals: 18;
    balanceRaw: string;
    balance: string;
    note: string;
  };
  wpls: {
    address: Address | null;
    view: "WPLS()";
    matchesCatalog: boolean | null;
  };
  feeTokens: {
    cap: number;
    truncated: boolean;
    tokens: FeeTokenRow[];
    note: string;
  };
  lastBurn: LastBurnEvidence;
  plsxPrice: AdvisoryPlsxPrice;
  note: string;
  mechanismNote: string;
  financialAdvice: false;
  calledBuyAndBurn: false;
  calledConvertLps: false;
}

export interface BuyAndBurnReportInput {
  implementation: string;
  paused: boolean | null;
  enabled: boolean | null;
  anyAuth: boolean | null;
  wpls: string | null;
  deadPlsxRaw: bigint;
  zeroPlsxRaw: bigint | null;
  buybackPlsxRaw: bigint;
  nativePlsRaw: bigint;
  feeTokens: readonly FeeTokenCandidate[];
  lastBurn: LastBurnEvidence;
  plsxPrice: AdvisoryPlsxPrice;
}

export function buildPulsexBuyAndBurnReport(
  input: BuyAndBurnReportInput,
): PulsexBuyAndBurnReport {
  const proxy = getAddress(PULSEX_BUY_AND_BURN_PROXY);
  const implementation = addressFromImplementationSlot(
    addressWord(input.implementation),
  );
  const plsx = assertCatalogPlsx(PLSX_ADDRESS);
  const dead = getAddress(PULSEX_BURN_DEAD_ADDRESS);
  const seen = getAddress(PULSEX_BUY_AND_BURN_IMPLEMENTATION_SEEN);
  const running = interpretBuyAndBurnRunning({
    paused: input.paused,
    enabled: input.enabled,
  });
  const wpls = parseOptionalAddress(input.wpls, "WPLS()");
  const matchesCatalog =
    wpls === null ? null : wpls === getAddress(WPLS_ADDRESS);
  const fee = selectFeeTokenBalances(input.feeTokens);
  const implementationMatchesSeen = implementation === seen;
  assertNonNegative(input.deadPlsxRaw, "dead PLSX balance");
  assertNonNegative(input.buybackPlsxRaw, "buyback PLSX balance");
  assertNonNegative(input.nativePlsRaw, "native PLS balance");
  if (input.zeroPlsxRaw !== null) {
    assertNonNegative(input.zeroPlsxRaw, "zero-address PLSX balance");
  }

  return {
    chainId: PULSECHAIN_CHAIN_ID,
    proxy,
    implementation,
    implementationSeen: PULSEX_BUY_AND_BURN_IMPLEMENTATION_SEEN,
    implementationMatchesSeen,
    implementationSlot: ERC1967_IMPLEMENTATION_SLOT,
    labels: {
      proxy: "ERC1967Proxy",
      implementationSeen: "PLSXBuyAndBurnUpgradeable",
      note: implementationMatchesSeen
        ? "Implementation matches the BlockScout-verified PLSXBuyAndBurnUpgradeable this reader was checked against. Proxy name on BlockScout was ERC1967Proxy."
        : "Implementation slot differs from the implementation this reader was checked against. The current slot address is `implementation`. The seen name applies to `implementationSeen`. paused() and enabled() were still attempted.",
    },
    plsx,
    dead: PULSEX_BURN_DEAD_ADDRESS,
    zero: zeroAddress,
    running: running.running,
    runningView: running.view,
    runningChecked: running.checked,
    runningNote: running.note,
    anyAuth: input.anyAuth,
    anyAuthView: "anyAuth()",
    callerGateNote: callerGateNote(input.anyAuth),
    plsxBalances: {
      decimals: 18,
      dead: {
        address: dead,
        balanceRaw: input.deadPlsxRaw.toString(),
        balance: formatUnits(input.deadPlsxRaw, 18),
        note: DEAD_BALANCE_NOTE,
      },
      zero: {
        address: zeroAddress,
        balanceRaw: input.zeroPlsxRaw === null ? null : input.zeroPlsxRaw.toString(),
        balance:
          input.zeroPlsxRaw === null ? null : formatUnits(input.zeroPlsxRaw, 18),
        note:
          input.zeroPlsxRaw === null
            ? "balanceOf(zero) failed. No zero-address balance was invented. " + ZERO_BALANCE_NOTE
            : ZERO_BALANCE_NOTE,
      },
      buyback: {
        address: proxy,
        balanceRaw: input.buybackPlsxRaw.toString(),
        balance: formatUnits(input.buybackPlsxRaw, 18),
        note: BUYBACK_PLSX_NOTE,
      },
    },
    nativePls: {
      address: proxy,
      symbol: "PLS",
      decimals: 18,
      balanceRaw: input.nativePlsRaw.toString(),
      balance: formatEther(input.nativePlsRaw),
      note: "Native PLS held by the buyback proxy. Not WPLS.",
    },
    wpls: {
      address: wpls,
      view: "WPLS()",
      matchesCatalog,
    },
    feeTokens: {
      cap: fee.cap,
      truncated: fee.truncated,
      tokens: fee.tokens,
      note: feeTokenNote(wpls, matchesCatalog, fee.truncated),
    },
    lastBurn: input.lastBurn,
    plsxPrice: input.plsxPrice,
    note: FEE_SPLIT_NOTE,
    mechanismNote: MECHANISM_NOTE,
    financialAdvice: false,
    calledBuyAndBurn: false,
    calledConvertLps: false,
  };
}

export async function readPulsexBuyAndBurn(
  config: AppConfig,
): Promise<PulsexBuyAndBurnReport> {
  if (config.network !== "mainnet") {
    throw new AppError(
      "pulsex_buy_and_burn reads PulseChain mainnet (chain 369) only.",
      "CHAIN_MISMATCH",
    );
  }

  const proxy = getAddress(PULSEX_BUY_AND_BURN_PROXY);
  const client = getPublicClient(config);
  const pricePromise = readAdvisoryPlsxPrice(config);
  const burnPromise = readLastBurn(config, proxy);

  try {
    const [liveChainId, proxyCode, slot, nativePlsRaw] = await Promise.all([
      getChainId(config),
      client.getCode({ address: proxy }),
      client.getStorageAt({
        address: proxy,
        slot: ERC1967_IMPLEMENTATION_SLOT,
      }),
      client.getBalance({ address: proxy }),
    ]);

    if (liveChainId !== PULSECHAIN_CHAIN_ID) {
      throw new AppError(
        `pulsex_buy_and_burn refuses to read because RPC eth_chainId is ${liveChainId}, not 369.`,
        "CHAIN_MISMATCH",
      );
    }
    assertBytecode(proxyCode, "buyback proxy");
    const implementation = addressFromImplementationSlot(slot ?? null);
    const implementationCode = await client.getCode({ address: implementation });
    assertBytecode(implementationCode, "buyback implementation");

    const abi = viewAbi();
    const viewRows = (await client.multicall({
      allowFailure: true,
      contracts: [
        { address: proxy, abi, functionName: "paused" },
        { address: proxy, abi, functionName: "enabled" },
        { address: proxy, abi, functionName: "anyAuth" },
        { address: proxy, abi, functionName: "PLSX" },
        { address: proxy, abi, functionName: "WPLS" },
      ] as never,
    })) as ReadonlyArray<{ status: string; result?: unknown }>;

    const paused = asBool(succeeded(viewRows[0]));
    const enabled = asBool(succeeded(viewRows[1]));
    const anyAuth = asBool(succeeded(viewRows[2]));
    const plsx = assertCatalogPlsx(asAddressString(succeeded(viewRows[3])));
    const wpls = asAddressString(succeeded(viewRows[4]));
    const plan = feeTokenReadPlan(wpls);

    const balanceRows = (await client.multicall({
      allowFailure: true,
      contracts: [
        balanceCall(plsx, getAddress(PULSEX_BURN_DEAD_ADDRESS)),
        balanceCall(plsx, zeroAddress),
        balanceCall(plsx, proxy),
        ...plan.map((row) => balanceCall(row.address, proxy)),
      ] as never,
    })) as ReadonlyArray<{ status: string; result?: unknown }>;

    const deadPlsxRaw = requiredBalance(balanceRows[0], "PLSX balance of the dead address");
    const zeroPlsxRaw = optionalBalance(balanceRows[1]);
    const buybackPlsxRaw = requiredBalance(
      balanceRows[2],
      "PLSX balance of the buyback proxy",
    );
    const feeTokens: FeeTokenCandidate[] = plan.map((row, index) => ({
      address: row.address,
      source: row.source,
      balanceRaw: optionalBalance(balanceRows[index + 3]),
    }));

    const [plsxPrice, lastBurn] = await Promise.all([pricePromise, burnPromise]);
    return buildPulsexBuyAndBurnReport({
      implementation,
      paused,
      enabled,
      anyAuth,
      wpls,
      deadPlsxRaw,
      zeroPlsxRaw,
      buybackPlsxRaw,
      nativePlsRaw,
      feeTokens,
      lastBurn,
      plsxPrice,
    });
  } catch (err) {
    await Promise.allSettled([pricePromise, burnPromise]);
    throw err;
  }
}

function viewAbi() {
  return PULSEX_BUY_AND_BURN_READ_FRAGMENTS.map((fragment) => {
    const match = /^function\s+([A-Za-z0-9_]+)\(\)\s+view\s+returns\s+\(([^)]+)\)$/.exec(
      fragment,
    );
    const name = match?.[1];
    const returns = match?.[2];
    if (!name || (returns !== "bool" && returns !== "address")) {
      throw new PolicyError(
        "Refusing PulseX buy-and-burn read: view ABI fragment is not a zero-arg bool or address view.",
      );
    }
    return {
      type: "function" as const,
      name,
      stateMutability: "view" as const,
      inputs: [],
      outputs: [{ type: returns }],
    };
  });
}

function balanceCall(token: Address, holder: Address) {
  return {
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf" as const,
    args: [holder] as const,
  };
}

function succeeded(row: { status: string; result?: unknown } | undefined): unknown {
  if (!row || row.status !== "success") return undefined;
  return row.result;
}

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asAddressString(value: unknown): string | null {
  return typeof value === "string" && isAddress(value) ? value : null;
}

function optionalBalance(
  row: { status: string; result?: unknown } | undefined,
): bigint | null {
  const value = succeeded(row);
  return typeof value === "bigint" && value >= 0n ? value : null;
}

function requiredBalance(
  row: { status: string; result?: unknown } | undefined,
  label: string,
): bigint {
  const value = optionalBalance(row);
  if (value === null) {
    throw new RpcError(
      `${label} failed. Refusing to report that balance as zero.`,
    );
  }
  return value;
}

function assertBytecode(code: string | undefined, label: string): void {
  if (typeof code !== "string" || code === "0x" || code.length <= 2) {
    throw new PolicyError(
      `Refusing PulseX buy-and-burn read: ${label} has no contract code.`,
    );
  }
}

function assertNonNegative(value: bigint, label: string): void {
  if (value < 0n) {
    throw new PolicyError(
      `Refusing PulseX buy-and-burn read: ${label} is negative.`,
    );
  }
}

function parseOptionalAddress(value: string | null, label: string): Address | null {
  if (value === null) return null;
  if (!isAddress(value)) {
    throw new PolicyError(
      `Refusing PulseX buy-and-burn read: ${label} was not a valid address.`,
    );
  }
  return getAddress(value);
}

/** 32-byte word so a bare address can go through the slot decoder. */
function addressWord(address: string): string {
  if (!isAddress(address)) {
    throw new PolicyError(
      "Refusing PulseX buy-and-burn read: implementation is not a valid address.",
    );
  }
  return `0x${"0".repeat(24)}${getAddress(address).slice(2)}`;
}

function callerGateNote(anyAuth: boolean | null): string {
  if (anyAuth === false) {
    return (
      "anyAuth() is false. convertLps reverts unless the caller is authorized (isAuth). " +
      "This is an admin gate, not a paused() or enabled() reading. " +
      "Authorized callers can still convert, and they pay gas. Fee tokens can sit in the contract between calls."
    );
  }
  if (anyAuth === true) {
    return (
      "anyAuth() is true, so an externally owned caller may convert fees and pays the gas. " +
      "This is not a pause flag and not proof the next call will succeed."
    );
  }
  return "anyAuth() did not return a boolean. The caller gate was not guessed.";
}

function feeTokenNote(
  wpls: Address | null,
  matchesCatalog: boolean | null,
  truncated: boolean,
): string {
  const parts = [
    "WPLS is included from WPLS() when that view returns an address. Other rows are a small catalog: WPLS, HEX, INC, bridged DAI, eUSDC, eUSDT, bridged WETH, and eWBTC.",
    "LP fee tokens are not enumerated. The list is capped. Addresses missing from the catalog are labeled unverified.",
    "Rows are ordered by whole-token size using catalog decimals, not by raw units and not by USD.",
    "No USD value is attached to these balances.",
  ];
  if (wpls === null) {
    parts.push(
      "WPLS() did not return an address. Catalog WPLS was still read and labeled known-list, not abi.",
    );
  } else if (matchesCatalog === false) {
    parts.push(
      "WPLS() returned an address that is not catalog WPLS. That row is labeled unverified.",
    );
  }
  if (truncated) {
    parts.push("The fee-token list hit its cap. Lower balances were left out.");
  }
  return parts.join(" ");
}

function dedupeFeeTokens(rows: readonly FeeTokenCandidate[]): FeeTokenCandidate[] {
  const map = new Map<string, FeeTokenCandidate>();
  for (const row of rows) {
    if (!isAddress(row.address)) {
      throw new PolicyError(
        "Refusing PulseX buy-and-burn read: a fee-token address is not valid.",
      );
    }
    const address = getAddress(row.address);
    const key = address.toLowerCase();
    const prev = map.get(key);
    if (!prev || (prev.source !== "abi" && row.source === "abi")) {
      map.set(key, { address, balanceRaw: row.balanceRaw, source: row.source });
    }
  }
  return [...map.values()];
}

/**
 * Whole-token size for ordering. Catalog decimals scale the raw balance to
 * 18 decimal places. Unverified tokens are not scaled, because guessing
 * decimals would invent a size. This is not a USD ranking.
 */
function sortMagnitude(row: FeeTokenCandidate): bigint | null {
  if (row.balanceRaw === null) return null;
  const known = KNOWN_TOKENS_BY_ADDRESS[row.address.toLowerCase()];
  if (!known || !Number.isInteger(known.decimals) || known.decimals < 0 || known.decimals > 36) {
    return null;
  }
  if (known.decimals === 18) return row.balanceRaw;
  if (known.decimals < 18) {
    return row.balanceRaw * 10n ** BigInt(18 - known.decimals);
  }
  return row.balanceRaw / 10n ** BigInt(known.decimals - 18);
}

function feeTokenTier(row: FeeTokenCandidate, magnitude: bigint | null): number {
  if (row.balanceRaw === null) return 3;
  if (magnitude === null) return row.balanceRaw > 0n ? 1 : 2;
  return magnitude > 0n ? 0 : 2;
}

function compareFeeTokens(a: FeeTokenCandidate, b: FeeTokenCandidate): number {
  const aMag = sortMagnitude(a);
  const bMag = sortMagnitude(b);
  const tier = feeTokenTier(a, aMag) - feeTokenTier(b, bMag);
  if (tier !== 0) return tier;
  if (aMag !== null && bMag !== null && aMag !== bMag) {
    return aMag > bMag ? -1 : 1;
  }
  if (
    aMag === null &&
    bMag === null &&
    a.balanceRaw !== null &&
    b.balanceRaw !== null &&
    a.balanceRaw !== b.balanceRaw
  ) {
    return a.balanceRaw > b.balanceRaw ? -1 : 1;
  }
  return a.address.toLowerCase().localeCompare(b.address.toLowerCase());
}

function toFeeTokenRow(row: FeeTokenCandidate): FeeTokenRow {
  const address = getAddress(row.address);
  const known = KNOWN_TOKENS_BY_ADDRESS[address.toLowerCase()];
  const readFailed = row.balanceRaw === null;
  if (!known) {
    return {
      address,
      symbol: null,
      displaySymbol: null,
      origin: null,
      source: row.source,
      label: "unverified",
      decimals: null,
      balanceRaw: readFailed ? null : row.balanceRaw!.toString(),
      balance: null,
      readFailed,
    };
  }
  return {
    address,
    symbol: known.symbol,
    displaySymbol: known.displaySymbol ?? known.symbol,
    origin: known.origin ?? null,
    source: row.source,
    label: "catalogued",
    decimals: known.decimals,
    balanceRaw: readFailed ? null : row.balanceRaw!.toString(),
    balance: readFailed ? null : formatUnits(row.balanceRaw!, known.decimals),
    readFailed,
  };
}

function parseTransferRow(row: unknown): NormalizedPlsxTransfer | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  const from = asAddressString(record.from);
  const to = asAddressString(record.to);
  const valueRaw = parseUint(record.value);
  const blockNumber = parseUint(record.blockNumber);
  if (!from || !to || valueRaw === null || blockNumber === null) return null;
  const decimals = parseDecimals(record.tokenDecimal);
  const timestamp = unixTimestamp(record.timeStamp);
  const hashRaw = typeof record.hash === "string"
    ? record.hash
    : typeof record.transactionHash === "string"
      ? record.transactionHash
      : null;
  const txHash = hashRaw && /^0x[a-fA-F0-9]{64}$/.test(hashRaw) ? hashRaw : null;
  const logIndex = parseUint(record.logIndex) ?? 0n;
  const toAddress = getAddress(to);
  return {
    from: getAddress(from),
    to: toAddress,
    toDead: toAddress === getAddress(PULSEX_BURN_DEAD_ADDRESS),
    toZero: toAddress === zeroAddress,
    valueRaw: valueRaw.toString(),
    value: decimals === null ? null : formatUnits(valueRaw, decimals),
    decimals,
    blockNumber: blockNumber.toString(),
    logIndex: logIndex.toString(),
    timestamp,
    timestampIso: timestampIso(timestamp),
    txHash,
  };
}

function latestTransfer(
  rows: readonly NormalizedPlsxTransfer[],
): NormalizedPlsxTransfer | null {
  let best: NormalizedPlsxTransfer | null = null;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    const block = BigInt(row.blockNumber) - BigInt(best.blockNumber);
    if (block > 0n || (block === 0n && BigInt(row.logIndex) > BigInt(best.logIndex))) {
      best = row;
    }
  }
  return best;
}

function burnEvidenceNote(
  latest: NormalizedPlsxTransfer | null,
  latestToDead: NormalizedPlsxTransfer | null,
  latestToZero: NormalizedPlsxTransfer | null,
  pageCount: number,
): string {
  const page =
    "BlockScout account tokentx for PLSX on the buyback, sort desc, one capped page. " +
    "This is the existing explorer transfer path, not a dashboard scrape and not full history. " +
    "Wide getLogs ranges are not queried.";
  if (pageCount === 0 || !latest) {
    return (
      page +
      " No PLSX transfer from the buyback was in this page. That is not proof there were no burns."
    );
  }
  if (latestToDead && (latest.toZero || latestToZero)) {
    return (
      page +
      " This page includes a PLSX transfer from the buyback to the dead address and a transfer to the zero address, which matches PLSX.burn. " +
      "The dead-address balance is separate from either transfer."
    );
  }
  if (latestToDead) {
    return (
      page +
      " A PLSX transfer from the buyback to the dead address is included. It is not the entire dead-address balance."
    );
  }
  if (latest.toZero || latestToZero) {
    return (
      page +
      " No PLSX transfer from the buyback to the dead address was in this page. " +
      "The latest PLSX transfer from the buyback is to the zero address, which matches PLSX.burn. " +
      "The dead-address balance is separate."
    );
  }
  return (
    page +
    " The latest PLSX transfer from the buyback in this page was not to the dead address or the zero address."
  );
}

function parseUint(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (/^[0-9]+$/.test(value)) return BigInt(value);
  return null;
}

function parseDecimals(value: unknown): number | null {
  // This parser only reads PLSX transfers. Missing decimals use the catalog 18.
  if (value === undefined || value === null || value === "") return 18;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 36) return null;
  return parsed;
}

function unixTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return null;
}

function timestampIso(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function readAdvisoryPlsxPrice(config: AppConfig): Promise<AdvisoryPlsxPrice> {
  try {
    const res = await fetchToken(config, PLSX_ADDRESS, "v2");
    return advisoryPriceFromDerivedUsd(res.token?.derivedUSD);
  } catch {
    return {
      advisory: true,
      priceUsd: null,
      source: null,
      appliedToBalances: false,
      note: "Token price helper failed. No USD figure invented. Price is not applied to balances.",
    };
  }
}

async function readLastBurn(
  config: AppConfig,
  buyback: Address,
): Promise<LastBurnEvidence> {
  try {
    const raw = await getAccountTokenTransfers(config, buyback, {
      contractAddress: PLSX_ADDRESS,
      page: 1,
      offset: 10,
    });
    return summarizeBuybackPlsxTransfers(raw, buyback);
  } catch (err) {
    return {
      ok: false,
      softFail: true,
      source: null,
      reason: err instanceof Error ? err.message : String(err),
      pageCount: 0,
      matchedCount: 0,
      latest: null,
      latestToDead: null,
      latestToZero: null,
      note: BURN_SOFT_FAIL_NOTE,
    };
  }
}
