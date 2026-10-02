/**
 * Read-only Liquid Loans (USDL) views.
 * VaultManager is the current PLS-collateral deployment.
 * Do not confuse it with the older PLSX TroveManager.
 *
 * ICR / TCR / MCR use 1e18 = 100%.
 * Nominal ICR is collateral * 1e20 / debt (PLS per USDL), not a percent.
 * Vault debt used for ICR is entire debt: recorded debt plus pending
 * redistribution rewards, and it includes the USDL gas reserve.
 * fetchPrice is an eth_call simulation, not a transaction.
 */

import type { Address } from "viem";
import { formatUnits, zeroAddress } from "viem";
import { LIQUID_LOANS } from "../constants.js";
import type { AppConfig } from "../types.js";
import { chainIdForConfig, getPublicClient } from "./rpc.js";

const VAULT_STATUS = [
  "nonExistent",
  "active",
  "closedByOwner",
  "closedByLiquidation",
  "closedByRedemption",
] as const;

/** PriceFeed.Status on the current PLS deployment. */
const PRICE_STATUS = [
  "fetchWorking",
  "usingSecondaryFetchUntrusted",
  "bothOraclesUntrusted",
  "usingSecondaryFetchFrozen",
  "usingFetchSecondaryUntrusted",
] as const;

const ICR_UNBOUNDED = 2n ** 255n;

