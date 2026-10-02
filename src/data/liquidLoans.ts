/**
 * Read-only Liquid Loans (USDL) views.
 * VaultManager is the current PLS-collateral deployment.
 * Do not confuse it with the older PLSX TroveManager.
 */

import type { Address } from "viem";
import { formatUnits } from "viem";
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

const PRICE_ABI = [
  {
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
] as const;

const READ_ABI = [
  {
    type: "function",
    name: "getVaultColl",
    stateMutability: "view",
    inputs: [{ name: "_borrower", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getVaultDebt",
    stateMutability: "view",
    inputs: [{ name: "_borrower", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getVaultStatus",
    stateMutability: "view",
    inputs: [{ name: "_borrower", type: "address" }],
    outputs: [{ type: "uint256" }],
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
    name: "getTotalUSDLDeposits",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

type MulticallRow = {
  status: "success" | "failure";
  result?: unknown;
};

/** 1e18 fraction → percent string with two decimals (1.1e18 → "110.00%"). */
export function formatRatioPercent(raw: bigint): string {
  const bps = (raw * 10000n) / 10n ** 18n;
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0");
  return `${whole.toString()}.${frac}%`;
}

export function vaultStatusName(code: bigint): string {
  const i = Number(code);
  return VAULT_STATUS[i] ?? `unknown(${code.toString()})`;
}

function asBigint(value: unknown): bigint | null {
  return typeof value === "bigint" ? value : null;
}

function rowBigint(row: MulticallRow | undefined): bigint | null {
  if (!row || row.status !== "success") return null;
  return asBigint(row.result);
}

function amountField(raw: bigint | null, decimals = 18): {
  raw: string | null;
  formatted: string | null;
} {
  if (raw === null) return { raw: null, formatted: null };
  return { raw: raw.toString(), formatted: formatUnits(raw, decimals) };
}

function ratioField(raw: bigint | null): {
  raw: string | null;
  percent: string | null;
} {
  if (raw === null) return { raw: null, percent: null };
  return { raw: raw.toString(), percent: formatRatioPercent(raw) };
}

const MAINNET_ONLY =
  "Liquid Loans USDL reads are mainnet (chain 369) only. This network is not mainnet.";

const NOT_THE_OLD_TROVE =
  "These reads use the current PLS-collateral VaultManager. " +
  `They are not the older PLSX TroveManager at ${LIQUID_LOANS.legacyPlsxTroveManager}. ` +
  "Opening or adjusting a vault is not supported here.";

async function readPrice(
  config: AppConfig,
): Promise<{ ok: true; price: bigint; source: "fetchPrice" | "lastGoodPrice" } | { ok: false; reason: string }> {
  const client = getPublicClient(config);
  const rows = (await client.multicall({
    contracts: [
      {
        address: LIQUID_LOANS.priceFeed,
        abi: PRICE_ABI,
        functionName: "fetchPrice",
      },
      {
        address: LIQUID_LOANS.priceFeed,
        abi: PRICE_ABI,
        functionName: "lastGoodPrice",
      },
    ],
    allowFailure: true,
  })) as MulticallRow[];
  const fetched = rowBigint(rows[0]);
  const last = rowBigint(rows[1]);
  if (fetched !== null && fetched > 0n) {
    return { ok: true, price: fetched, source: "fetchPrice" };
  }
  if (last !== null && last > 0n) {
    return { ok: true, price: last, source: "lastGoodPrice" };
  }
  return {
    ok: false,
    reason: "Liquid Loans price feed did not return a positive price",
  };
}

export async function readLiquidLoansSystem(
  config: AppConfig,
): Promise<Record<string, unknown>> {
  if (chainIdForConfig(config) !== 369) {
    return { ok: false, source: "liquid_loans", reason: MAINNET_ONLY };
  }
  try {
    const price = await readPrice(config);
    if (!price.ok) {
      return { ok: false, source: "liquid_loans", reason: price.reason };
    }
    const client = getPublicClient(config);
    const vm = LIQUID_LOANS.vaultManager;
    const rows = (await client.multicall({
      contracts: [
        { address: vm, abi: READ_ABI, functionName: "getEntireSystemColl" },
        { address: vm, abi: READ_ABI, functionName: "getEntireSystemDebt" },
        {
          address: vm,
          abi: READ_ABI,
          functionName: "getTCR",
          args: [price.price],
        },
        {
          address: vm,
          abi: READ_ABI,
          functionName: "checkRecoveryMode",
          args: [price.price],
        },
        { address: vm, abi: READ_ABI, functionName: "getBorrowingRateWithDecay" },
        { address: vm, abi: READ_ABI, functionName: "getRedemptionRateWithDecay" },
        { address: vm, abi: READ_ABI, functionName: "MCR" },
        { address: vm, abi: READ_ABI, functionName: "CCR" },
        {
          address: LIQUID_LOANS.stabilityPool,
          abi: READ_ABI,
          functionName: "getTotalUSDLDeposits",
        },
      ],
      allowFailure: true,
    })) as MulticallRow[];
    const coll = rowBigint(rows[0]);
    const debt = rowBigint(rows[1]);
    const tcr = rowBigint(rows[2]);
    const recovery =
      rows[3]?.status === "success" ? rows[3].result === true : null;
    return {
      ok: true,
      source: "liquid_loans",
      chainId: 369,
      readOnly: true,
      note: NOT_THE_OLD_TROVE,
      contracts: { ...LIQUID_LOANS },
      price: {
        source: price.source,
        ...amountField(price.price),
        unit: "USD per PLS (1e18)",
      },
      systemCollateralPls: amountField(coll),
      systemDebtUsdl: amountField(debt),
      totalCollateralRatio: ratioField(tcr),
      recoveryMode: recovery,
      borrowingRate: ratioField(rowBigint(rows[4])),
      redemptionRate: ratioField(rowBigint(rows[5])),
      minimumCollateralRatio: ratioField(rowBigint(rows[6])),
      criticalCollateralRatio: ratioField(rowBigint(rows[7])),
      stabilityPoolUsdl: amountField(rowBigint(rows[8])),
    };
  } catch (err) {
    return {
      ok: false,
      source: "liquid_loans",
      reason: err instanceof Error ? err.message : "Liquid Loans system read failed",
    };
  }
}

export async function readLiquidLoansVault(
  config: AppConfig,
  borrower: Address,
): Promise<Record<string, unknown>> {
  if (chainIdForConfig(config) !== 369) {
    return { ok: false, source: "liquid_loans", reason: MAINNET_ONLY };
  }
  try {
    const price = await readPrice(config);
    if (!price.ok) {
      return { ok: false, source: "liquid_loans", reason: price.reason, borrower };
    }
    const client = getPublicClient(config);
    const vm = LIQUID_LOANS.vaultManager;
    const rows = (await client.multicall({
      contracts: [
        {
          address: vm,
          abi: READ_ABI,
          functionName: "getVaultStatus",
          args: [borrower],
        },
        {
          address: vm,
          abi: READ_ABI,
          functionName: "getVaultColl",
          args: [borrower],
        },
        {
          address: vm,
          abi: READ_ABI,
          functionName: "getVaultDebt",
          args: [borrower],
        },
        {
          address: vm,
          abi: READ_ABI,
          functionName: "getCurrentICR",
          args: [borrower, price.price],
        },
        {
          address: vm,
          abi: READ_ABI,
          functionName: "getNominalICR",
          args: [borrower],
        },
      ],
      allowFailure: true,
    })) as MulticallRow[];
    const statusRaw = rowBigint(rows[0]);
    return {
      ok: true,
      source: "liquid_loans",
      chainId: 369,
      readOnly: true,
      note: NOT_THE_OLD_TROVE,
      borrower,
      vaultManager: vm,
      status: statusRaw === null ? null : vaultStatusName(statusRaw),
      statusCode: statusRaw === null ? null : statusRaw.toString(),
      collateralPls: amountField(rowBigint(rows[1])),
      debtUsdl: amountField(rowBigint(rows[2])),
      collateralRatio: ratioField(rowBigint(rows[3])),
      nominalCollateralRatio: ratioField(rowBigint(rows[4])),
      price: {
        source: price.source,
        ...amountField(price.price),
      },
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
