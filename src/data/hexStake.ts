/**
 * HEX stake **read** helpers (on-chain / multi-RPC).
 *
 * - **pHEX** (`HEX_ADDRESS` / state-fork) is the stakeable HEX contract on PulseChain.
 * - **eHEX** (`EHEX_ADDRESS` / bridged) is ERC-20 only — no stakeLists / globals.
 *
 * Price context is never produced here; tools may attach advisory price separately.
 * Fail-soft on RPC / decode errors. Never invents stake state.
 */

import { parseAbi, type Address } from "viem";
import {
  EHEX_ADDRESS,
  HEX_ADDRESS,
  PHEX_ADDRESS,
} from "../constants.js";
import type { AppConfig } from "../types.js";
import { getPublicClient } from "./rpc.js";

/** Minimal HEX stake ABI (view) — Ethereum HEX / PulseChain state-fork. */
export const HEX_STAKE_ABI = parseAbi([
  "function currentDay() view returns (uint256)",
  "function stakeCount(address stakerAddr) view returns (uint256)",
  "function globals() view returns (uint72 lockedHeartsTotal, uint72 nextStakeSharesTotal, uint40 shareRate, uint72 stakePenaltyTotal, uint16 dailyDataCount, uint72 stakeSharesTotal, uint40 latestStakeId, uint128 claimStats)",
  "function stakeLists(address stakerAddr, uint256 stakeIndex) view returns (uint40 stakeId, uint72 stakedHearts, uint72 stakeShares, uint16 lockedDay, uint16 stakedDays, uint16 unlockedDay, bool isAutoStake)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

export type HexContractKind = "phex" | "ehex" | "custom";

export interface HexContractRef {
  address: Address;
  kind: HexContractKind;
  /** Community label used in responses. */
  label: string;
  /** True only when this address is expected to expose stake views. */
  supportsStaking: boolean;
  note: string;
}

export interface HexStakeSoftFail {
  ok: false;
  source: "hex-rpc";
  reason: string;
  contract?: HexContractRef;
  path?: string;
}

export interface HexStakeSuccess<T> {
  ok: true;
  source: "hex-rpc";
  contract: HexContractRef;
  data: T;
}

export type HexStakeResult<T> = HexStakeSuccess<T> | HexStakeSoftFail;

export interface HexGlobalStateData {
  currentDay: string;
  lockedHeartsTotal: string;
  nextStakeSharesTotal: string;
  shareRate: string;
  stakePenaltyTotal: string;
  dailyDataCount: string;
  stakeSharesTotal: string;
  latestStakeId: string;
  claimStats: string;
  /** HEX uses 8 decimals (Hearts). */
  heartsDecimals: 8;
  note: string;
}

export interface HexStakeRow {
  index: number;
  stakeId: string;
  stakedHearts: string;
  stakeShares: string;
  lockedDay: number;
  stakedDays: number;
  unlockedDay: number;
  isAutoStake: boolean;
  /** Convenience: unlockedDay === 0 means still locked (HEX convention). */
  stillLocked: boolean;
}

export interface HexStakesForAddressData {
  staker: Address;
  stakeCount: string;
  stakes: HexStakeRow[];
  truncated: boolean;
  heartsDecimals: 8;
  note: string;
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Resolve pHEX / eHEX / custom address with clear staking support labels.
 * Pure / unit-testable.
 */
export function resolveHexContract(
  which: "phex" | "ehex" | string = "phex",
): HexContractRef {
  const key = which.trim().toLowerCase();
  if (key === "phex" || key === "hex" || key === "ph") {
    return {
      address: HEX_ADDRESS as Address,
      kind: "phex",
      label: "pHEX",
      supportsStaking: true,
      note:
        "pHEX is the PulseChain state-fork HEX at the original Ethereum HEX address. " +
        "Stake state lives here. Distinct from bridged eHEX.",
    };
  }
  if (key === "ehex" || key === "bridged" || key === "bridged_hex") {
    return {
      address: EHEX_ADDRESS as Address,
      kind: "ehex",
      label: "eHEX",
      supportsStaking: false,
      note:
        "eHEX is HEX bridged from Ethereum (ERC-20). It does not expose HEX stake " +
        "views (currentDay/stakeLists). Use contract=phex for stake reads.",
    };
  }
  if (!ADDR_RE.test(which)) {
    throw new Error(
      `Invalid HEX contract selector "${which}". Use phex, ehex, or 0x address.`,
    );
  }
  const addr = which as Address;
  const lower = addr.toLowerCase();
  if (lower === HEX_ADDRESS.toLowerCase() || lower === PHEX_ADDRESS.toLowerCase()) {
    return resolveHexContract("phex");
  }
  if (lower === EHEX_ADDRESS.toLowerCase()) {
    return resolveHexContract("ehex");
  }
  return {
    address: addr,
    kind: "custom",
    label: "custom",
    supportsStaking: true, // attempt; soft-fail if reverts
    note:
      "Custom address — stake views are attempted; may revert if not a HEX-compatible contract.",
  };
}

function bi(v: bigint | number | string): string {
  return typeof v === "bigint" ? v.toString() : String(v);
}

/**
 * Read HEX global stake state (currentDay + globals).
 * Soft-fails for eHEX (no stake interface) and on RPC/revert errors.
 */
export async function getHexGlobalState(
  config: AppConfig,
  which: "phex" | "ehex" | string = "phex",
): Promise<HexStakeResult<HexGlobalStateData>> {
  let contract: HexContractRef;
  try {
    contract = resolveHexContract(which);
  } catch (e) {
    return {
      ok: false,
      source: "hex-rpc",
      reason: e instanceof Error ? e.message : String(e),
      path: "resolveHexContract",
    };
  }

  if (!contract.supportsStaking) {
    return {
      ok: false,
      source: "hex-rpc",
      reason: contract.note,
      contract,
      path: "globals",
    };
  }

  try {
    const client = getPublicClient(config);
    const [currentDay, globals] = await Promise.all([
      client.readContract({
        address: contract.address,
        abi: HEX_STAKE_ABI,
        functionName: "currentDay",
      }),
      client.readContract({
        address: contract.address,
        abi: HEX_STAKE_ABI,
        functionName: "globals",
      }),
    ]);

    const g = globals as readonly [
      bigint,
      bigint,
      number | bigint,
      bigint,
      number | bigint,
      bigint,
      number | bigint,
      bigint,
    ];

    return {
      ok: true,
      source: "hex-rpc",
      contract,
      data: {
        currentDay: bi(currentDay as bigint),
        lockedHeartsTotal: bi(g[0]),
        nextStakeSharesTotal: bi(g[1]),
        shareRate: bi(g[2]),
        stakePenaltyTotal: bi(g[3]),
        dailyDataCount: bi(g[4]),
        stakeSharesTotal: bi(g[5]),
        latestStakeId: bi(g[6]),
        claimStats: bi(g[7]),
        heartsDecimals: 8,
        note:
          "On-chain HEX global state via multi-RPC. Hearts use 8 decimals. " +
          "Not a price oracle; shareRate is protocol-internal.",
      },
    };
  } catch (e) {
    return {
      ok: false,
      source: "hex-rpc",
      reason: e instanceof Error ? e.message : String(e),
      contract,
      path: "currentDay+globals",
    };
  }
}

/**
 * List stakes for an address via stakeCount + stakeLists(index).
 * Caps list length; soft-fails for eHEX / RPC errors.
 */
export async function getHexStakesForAddress(
  config: AppConfig,
  stakerAddr: string,
  options: {
    contract?: "phex" | "ehex" | string;
    /** Max stakes to return (default 25, max 100). */
    limit?: number;
  } = {},
): Promise<HexStakeResult<HexStakesForAddressData>> {
  if (!ADDR_RE.test(stakerAddr)) {
    return {
      ok: false,
      source: "hex-rpc",
      reason: "staker must be a 0x-prefixed 40-hex address",
      path: "staker",
    };
  }

  let contract: HexContractRef;
  try {
    contract = resolveHexContract(options.contract ?? "phex");
  } catch (e) {
    return {
      ok: false,
      source: "hex-rpc",
      reason: e instanceof Error ? e.message : String(e),
      path: "resolveHexContract",
    };
  }

  if (!contract.supportsStaking) {
    return {
      ok: false,
      source: "hex-rpc",
      reason: contract.note,
      contract,
      path: "stakeLists",
    };
  }

  const staker = stakerAddr as Address;
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

  try {
    const client = getPublicClient(config);
    const countRaw = (await client.readContract({
      address: contract.address,
      abi: HEX_STAKE_ABI,
      functionName: "stakeCount",
      args: [staker],
    })) as bigint;
    const count = Number(countRaw);
    const n = Math.min(count, limit);
    const stakes: HexStakeRow[] = [];

    for (let i = 0; i < n; i++) {
      const row = (await client.readContract({
        address: contract.address,
        abi: HEX_STAKE_ABI,
        functionName: "stakeLists",
        args: [staker, BigInt(i)],
      })) as readonly [
        number | bigint,
        bigint,
        bigint,
        number | bigint,
        number | bigint,
        number | bigint,
        boolean,
      ];
      const unlockedDay = Number(row[5]);
      stakes.push({
        index: i,
        stakeId: bi(row[0]),
        stakedHearts: bi(row[1]),
        stakeShares: bi(row[2]),
        lockedDay: Number(row[3]),
        stakedDays: Number(row[4]),
        unlockedDay,
        isAutoStake: Boolean(row[6]),
        stillLocked: unlockedDay === 0,
      });
    }

    return {
      ok: true,
      source: "hex-rpc",
      contract,
      data: {
        staker,
        stakeCount: bi(countRaw),
        stakes,
        truncated: count > limit,
        heartsDecimals: 8,
        note:
          "On-chain HEX stakeLists via multi-RPC. stakedHearts are Hearts (8 decimals). " +
          "stillLocked=true when unlockedDay is 0. Not a price oracle.",
      },
    };
  } catch (e) {
    return {
      ok: false,
      source: "hex-rpc",
      reason: e instanceof Error ? e.message : String(e),
      contract,
      path: "stakeCount+stakeLists",
    };
  }
}

/** Pure helper for tests: encode path labels without RPC. */
export function hexStakeSourceLabel(): "hex-rpc" {
  return "hex-rpc";
}
