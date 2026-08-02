import type { AppConfig, TokenBalance } from "../../../types.js";
import type { TokenHolderItem } from "../../../data/index.js";
import { assertAddress } from "../../../utils/safety.js";
import { SHARE_TOLERANCE } from "./constants.js";
import {
  asRecord,
  formatRawUnits,
  numberOrNull,
  parseRawBigInt,
  parseStrictRawBigInt,
  round,
  stringOrNull,
} from "./math.js";
import type {
  CaptureResult,
  ContractSupplyFields,
  HolderMetrics,
  LabeledBalance,
  PhiatDashboardDeps,
} from "./builder.js";

export function normalizeAddressList(addresses: string[] | undefined): string[] {
  if (!addresses?.length) return [];
  const unique = new Map<string, string>();
  for (const address of addresses.slice(0, 25)) {
    const normalized = assertAddress(address).toLowerCase();
    unique.set(normalized, normalized);
  }
  return [...unique.values()];
}

export async function readLabeledBalances(
  config: AppConfig,
  deps: PhiatDashboardDeps,
  capture: <T>(source: string, task: () => Promise<T>) => Promise<CaptureResult<T>>,
  tokenAddress: string,
  addresses: string[],
  label: LabeledBalance["label"],
  decimals: number | null,
  priceUsd: number | null,
): Promise<LabeledBalance[]> {
  if (addresses.length === 0) return [];

  return Promise.all(
    addresses.map(async (address) => {
      const res = await capture(`rpc_multicall.balanceOf.${label}.${address}`, () =>
        deps.batchErc20Balances(config, address, [tokenAddress], false),
      );
      const balance = Array.isArray(res.data) ? res.data[0] : undefined;
      return normalizeBalance(address, label, balance, decimals, priceUsd);
    }),
  );
}

export function normalizeBalance(
  address: string,
  label: LabeledBalance["label"],
  balance: TokenBalance | undefined,
  decimals: number | null,
  priceUsd: number | null,
): LabeledBalance {
  if (!balance || balance.balanceOk === false) {
    return {
      address,
      label,
      balanceRaw: null,
      balanceFormatted: null,
      balanceOk: false,
      balanceUsd: null,
      note: "Balance unavailable; this is not treated as a confirmed zero.",
    };
  }
  const raw = balance.balanceRaw;
  const formatted =
    balance.balanceFormatted ?? formatRawUnits(raw, decimals ?? balance.decimals);
  const amount = numberOrNull(formatted);
  return {
    address,
    label,
    balanceRaw: raw,
    balanceFormatted: formatted,
    balanceOk: true,
    balanceUsd:
      amount !== null && priceUsd !== null ? round(amount * priceUsd, 8) : null,
    note:
      raw === "0"
        ? "Confirmed zero balance from RPC/multicall."
        : "Caller supplied this address label; the tool did not verify the classification.",
  };
}

export function estimateExcludedSupply(
  balances: LabeledBalance[],
  decimals: number | null,
): { raw: string; formatted: string | null; source: string; includedAddresses: string[] } | null {
  const okBalances = balances.filter((b) => b.balanceOk && b.balanceRaw !== null);
  if (okBalances.length === 0) return null;
  let total = 0n;
  for (const balance of okBalances) {
    total += parseRawBigInt(balance.balanceRaw);
  }
  return {
    raw: total.toString(),
    formatted: formatRawUnits(total.toString(), decimals),
    source: "user_supplied_treasury_and_staking_addresses",
    includedAddresses: okBalances.map((b) => b.address),
  };
}

export function resolveContractSupply(
  tokenEntity: { totalSupply?: string } | null,
  overview: { totalSupply?: string | null } | null,
  decimals: number | null,
): Pick<
  ContractSupplyFields,
  "contractTotalSupplyRaw" | "contractTotalSupplyFormatted" | "contractTotalSupplySource"