const PRICE_ABI = [
  {
    // Deployed fetchPrice is nonpayable. Marked view here so eth_call can simulate it.
    // The selector does not depend on state mutability, and this call is never sent.
    type: "function",
    name: "fetchPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lastGoodPrice",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "status",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

const VAULT_ABI = [
  {
    type: "function",
    name: "getVaultStatus",
    stateMutability: "view",
    inputs: [{ name: "_borrower", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getEntireDebtAndColl",
    stateMutability: "view",
    inputs: [{ name: "_borrower", type: "address" }],
    outputs: [
      { name: "debt", type: "uint256" },
      { name: "coll", type: "uint256" },
      { name: "pendingUSDLDebtReward", type: "uint256" },
      { name: "pendingPLSReward", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getCurrentICR",
    stateMutability: "view",
    inputs: [
      { name: "_borrower", type: "address" },
      { name: "_price", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getNominalICR",
    stateMutability: "view",
    inputs: [{ name: "_borrower", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getEntireSystemColl",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getEntireSystemDebt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getTCR",
    stateMutability: "view",
    inputs: [{ name: "_price", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "checkRecoveryMode",
    stateMutability: "view",
    inputs: [{ name: "_price", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getBorrowingRateWithDecay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getRedemptionRateWithDecay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MCR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "CCR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MIN_NET_DEBT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "USDL_GAS_COMPENSATION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "BORROWING_FEE_FLOOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "REDEMPTION_FEE_FLOOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "MAX_BORROWING_FEE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getVaultOwnersCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getVaultFromVaultOwnersArray",
    stateMutability: "view",
    inputs: [{ name: "_index", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;

const POOL_ABI = [
  {
    type: "function",
    name: "getPLS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getUSDLDebt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getTotalUSDLDeposits",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getCompoundedUSDLDeposit",
    stateMutability: "view",
    inputs: [{ name: "_depositor", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getDepositorPLSGain",
    stateMutability: "view",
    inputs: [{ name: "_depositor", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getDepositorLOANGain",
    stateMutability: "view",
    inputs: [{ name: "_depositor", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getCollateral",
    stateMutability: "view",
    inputs: [{ name: "_account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const STAKE_ABI = [
  {
    type: "function",
    name: "stakes",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getPendingPLSGain",
    stateMutability: "view",
    inputs: [{ name: "_user", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getPendingUSDLGain",
    stateMutability: "view",
    inputs: [{ name: "_user", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalLOANStaked",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const SORTED_ABI = [
  {
    type: "function",
    name: "getFirst",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getLast",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getSize",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

type MulticallRow = {
  status: "success" | "failure";
  result?: unknown;
};

export type LiquidationState =
  | "not_active"
  | "below_minimum"
  | "recovery_mode"
  | "above_thresholds"
  | "unknown";

/** 1e18 fraction → percent string (1.1e18 → "110.00%"). */
export function formatRatioPercent(raw: bigint, fractionDigits = 2): string {
  const digits = fractionDigits < 0 ? 0 : fractionDigits;
  const scale = 10n ** BigInt(digits);
  const scaled = (raw * 100n * scale) / 10n ** 18n;
  const whole = scaled / scale;
  if (digits === 0) return `${whole.toString()}%`;
  const frac = (scaled % scale).toString().padStart(digits, "0");
  return `${whole.toString()}.${frac}%`;
}

export function formatSignedRatioPercent(raw: bigint, fractionDigits = 2): string {
  if (raw < 0n) return `-${formatRatioPercent(-raw, fractionDigits)}`;
  return formatRatioPercent(raw, fractionDigits);
}

/** NICR = collateral * 1e20 / debt. Returns PLS collateral per 1 USDL of debt. */
export function plsPerUsdlFromNicr(nicr: bigint): string {
  return formatUnits(nicr, 20);
}

export function vaultStatusName(code: bigint): string {
  const i = Number(code);
  return VAULT_STATUS[i] ?? `unknown(${code.toString()})`;
}

export function priceStatusName(code: number): string {
  return PRICE_STATUS[code] ?? `unknown(${code})`;
}

/** Sum of entire debt in vaults with a strictly lower nominal ICR. */
export function sumDebtInFront(
  nicr: bigint,
  vaults: readonly { nicr: bigint; debt: bigint }[],
): { debt: bigint; vaultsAhead: number } {
  let debt = 0n;
  let vaultsAhead = 0;
  for (const vault of vaults) {
    if (vault.debt > 0n && vault.nicr < nicr) {
      debt += vault.debt;
      vaultsAhead += 1;
    }
  }
  return { debt, vaultsAhead };
}

export function assessLiquidation(input: {
  status: string | null;
  icr: bigint | null;
  mcr: bigint | null;
  tcr: bigint | null;
  recoveryMode: boolean | null;
}): { state: LiquidationState; reason: string } {
  if (input.status !== "active") {
    return {
      state: "not_active",
      reason: "Only an active vault can be liquidated.",
    };
  }
  if (input.icr === null || input.mcr === null) {
    return {
      state: "unknown",
      reason: "ICR or the minimum collateral ratio was not read.",
    };
  }
  if (input.icr >= ICR_UNBOUNDED) {
    return {
      state: "above_thresholds",
      reason: "ICR is unbounded because the vault has no debt.",
    };
  }
  if (input.icr < input.mcr) {
    return {
      state: "below_minimum",
      reason:
        "ICR is below the minimum collateral ratio (110% on this deployment). That vault can be liquidated.",
    };
  }
  if (input.recoveryMode === null || (input.recoveryMode && input.tcr === null)) {
    return {
      state: "unknown",
      reason:
        "ICR is at or above the minimum, but recovery mode was not fully read.",
    };
  }
  if (input.recoveryMode && input.tcr !== null && input.icr < input.tcr) {
    return {
      state: "recovery_mode",
      reason:
        "The system is in recovery mode and this ICR is below the total collateral ratio. Recovery-mode liquidation can close it.",
    };
  }
  return {
    state: "above_thresholds",
    reason:
      "At this price the ICR is not below the minimum, and it is not below the total collateral ratio during recovery mode. This is not a liquidation transaction.",
  };
}

function asBigint(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  return null;
}

function rowBigint(row: MulticallRow | undefined): bigint | null {
  if (!row || row.status !== "success") return null;
  return asBigint(row.result);
}

function rowBool(row: MulticallRow | undefined): boolean | null {
  if (!row || row.status !== "success" || typeof row.result !== "boolean") {
    return null;
  }
  return row.result;
}

function rowAddress(row: MulticallRow | undefined): Address | null {
  if (!row || row.status !== "success" || typeof row.result !== "string") {
    return null;
  }
  return /^0x[a-fA-F0-9]{40}$/.test(row.result) ? (row.result as Address) : null;
}

function fourBigints(
  value: unknown,
): [bigint, bigint, bigint, bigint] | null {
  if (Array.isArray(value)) {
    if (value.length >= 4 && value.every((v) => typeof v === "bigint")) {
      return [value[0] as bigint, value[1] as bigint, value[2] as bigint, value[3] as bigint];
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const debt = asBigint(o.debt);
  const coll = asBigint(o.coll);
  const pendingDebt = asBigint(o.pendingUSDLDebtReward);
  const pendingColl = asBigint(o.pendingPLSReward);
  if (
    debt === null ||
    coll === null ||
    pendingDebt === null ||
    pendingColl === null
  ) {
    return null;
  }
  return [debt, coll, pendingDebt, pendingColl];
}

function amountField(raw: bigint | null, decimals = 18): {
  raw: string | null;
  formatted: string | null;
} {
  if (raw === null) return { raw: null, formatted: null };
  return { raw: raw.toString(), formatted: formatUnits(raw, decimals) };
}

function ratioField(raw: bigint | null, fractionDigits = 2): {
  raw: string | null;
  percent: string | null;
} {
  if (raw === null || raw >= ICR_UNBOUNDED) return { raw: raw?.toString() ?? null, percent: null };
  return { raw: raw.toString(), percent: formatRatioPercent(raw, fractionDigits) };
}

function shareOf(part: bigint | null, whole: bigint | null): {
  raw: string | null;
  percent: string | null;
} {
  if (part === null || whole === null || whole === 0n) {
    return { raw: null, percent: null };
  }
  return ratioField((part * 10n ** 18n) / whole);
}

/** Above this, a debt-in-front scan is skipped instead of multicalling every vault. */
const DEBT_IN_FRONT_CAP = 400;

const DEBT_IN_FRONT_NOTE =
  "Sum of entire USDL debt in other vaults with a lower nominal ICR. " +
  "Equal nominal ICR is not ordered. Advisory for redemption risk, not a redemption quote.";

const MAINNET_ONLY =
  "Liquid Loans USDL reads are mainnet (chain 369) only. This network is not mainnet.";

const NOT_THE_OLD_TROVE =
  "These reads use the current PLS-collateral VaultManager. " +
  `They are not the older PLSX TroveManager at ${LIQUID_LOANS.legacyPlsxTroveManager}. ` +
  "Opening, adjusting, redeeming, or liquidating is not supported here. " +
  "debtUsdl is entire composite debt (recorded plus pending redistribution), including the USDL gas reserve. " +
  "netDebtUsdl subtracts that reserve. Nominal ICR is PLS per USDL, not a percent.";

type PriceRead = {
  price: bigint;
  source: "fetchPrice" | "lastGoodPrice";
  simulated: boolean;
  oracleStatus: string | null;
  note: string;
};

async function multicall(
  config: AppConfig,
  contracts: readonly {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }[],
): Promise<MulticallRow[]> {
  const client = getPublicClient(config);
  return (await client.multicall({
    contracts: contracts as never,
    allowFailure: true,
  })) as MulticallRow[];
}

async function readPrice(config: AppConfig): Promise<
  { ok: true; price: PriceRead } | { ok: false; reason: string }
> {
  const client = getPublicClient(config);
  const [fetched, snap] = await Promise.all([
    client
      .readContract({
        address: LIQUID_LOANS.priceFeed,
        abi: PRICE_ABI,
        functionName: "fetchPrice",
      })
      .then((value) => (typeof value === "bigint" && value > 0n ? value : null))
      .catch(() => null),
    multicall(config, [
      {
        address: LIQUID_LOANS.priceFeed,
        abi: PRICE_ABI,
        functionName: "lastGoodPrice",
      },
      {
        address: LIQUID_LOANS.priceFeed,
        abi: PRICE_ABI,
        functionName: "status",
      },
    ]),
  ]);
  const statusCode = rowBigint(snap[1]);
  const oracleStatus =
    statusCode === null ? null : priceStatusName(Number(statusCode));
  const oracleNote =
    oracleStatus === "bothOraclesUntrusted"
      ? "Both price oracles are untrusted. Treat the price as possibly frozen."
      : oracleStatus !== null && oracleStatus !== "fetchWorking"
        ? "Price feed is not in the normal fetchWorking state."
        : null;
  if (fetched !== null) {
    return {
      ok: true,
      price: {
        price: fetched,
        source: "fetchPrice",
        simulated: true,
        oracleStatus,
        note:
          "eth_call simulation of fetchPrice. Not submitted. " +
          (oracleNote ?? "This is the price the next Liquid Loans transaction would use."),
      },
    };
  }
  const last = rowBigint(snap[0]);
  if (last !== null && last > 0n) {
    return {
      ok: true,
      price: {
        price: last,
        source: "lastGoodPrice",
        simulated: false,
        oracleStatus,
        note:
          "fetchPrice eth_call failed. lastGoodPrice can lag the oracle. " +
          (oracleNote ?? ""),
      },
    };
  }
  return {
    ok: false,
    reason: "Liquid Loans price feed did not return a positive price",
  };
}

async function readDebtInFront(
  config: AppConfig,
  nicr: bigint | null,
): Promise<Record<string, unknown>> {
  if (nicr === null) {
    return {
      computed: false,
      reason: "Nominal ICR was not read, so debt in front was not summed.",
    };
  }
  const vm = LIQUID_LOANS.vaultManager;
  const counts = await multicall(config, [
    { address: vm, abi: VAULT_ABI, functionName: "getVaultOwnersCount" },
    { address: LIQUID_LOANS.sortedVaults, abi: SORTED_ABI, functionName: "getSize" },
  ]);
  const count = rowBigint(counts[0]);
  const size = rowBigint(counts[1]);
  if (count === null || size === null) {
    return { computed: false, reason: "Vault count could not be read." };
  }
  if (count !== size) {
    return {
      computed: false,
      reason:
        "The owner array and the sorted vault list differ, so debt in front was not scanned.",
    };
  }
  if (count > BigInt(DEBT_IN_FRONT_CAP)) {
    return {
      computed: false,
      reason: `More than ${DEBT_IN_FRONT_CAP} vaults; debt in front was not scanned.`,
    };
  }
  const n = Number(count);
  if (n === 0) {
    return {
      computed: true,
      usdl: amountField(0n),
      vaultsAhead: 0,
      note: DEBT_IN_FRONT_NOTE,
    };
  }
  const ownerRows = await multicall(
    config,
    Array.from({ length: n }, (_, i) => ({
      address: vm,
      abi: VAULT_ABI,
      functionName: "getVaultFromVaultOwnersArray",
      args: [BigInt(i)],
    })),
  );
  const owners = ownerRows.map((row) => rowAddress(row));
  if (owners.some((owner) => owner === null)) {
    return { computed: false, reason: "A vault owner could not be read." };
  }
  const debtRows = await multicall(
    config,
    owners.map((owner) => ({
      address: vm,
      abi: VAULT_ABI,
      functionName: "getEntireDebtAndColl",
      args: [owner],
    })),
  );
  const vaults: { nicr: bigint; debt: bigint }[] = [];
  for (const row of debtRows) {
    const entire = row.status === "success" ? fourBigints(row.result) : null;
    if (entire === null) {
      return {
        computed: false,
        reason: "A vault's entire debt could not be read, so debt in front was not summed.",
      };
    }
    const [debt, coll] = entire;
    vaults.push({
      debt,
      nicr: debt === 0n ? ICR_UNBOUNDED : (coll * 10n ** 20n) / debt,
    });
  }
  const summed = sumDebtInFront(nicr, vaults);
  return {
    computed: true,
    usdl: amountField(summed.debt),
    vaultsAhead: summed.vaultsAhead,
    note: DEBT_IN_FRONT_NOTE,
  };
}

function pricePayload(price: PriceRead): Record<string, unknown> {
  return {
    source: price.source,
    simulated: price.simulated,
    ...amountField(price.price),
    unit: "USD per PLS (1e18)",
    oracleStatus: price.oracleStatus,
    note: price.note.trim(),
  };
}

export function assembleVaultView(input: {
  borrower: Address;
  price: PriceRead;
  statusCode: bigint | null;
  entireDebt: bigint | null;
  entireColl: bigint | null;
  pendingDebt: bigint | null;
  pendingColl: bigint | null;
  icr: bigint | null;
  nicr: bigint | null;
  mcr: bigint | null;
  ccr: bigint | null;
  tcr: bigint | null;
  recoveryMode: boolean | null;
  gasCompensation: bigint | null;
}): Record<string, unknown> {
  const status = input.statusCode === null ? null : vaultStatusName(input.statusCode);
  const recordedDebt =
    input.entireDebt !== null &&
    input.pendingDebt !== null &&
    input.entireDebt >= input.pendingDebt
      ? input.entireDebt - input.pendingDebt
      : null;
  const recordedColl =
    input.entireColl !== null &&
    input.pendingColl !== null &&
    input.entireColl >= input.pendingColl
      ? input.entireColl - input.pendingColl
      : null;
  const netDebt =
    status === "active" &&
    input.entireDebt !== null &&
    input.gasCompensation !== null &&
    input.entireDebt >= input.gasCompensation
      ? input.entireDebt - input.gasCompensation
      : null;
  const liquidation = assessLiquidation({
    status,
    icr: input.icr,
    mcr: input.mcr,
    tcr: input.tcr,
    recoveryMode: input.recoveryMode,
  });
  const buffer =
    input.icr !== null &&
    input.mcr !== null &&
    input.icr < ICR_UNBOUNDED
      ? formatSignedRatioPercent(input.icr - input.mcr)
      : null;
  return {
    borrower: input.borrower,
    vaultManager: LIQUID_LOANS.vaultManager,
    status,
    statusCode: input.statusCode === null ? null : input.statusCode.toString(),
    collateralPls: amountField(input.entireColl),
    debtUsdl: amountField(input.entireDebt),
    recordedCollateralPls: amountField(recordedColl),
    recordedDebtUsdl: amountField(recordedDebt),
    pendingCollateralPls: amountField(input.pendingColl),
    pendingDebtUsdl: amountField(input.pendingDebt),
    netDebtUsdl: amountField(netDebt),
    usdlGasCompensation: amountField(input.gasCompensation),
    collateralRatio: ratioField(input.icr),
    nominalIcr:
      input.nicr === null
        ? null
        : {
            raw: input.nicr.toString(),
            plsPerUsdl: plsPerUsdlFromNicr(input.nicr),
            unit: "PLS collateral per 1 USDL of entire debt (not a percent)",
          },
    minimumCollateralRatio: ratioField(input.mcr),
    criticalCollateralRatio: ratioField(input.ccr),
    totalCollateralRatio: ratioField(input.tcr),
    recoveryMode: input.recoveryMode,
    liquidation: {
      advisory: true,
      state: liquidation.state,
      reason: liquidation.reason,
      bufferToMinimum: buffer,
    },
    price: pricePayload(input.price),
  };
}

const MAINNET_GUARD = (config: AppConfig): Record<string, unknown> | null =>
  chainIdForConfig(config) !== 369
    ? { ok: false, source: "liquid_loans", reason: MAINNET_ONLY }
    : null;

export async function readLiquidLoansSystem(
  config: AppConfig,
): Promise<Record<string, unknown>> {
  const blocked = MAINNET_GUARD(config);
  if (blocked) return blocked;
  try {
    const price = await readPrice(config);
    if (!price.ok) {
      return { ok: false, source: "liquid_loans", reason: price.reason };
    }
    const px = price.price.price;
    const vm = LIQUID_LOANS.vaultManager;
    const names = [
      "systemCollateral",
      "systemDebt",
      "tcr",
      "recoveryMode",
      "borrowingRate",
      "redemptionRate",
      "mcr",
      "ccr",
      "minNetDebt",
      "gasCompensation",
      "borrowingFeeFloor",
      "redemptionFeeFloor",
      "maxBorrowingFee",
      "vaultCount",
      "stabilityPoolUsdl",
      "stabilityPoolPls",
      "collateralSurplusPls",
      "totalLoanStaked",
      "activeCollateral",
      "activeDebt",
      "defaultCollateral",
      "defaultDebt",
      "sortedSize",
      "lowestVault",
      "highestVault",
    ] as const;
    const rows = await multicall(config, [
      { address: vm, abi: VAULT_ABI, functionName: "getEntireSystemColl" },
      { address: vm, abi: VAULT_ABI, functionName: "getEntireSystemDebt" },
      { address: vm, abi: VAULT_ABI, functionName: "getTCR", args: [px] },
      { address: vm, abi: VAULT_ABI, functionName: "checkRecoveryMode", args: [px] },
      { address: vm, abi: VAULT_ABI, functionName: "getBorrowingRateWithDecay" },
      { address: vm, abi: VAULT_ABI, functionName: "getRedemptionRateWithDecay" },
      { address: vm, abi: VAULT_ABI, functionName: "MCR" },
      { address: vm, abi: VAULT_ABI, functionName: "CCR" },
      { address: vm, abi: VAULT_ABI, functionName: "MIN_NET_DEBT" },
      { address: vm, abi: VAULT_ABI, functionName: "USDL_GAS_COMPENSATION" },
      { address: vm, abi: VAULT_ABI, functionName: "BORROWING_FEE_FLOOR" },
      { address: vm, abi: VAULT_ABI, functionName: "REDEMPTION_FEE_FLOOR" },
      { address: vm, abi: VAULT_ABI, functionName: "MAX_BORROWING_FEE" },
      { address: vm, abi: VAULT_ABI, functionName: "getVaultOwnersCount" },
      {
        address: LIQUID_LOANS.stabilityPool,
        abi: POOL_ABI,
        functionName: "getTotalUSDLDeposits",
      },
      { address: LIQUID_LOANS.stabilityPool, abi: POOL_ABI, functionName: "getPLS" },
      {
        address: LIQUID_LOANS.collSurplusPool,
        abi: POOL_ABI,
        functionName: "getPLS",
      },
      {
        address: LIQUID_LOANS.loanStaking,
        abi: STAKE_ABI,
        functionName: "totalLOANStaked",
      },
      { address: LIQUID_LOANS.activePool, abi: POOL_ABI, functionName: "getPLS" },
      { address: LIQUID_LOANS.activePool, abi: POOL_ABI, functionName: "getUSDLDebt" },
      { address: LIQUID_LOANS.defaultPool, abi: POOL_ABI, functionName: "getPLS" },
      { address: LIQUID_LOANS.defaultPool, abi: POOL_ABI, functionName: "getUSDLDebt" },
      { address: LIQUID_LOANS.sortedVaults, abi: SORTED_ABI, functionName: "getSize" },
      { address: LIQUID_LOANS.sortedVaults, abi: SORTED_ABI, functionName: "getLast" },
      { address: LIQUID_LOANS.sortedVaults, abi: SORTED_ABI, functionName: "getFirst" },
    ]);
    const partialFailures: string[] = names.filter(
      (_, i) => rows[i]?.status !== "success",
    );
    const coll = rowBigint(rows[0]);
    const debt = rowBigint(rows[1]);
    const lowest = rowAddress(rows[23]);
    const highest = rowAddress(rows[24]);
    let lowestIcr: Record<string, unknown> | null = null;
    let highestIcr: Record<string, unknown> | null = null;
    const ends = [lowest, highest].filter(
      (addr): addr is Address =>
        addr !== null && addr.toLowerCase() !== zeroAddress,
    );
    if (ends.length > 0) {
      const icrRows = await multicall(
        config,
        ends.map((addr) => ({
          address: vm,
          abi: VAULT_ABI,
          functionName: "getCurrentICR",
          args: [addr, px],
        })),
      );
      const describe = (
        addr: Address,
        icr: bigint | null,
        note: string,
      ): Record<string, unknown> => ({
        address: addr,
        collateralRatio: ratioField(icr),
        note,
      });
      if (lowest && lowest.toLowerCase() !== zeroAddress) {
        const icr = rowBigint(icrRows[0]);
        if (icr === null) partialFailures.push("lowestVaultIcr");
        lowestIcr = describe(
          lowest,
          icr,
          "getLast on SortedVaults: lowest nominal ICR. At one system price this is also the lowest ICR.",
        );
      }
      if (highest && highest.toLowerCase() !== zeroAddress) {
        const index = lowest && lowest.toLowerCase() !== zeroAddress ? 1 : 0;
        const icr = rowBigint(icrRows[index]);
        if (icr === null) partialFailures.push("highestVaultIcr");
        highestIcr = describe(
          highest,
          icr,
          "getFirst on SortedVaults: highest nominal ICR.",
        );
      }
    }
    if (coll === null || debt === null) {
      return {
        ok: false,
        source: "liquid_loans",
        reason: "System collateral or debt could not be read",
        partialFailures,
      };
    }
    return {
      ok: true,
      source: "liquid_loans",
      chainId: 369,
      readOnly: true,
      note: NOT_THE_OLD_TROVE,
      contracts: { ...LIQUID_LOANS },
      price: pricePayload(price.price),
      systemCollateralPls: amountField(coll),
      systemDebtUsdl: amountField(debt),
      totalCollateralRatio: ratioField(rowBigint(rows[2])),
      recoveryMode: rowBool(rows[3]),
      borrowingRate: ratioField(rowBigint(rows[4]), 4),
      redemptionRate: ratioField(rowBigint(rows[5]), 4),
      minimumCollateralRatio: ratioField(rowBigint(rows[6])),
      criticalCollateralRatio: ratioField(rowBigint(rows[7])),
      minNetDebtUsdl: amountField(rowBigint(rows[8])),
      usdlGasCompensation: amountField(rowBigint(rows[9])),
      borrowingFeeFloor: ratioField(rowBigint(rows[10]), 4),
      redemptionFeeFloor: ratioField(rowBigint(rows[11]), 4),
      maxBorrowingFee: ratioField(rowBigint(rows[12]), 4),
      vaultCount: rowBigint(rows[13])?.toString() ?? null,
      sortedVaultCount: rowBigint(rows[22])?.toString() ?? null,
      stabilityPoolUsdl: amountField(rowBigint(rows[14])),
      stabilityPoolPls: amountField(rowBigint(rows[15])),
      stabilityPoolDebtShare: shareOf(rowBigint(rows[14]), debt),
      collateralSurplusPls: amountField(rowBigint(rows[16])),
      totalLoanStaked: amountField(rowBigint(rows[17])),
      activePool: {
        collateralPls: amountField(rowBigint(rows[18])),
        debtUsdl: amountField(rowBigint(rows[19])),
      },
      defaultPool: {
        collateralPls: amountField(rowBigint(rows[20])),
        debtUsdl: amountField(rowBigint(rows[21])),
      },
      lowestIcrVault: lowestIcr,
      highestIcrVault: highestIcr,
      ...(partialFailures.length > 0 ? { partialFailures } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      source: "liquid_loans",
      reason: err instanceof Error ? err.message : "Liquid Loans system read failed",
    };
  }
}

async function readVaultNumbers(
  config: AppConfig,
  borrower: Address,
  price: bigint,
): Promise<{
  statusCode: bigint | null;
  entire: [bigint, bigint, bigint, bigint] | null;
  icr: bigint | null;
  nicr: bigint | null;
  mcr: bigint | null;
  ccr: bigint | null;
  tcr: bigint | null;
  recoveryMode: boolean | null;
  gasCompensation: bigint | null;
  failed: string[];
}> {
  const vm = LIQUID_LOANS.vaultManager;
  const names = [
    "status",
    "entireDebtAndColl",
    "icr",
    "nicr",
    "mcr",
    "ccr",
    "tcr",
    "recoveryMode",
    "gasCompensation",
  ];
  const rows = await multicall(config, [
    { address: vm, abi: VAULT_ABI, functionName: "getVaultStatus", args: [borrower] },
    {
      address: vm,
      abi: VAULT_ABI,
      functionName: "getEntireDebtAndColl",
      args: [borrower],
    },
    {
      address: vm,
      abi: VAULT_ABI,
      functionName: "getCurrentICR",
      args: [borrower, price],
    },
    { address: vm, abi: VAULT_ABI, functionName: "getNominalICR", args: [borrower] },
    { address: vm, abi: VAULT_ABI, functionName: "MCR" },
    { address: vm, abi: VAULT_ABI, functionName: "CCR" },
    { address: vm, abi: VAULT_ABI, functionName: "getTCR", args: [price] },
    { address: vm, abi: VAULT_ABI, functionName: "checkRecoveryMode", args: [price] },
    { address: vm, abi: VAULT_ABI, functionName: "USDL_GAS_COMPENSATION" },
  ]);
  const failed = names.filter((_, i) => rows[i]?.status !== "success");
  return {
    statusCode: rowBigint(rows[0]),
    entire: rows[1]?.status === "success" ? fourBigints(rows[1].result) : null,
    icr: rowBigint(rows[2]),
    nicr: rowBigint(rows[3]),
    mcr: rowBigint(rows[4]),
    ccr: rowBigint(rows[5]),
    tcr: rowBigint(rows[6]),
    recoveryMode: rowBool(rows[7]),
    gasCompensation: rowBigint(rows[8]),
    failed: rows[1]?.status === "success" && fourBigints(rows[1].result) === null
      ? [...failed, "entireDebtAndCollDecode"]
      : failed,
  };
}

export async function readLiquidLoansVault(
  config: AppConfig,
  borrower: Address,
): Promise<Record<string, unknown>> {
  const blocked = MAINNET_GUARD(config);
  if (blocked) return { ...blocked, borrower };
  try {
    const price = await readPrice(config);
    if (!price.ok) {
      return { ok: false, source: "liquid_loans", reason: price.reason, borrower };
    }
    const vault = await readVaultNumbers(config, borrower, price.price.price);
    if (vault.entire === null || vault.statusCode === null) {
      return {
        ok: false,
        source: "liquid_loans",
        borrower,
        reason: "Vault status or entire debt and collateral could not be read",
        partialFailures: vault.failed,
      };
    }
    const [entireDebt, entireColl, pendingDebt, pendingColl] = vault.entire;
    const debtInFront = await readDebtInFront(config, vault.nicr);
    return {
      ok: true,
      source: "liquid_loans",
      chainId: 369,
      readOnly: true,
      note: NOT_THE_OLD_TROVE,
      debtInFront,
      ...assembleVaultView({
        borrower,
        price: price.price,
        statusCode: vault.statusCode,
        entireDebt,
        entireColl,
        pendingDebt,
        pendingColl,
        icr: vault.icr,
        nicr: vault.nicr,
        mcr: vault.mcr,
        ccr: vault.ccr,
        tcr: vault.tcr,
        recoveryMode: vault.recoveryMode,
        gasCompensation: vault.gasCompensation,
      }),
      ...(vault.failed.length > 0 ? { partialFailures: vault.failed } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      source: "liquid_loans",
      borrower,
      reason: err instanceof Error ? err.message : "Liquid Loans vault read failed",
    };
  }
}

export async function readLiquidLoansPosition(
  config: AppConfig,
  account: Address,
): Promise<Record<string, unknown>> {
  const blocked = MAINNET_GUARD(config);
  if (blocked) return { ...blocked, account };
  try {
    const price = await readPrice(config);
    if (!price.ok) {
      return { ok: false, source: "liquid_loans", reason: price.reason, account };
    }
    const [vault, rows] = await Promise.all([
      readVaultNumbers(config, account, price.price.price),
      multicall(config, [
        {
          address: LIQUID_LOANS.stabilityPool,
          abi: POOL_ABI,
          functionName: "getCompoundedUSDLDeposit",
          args: [account],
        },
        {
          address: LIQUID_LOANS.stabilityPool,
          abi: POOL_ABI,
          functionName: "getDepositorPLSGain",
          args: [account],
        },
        {
          address: LIQUID_LOANS.stabilityPool,
          abi: POOL_ABI,
          functionName: "getDepositorLOANGain",
          args: [account],
        },
        {
          address: LIQUID_LOANS.stabilityPool,
          abi: POOL_ABI,
          functionName: "getTotalUSDLDeposits",
        },
        {
          address: LIQUID_LOANS.collSurplusPool,
          abi: POOL_ABI,
          functionName: "getCollateral",
          args: [account],
        },
        {
          address: LIQUID_LOANS.loanStaking,
          abi: STAKE_ABI,
          functionName: "stakes",
          args: [account],
        },
        {
          address: LIQUID_LOANS.loanStaking,
          abi: STAKE_ABI,
          functionName: "getPendingPLSGain",
          args: [account],
        },
        {
          address: LIQUID_LOANS.loanStaking,
          abi: STAKE_ABI,
          functionName: "getPendingUSDLGain",
          args: [account],
        },
        {
          address: LIQUID_LOANS.loanStaking,
          abi: STAKE_ABI,
          functionName: "totalLOANStaked",
        },
      ]),
    ]);
    const names = [
      "compoundedUsdl",
      "plsGain",
      "loanGain",
      "stabilityPoolTotal",
      "collateralSurplus",
      "loanStaked",
      "pendingPlsGain",
      "pendingUsdlGain",
      "totalLoanStaked",
    ];
    const failed = [
      ...vault.failed,
      ...names.filter((_, i) => rows[i]?.status !== "success"),
    ];
    if (vault.entire === null || vault.statusCode === null) {
      return {
        ok: false,
        source: "liquid_loans",
        account,
        reason: "Vault status or entire debt and collateral could not be read",
        partialFailures: failed,
      };
    }
    const [entireDebt, entireColl, pendingDebt, pendingColl] = vault.entire;
    const debtInFront = await readDebtInFront(config, vault.nicr);
    const staked = rowBigint(rows[5]);
    const totalStaked = rowBigint(rows[8]);
    return {
      ok: true,
      source: "liquid_loans",
      chainId: 369,
      readOnly: true,
      note: NOT_THE_OLD_TROVE,
      account,
      debtInFront,
      vault: assembleVaultView({
        borrower: account,
        price: price.price,
        statusCode: vault.statusCode,
        entireDebt,
        entireColl,
        pendingDebt,
        pendingColl,
        icr: vault.icr,
        nicr: vault.nicr,
        mcr: vault.mcr,
        ccr: vault.ccr,
        tcr: vault.tcr,
        recoveryMode: vault.recoveryMode,
        gasCompensation: vault.gasCompensation,
      }),
      stabilityPool: {
        compoundedUsdl: amountField(rowBigint(rows[0])),
        plsGain: amountField(rowBigint(rows[1])),
        loanGain: amountField(rowBigint(rows[2])),
        poolTotalUsdl: amountField(rowBigint(rows[3])),
        note: "Compounded USDL after liquidations. This is not the raw deposits mapping.",
      },
      loanStake: {
        staked: amountField(staked),
        pendingPlsGain: amountField(rowBigint(rows[6])),
        pendingUsdlGain: amountField(rowBigint(rows[7])),
        totalLoanStaked: amountField(totalStaked),
        shareOfStake: shareOf(staked, totalStaked),
      },
      collateralSurplusPls: amountField(rowBigint(rows[4])),
      price: pricePayload(price.price),
      ...(failed.length > 0 ? { partialFailures: failed } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      source: "liquid_loans",
      account,
      reason: err instanceof Error ? err.message : "Liquid Loans position read failed",
    };
  }
}