> {
  const subgraphSupply = stringOrNull(tokenEntity?.totalSupply);
  const explorerSupply = stringOrNull(overview?.totalSupply);
  const raw = subgraphSupply ?? explorerSupply;
  return {
    contractTotalSupplyRaw: raw,
    contractTotalSupplyFormatted: formatRawUnits(raw, decimals),
    contractTotalSupplySource: subgraphSupply
      ? "pulsex_subgraph.token.totalSupply"
      : explorerSupply
        ? "blockscout.tokenOverview.totalSupply"
        : null,
  };
}

export function buildSupplyFields(
  base: Pick<
    ContractSupplyFields,
    "contractTotalSupplyRaw" | "contractTotalSupplyFormatted" | "contractTotalSupplySource"
  >,
  excludedSupplyEstimate: ContractSupplyFields["excludedSupplyEstimate"],
  decimals: number | null,
): ContractSupplyFields {
  let circulatingSupplyEstimate: ContractSupplyFields["circulatingSupplyEstimate"] = null;
  let circulatingSupplyMethod: string | null = null;
  if (base.contractTotalSupplyRaw && excludedSupplyEstimate?.raw) {
    const circulatingRaw = parseRawBigInt(base.contractTotalSupplyRaw) -
      parseRawBigInt(excludedSupplyEstimate.raw);
    if (circulatingRaw >= 0n) {
      circulatingSupplyEstimate = {
        raw: circulatingRaw.toString(),
        formatted: formatRawUnits(circulatingRaw.toString(), decimals),
      };
      circulatingSupplyMethod =
        "contractTotalSupplyRaw - excludedSupplyEstimate.raw from user-supplied treasury/staking labels";
    } else {
      circulatingSupplyMethod =
        "unavailable: excludedSupplyEstimate exceeds contractTotalSupplyRaw";
    }
  } else {
    circulatingSupplyMethod =
      "unavailable: no user-supplied excluded supply addresses were successfully read";
  }

  return {
    ...base,
    maximumSupply: null,
    circulatingSupplyEstimate,
    circulatingSupplyMethod,
    excludedSupplyEstimate,
  };
}


export function buildHolderMetrics(input: {
  holders: TokenHolderItem[];
  contractTotalSupplyRaw: string | null;
  decimals: number | null;
  denominatorSource: string | null;
  holderSource: string | null;
  sourceAvailable: boolean;
}): HolderMetrics {
  const errors: string[] = [];
  if (!input.sourceAvailable) {
    errors.push("holder_endpoint_unavailable");
  }
  if (input.decimals === null) {
    errors.push("token_decimals_unavailable");
  }
  if (!input.contractTotalSupplyRaw) {
    errors.push("contract_total_supply_unavailable");
  }

  const denominatorRaw = parseStrictRawBigInt(input.contractTotalSupplyRaw);
  if (input.contractTotalSupplyRaw && denominatorRaw === null) {
    errors.push("contract_total_supply_unparseable_raw_units");
  }
  if (denominatorRaw !== null && denominatorRaw <= 0n) {
    errors.push("contract_total_supply_non_positive");
  }

  const denominatorReady =
    input.sourceAvailable &&
    input.decimals !== null &&
    denominatorRaw !== null &&
    denominatorRaw > 0n;
  const deduped = new Map<
    string,
    {
      address: string;
      balanceRawBigInt: bigint;
      balanceRaw: string;
      balanceFormatted: string | null;
      share: number | null;
    }
  >();

  for (const holder of input.holders) {
    const address = normalizeHolderAddress(holder);
    if (!address) {
      errors.push("holder_address_unavailable");
      continue;
    }
    const key = address.toLowerCase();
    if (deduped.has(key)) {
      errors.push(`duplicate_holder_address_deduped:${key}`);
      continue;
    }

    const balanceRawText = normalizeHolderBalanceRaw(holder);
    const balanceRawBigInt = parseStrictRawBigInt(balanceRawText);
    if (balanceRawBigInt === null) {
      errors.push(`holder_balance_unparseable_raw_units:${key}`);
      continue;
    }

    const holderSupplyRaw = normalizeHolderSupplyRaw(holder);
    if (holderSupplyRaw !== null) {
      const holderSupply = parseStrictRawBigInt(holderSupplyRaw);
      if (holderSupply === null) {
        errors.push(`holder_token_total_supply_unparseable_raw_units:${key}`);
      } else if (denominatorRaw !== null && holderSupply !== denominatorRaw) {
        errors.push(`holder_token_total_supply_mismatch:${key}`);
      }
    }

    const share = denominatorReady
      ? shareRatio(balanceRawBigInt, denominatorRaw)
      : null;
    if (share !== null && (share < 0 || share > 1 + SHARE_TOLERANCE)) {
      errors.push(`holder_share_out_of_range:${key}`);
    }

    deduped.set(key, {
      address: key,
      balanceRawBigInt,
      balanceRaw: balanceRawBigInt.toString(),
      balanceFormatted: formatRawUnits(balanceRawBigInt.toString(), input.decimals),
      share:
        share !== null && share >= 0 && share <= 1 + SHARE_TOLERANCE
          ? Math.min(1, share)
          : null,
    });
  }

  const holderRows = [...deduped.values()].sort((a, b) =>
    b.balanceRawBigInt === a.balanceRawBigInt
      ? 0
      : b.balanceRawBigInt > a.balanceRawBigInt
        ? 1
        : -1,
  );
  if (input.sourceAvailable && holderRows.length === 0) {
    errors.push("holder_sample_empty");
  }

  const cumulativeRaw = holderRows
    .slice(0, 10)
    .reduce((sum, holder) => sum + holder.balanceRawBigInt, 0n);
  const cumulativeShare = denominatorReady
    ? shareRatio(cumulativeRaw, denominatorRaw)
    : null;
  if (
    cumulativeShare !== null &&
    (cumulativeShare < 0 || cumulativeShare > 1 + SHARE_TOLERANCE)
  ) {
    errors.push("holder_cumulative_share_out_of_range");
  }

  const criticalErrors = errors.filter(
    (error) => !error.startsWith("duplicate_holder_address_deduped:"),
  );
  const holderMetricsValid =
    denominatorReady && holderRows.length > 0 && criticalErrors.length === 0;
  const concentrationUsable =
    holderMetricsValid &&
    cumulativeShare !== null &&
    cumulativeShare >= 0 &&
    cumulativeShare <= 1 + SHARE_TOLERANCE;

  return {
    topHolderShare: concentrationUsable ? (holderRows[0]?.share ?? null) : null,
    top10HolderShare: concentrationUsable ? Math.min(1, cumulativeShare) : null,
    holderMetricsValid,
    holderMetricErrors: [...new Set(errors)],
    holderSource: input.holderSource,
    holderSampleSize: holderRows.length,
    denominatorSupply: {
      raw: input.contractTotalSupplyRaw,
      formatted: formatRawUnits(input.contractTotalSupplyRaw, input.decimals),
      decimals: input.decimals,
      source: input.denominatorSource,
    },
    holders: holderRows.map((holder) => ({
      address: holder.address,
      balanceRaw: holder.balanceRaw,
      balanceFormatted: holder.balanceFormatted,
      share: concentrationUsable ? holder.share : null,
    })),
  };
}


export function normalizeHolderAddress(holder: TokenHolderItem): string | null {
  const rec = asRecord(holder);
  const address = rec.address;
  const raw =
    typeof address === "string"
      ? address
      : stringOrNull(asRecord(address).hash ?? asRecord(address).address);
  if (!raw || !/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
  return raw.toLowerCase();
}

export function normalizeHolderBalanceRaw(holder: TokenHolderItem): string | null {
  const rec = asRecord(holder);
  return stringOrNull(rec.value ?? rec.balanceRaw ?? rec.balance);
}

export function normalizeHolderSupplyRaw(holder: TokenHolderItem): string | null {
  const rec = asRecord(holder);
  const token = asRecord(rec.token);
  return stringOrNull(token.total_supply ?? token.totalSupply);
}

export function shareRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return Number.NaN;
  const scale = 1_000_000_000_000n;
  return Number((numerator * scale) / denominator) / Number(scale);
}
