/**
 * Read-only pHEX stake summary on top of `hexStake.ts`.
 *
 * Not a second HEX client: stake rows and globals come from
 * `getHexStakesForAddress` / `getHexGlobalState`. Price context uses the
 * existing PulseX `fetchToken` path and, only if that price is missing,
 * PulseChain DexScreener pairs. Ethereum RPC is never called.
 *
 * Yield is an estimate from the current global share rate. It is not the
 * amount `endStake` will pay. Missing day or share rate omits yield.
 */

import {
  EHEX_ADDRESS,
  HEX_ADDRESS,
  PULSECHAIN_CHAIN_ID,
} from "../constants.js";
import type { AppConfig } from "../types.js";
import { getDexScreenerTokenPairs } from "./dexscreener.js";
import type { DexScreenerPairSummary } from "./dexscreener.js";
import {
  getHexGlobalState,
  getHexStakesForAddress,
  type HexStakeResult,
  type HexStakeRow,
} from "./hexStake.js";
import { fetchToken } from "./subgraph.js";

/** HEX Hearts per HEX (`HEARTS_PER_HEX` = 10^8). */
export const HEX_HEARTS_PER_HEX = 100_000_000n;

/**
 * `StakeableToken` `SHARE_RATE_SCALE` (1e5).
 * Shares are minted as `hearts * SHARE_RATE_SCALE / shareRate`.
 * Inverting that with today's global share rate estimates share value in
 * hearts. It is not principal plus daily inflation.
 */
export const HEX_SHARE_RATE_SCALE = 100_000n;

/** Community T-share = 1e12 stake shares. Not a HEX contract field. */
export const HEX_TSHARE_DECIMALS = 12;

/** Existing stake reader cap. Summary does not invent a wider fetch. */
export const HEX_STAKE_SUMMARY_LIST_LIMIT = 100;

export const HEX_STAKE_SUMMARY_VERSION_NOTE =
  "PulseChain pHEX stakes only (chain 369, state-fork HEX at the pHEX contract). " +
  "Not Ethereum eHEX stakes. Bridged eHEX on PulseChain is not listed here.";

export const HEX_STAKE_SUMMARY_TOOL_DESCRIPTION =
  "Read-only summary of PulseChain pHEX stakes for one address (chain 369). " +
  "pHEX stakes only — not Ethereum eHEX stakes. " +
  "Reports days left, ending-soon, approximate T-shares (stakeShares/1e12), principal, " +
  "and a share-rate yield estimate when current day and share rate are both available. " +
  "Every yield figure is an estimate, not the amount endStake will pay. " +
  "Not financial advice. Not an audit, APY promise, or tax report. " +
  "Does not startStake, endStake, or goodAccounting. Research-only read.";

const YIELD_METHOD =
  "estimate: stakeShares * currentGlobalShareRate / 100000 (HEX SHARE_RATE_SCALE). " +
  "This inverts the share-mint formula at today's share rate and includes " +
  "longer/bigger-pays-better bonuses already baked into shares. " +
  "Integer division, same as the EVM. Not principal plus daily inflation, " +
  "and not the amount endStake will pay.";

const DAY_MATH_NOTE =
  "startDay is stakeLists.lockedDay. endDay is lockedDay + stakedDays. " +
  "daysLeft is endDay - currentDay. locked and early are true only when the stake is not ended on-chain and daysLeft > 0 " +
  "(currentDay < endDay), which is HEX's early-end window. Penalty hearts are not calculated. " +
  "late means daysLeft <= 0 and unlockedDay is still 0 (term finished, not ended on-chain). " +
  "endingSoon is daysLeft from 0 through endingWithinDays, soonest first. " +
  "A stake with daysLeft 0 is both endingSoon and late.";

export interface HexStakeSummaryStake {
  index: number;
  stakeId: string;
  stakedHearts: string;
  stakedHex: string;
  principalHearts: string;
  principalHex: string;
  stakeShares: string;
  /** stakeShares / 1e12. Approximate community T-share, not a chain field. */
  approximateTShares: string;
  approximate: true;
  stakedDays: number;
  startDay: number;
  endDay: number;
  daysLeft: number | null;
  /** True when daysLeft > 0. Null when current day is missing. */
  locked: boolean | null;
  /** True when still inside the early-end window (daysLeft > 0) and not ended on-chain. */
  early: boolean | null;
  endedOnChain: boolean;
  isAutoStake: boolean;
  estimatedValueHearts?: string;
  estimatedValueHex?: string;
  estimatedYieldHearts?: string;
  estimatedYieldHex?: string;
  yieldLabel?: "estimate";
  yieldOmittedReason?: string;
}

export interface HexStakeSummaryData {
  chainId: typeof PULSECHAIN_CHAIN_ID;
  contract: "pHEX";
  contractAddress: typeof HEX_ADDRESS;
  versionNote: string;
  heartsDecimals: 8;
  currentDay: string | null;
  shareRate: string | null;
  shareRateScale: "100000";
  globalsUnavailableReason: string | null;
  stakeCount: string;
  truncated: boolean;
  endingWithinDays: number;
  includeEnded: boolean;
  totals: {
    /** Null when an included stake amount did not parse. A zero total is not invented. */
    stakedHearts: string | null;
    stakedHex: string | null;
    stakeShares: string | null;
    approximateTShares: string | null;
    approximate: true;
    /** Integer average of included stakes' stakedHearts. Null when none are included or an amount did not parse. */
    heartsPerStake: string | null;
    hexPerStake: string | null;
    stakesIncluded: number;
    note: string;
  };
  stakes: HexStakeSummaryStake[];
  endingSoon: HexStakeSummaryStake[];
  counts: {
    active: number | null;
    endingSoon: number | null;
    late: number | null;
    endedOnChain: number;
  };
  countsOmittedReason: string | null;
  endedOnChainExcluded: number;
  yield: {
    present: boolean;
    method: string | null;
    omittedReason: string | null;
    notEndStakePayout: true;
  };
  dayMathNote: string;
  priceContext: HexPriceContext;
  disclaimer: string;
}

export interface HexTokenPriceContext {
  symbol: "pHEX" | "eHEX";
  address: string;
  priceUsd: number | null;
  source: "pulsex-subgraph-derivedUSD" | "dexscreener" | null;
  pairAddress?: string;
  note: string | null;
}

export interface HexPriceContext {
  phex: HexTokenPriceContext;
  ehex: HexTokenPriceContext;
  /** pHEX USD / eHEX USD when both prices are finite and positive. */
  premiumMultiple: number | null;
  ethereumRpcCalled: false;
  note: string;
}

export interface SummarizeHexStakesInput {
  stakes: readonly HexStakeRow[];
  stakeCount: string;
  truncated: boolean;
  currentDay: string | null;
  shareRate: string | null;
  endingWithinDays: number;
  includeEnded: boolean;
  globalsUnavailableReason?: string | null;
  priceContext: HexPriceContext;
}

const DISCLAIMER =
  "Estimate only. PulseChain pHEX stakes only, not Ethereum eHEX stakes. " +
  "Not financial advice. Not an audit, APY promise, or tax report. " +
  "Yield is not the amount endStake will pay.";

/** Hearts → HEX display. Trailing zeros trimmed. No rounding. */
export function formatHexFromHearts(hearts: bigint): string {
  return formatScaledUnits(hearts, 8);
}

/** Integer scaled by 10^decimals, trailing zeros trimmed. No rounding. */
export function formatScaledUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  let text = whole.toString();
  if (frac !== 0n) {
    text += "." + frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  }
  return neg ? `-${text}` : text;
}

export function buildHexPriceContext(
  phex: HexTokenPriceContext,
  ehex: HexTokenPriceContext,
): HexPriceContext {
  const phexPrice = usableUsd(phex.priceUsd);
  const ehexPrice = usableUsd(ehex.priceUsd);
  const premium =
    phexPrice != null && ehexPrice != null ? phexPrice / ehexPrice : null;
  const missing: string[] = [];
  if (phexPrice == null) missing.push("pHEX");
  if (ehexPrice == null) missing.push("eHEX");
  const note =
    missing.length > 0
      ? `${missing.join(" and ")} price is missing, so premiumMultiple is null. Ethereum RPC was not called. No price was invented.`
      : "premiumMultiple is pHEX priceUsd divided by eHEX priceUsd. It is not a stake payout and not financial advice. Ethereum RPC was not called.";
  return {
    phex,
    ehex,
    premiumMultiple: premium,
    ethereumRpcCalled: false,
    note,
  };
}

/**
 * Pure summary. Does not read the network.
 * Yield is attached only when both current day and a positive share rate parse.
 */
export function summarizeHexStakes(
  input: SummarizeHexStakesInput,
): HexStakeSummaryData {
  const currentDay = parseDay(input.currentDay);
  const shareRate = parseNonNegBig(input.shareRate);
  const yieldBlockReason = yieldOmittedReason(currentDay, shareRate);
  const dayKnown = currentDay != null;

  const endedOnChain = input.stakes.filter((row) => row.unlockedDay !== 0).length;
  const included = input.stakes.filter(
    (row) => input.includeEnded || row.unlockedDay === 0,
  );
  const endedOnChainExcluded = input.includeEnded ? 0 : endedOnChain;

  const stakes = included.map((row) =>
    toSummaryStake(row, currentDay, shareRate, yieldBlockReason),
  );

  const endingSoon = dayKnown
    ? stakes
        .filter(
          (row) =>
            !row.endedOnChain &&
            row.daysLeft != null &&
            row.daysLeft >= 0 &&
            row.daysLeft <= input.endingWithinDays,
        )
        .sort((a, b) => {
          const d = (a.daysLeft ?? 0) - (b.daysLeft ?? 0);
          return d !== 0 ? d : a.index - b.index;
        })
    : [];

  let stakedHearts = 0n;
  let stakeShares = 0n;
  let heartsOk = true;
  let sharesOk = true;
  for (const row of stakes) {
    const hearts = parseNonNegBig(row.stakedHearts);
    const shares = parseNonNegBig(row.stakeShares);
    if (hearts == null) heartsOk = false;
    else stakedHearts += hearts;
    if (shares == null) sharesOk = false;
    else stakeShares += shares;
  }

  const yieldPresent = stakes.some((row) => row.yieldLabel === "estimate");
  const countsOmittedReason = dayKnown
    ? null
    : "current HEX day is missing, so active, endingSoon, and late counts are omitted. No day math was invented.";

  const totalsNote = input.truncated
    ? "Totals cover only the stakeLists page returned (index order, capped). " +
      "They are not the full address. approximateTShares is stakeShares / 1e12."
    : "Totals cover the stakes included in this summary. " +
      "approximateTShares is stakeShares / 1e12 (community T-share, approximate). " +
      "heartsPerStake is the integer average of included stakedHearts.";

  return {
    chainId: PULSECHAIN_CHAIN_ID,
    contract: "pHEX",
    contractAddress: HEX_ADDRESS,
    versionNote: HEX_STAKE_SUMMARY_VERSION_NOTE,
    heartsDecimals: 8,
    currentDay: dayKnown ? String(currentDay) : null,
    shareRate: shareRate != null ? shareRate.toString() : null,
    shareRateScale: "100000",
    globalsUnavailableReason: input.globalsUnavailableReason ?? null,
    stakeCount: input.stakeCount,
    truncated: input.truncated,
    endingWithinDays: input.endingWithinDays,
    includeEnded: input.includeEnded,
    totals: {
      stakedHearts: heartsOk ? stakedHearts.toString() : null,
      stakedHex: heartsOk ? formatHexFromHearts(stakedHearts) : null,
      stakeShares: sharesOk ? stakeShares.toString() : null,
      approximateTShares: sharesOk
        ? formatScaledUnits(stakeShares, HEX_TSHARE_DECIMALS)
        : null,
      approximate: true,
      heartsPerStake:
        heartsOk && stakes.length > 0
          ? (stakedHearts / BigInt(stakes.length)).toString()
          : null,
      hexPerStake:
        heartsOk && stakes.length > 0
          ? formatHexFromHearts(stakedHearts / BigInt(stakes.length))
          : null,
      stakesIncluded: stakes.length,
      note:
        heartsOk && sharesOk
          ? totalsNote
          : `${totalsNote} A stake amount did not parse, so that total is null.`,
    },
    stakes,
    endingSoon,
    counts: {
      active: dayKnown
        ? stakes.filter((row) => !row.endedOnChain && row.daysLeft != null && row.daysLeft > 0)
            .length
        : null,
      endingSoon: dayKnown ? endingSoon.length : null,
      late: dayKnown
        ? stakes.filter(
            (row) => !row.endedOnChain && row.daysLeft != null && row.daysLeft <= 0,
          ).length
        : null,
      endedOnChain,
    },
    countsOmittedReason,
    endedOnChainExcluded,
    yield: {
      present: yieldPresent,
      method: yieldPresent ? YIELD_METHOD : null,
      omittedReason: yieldPresent ? null : yieldBlockReason,
      notEndStakePayout: true,
    },
    dayMathNote: DAY_MATH_NOTE,
    priceContext: input.priceContext,
    disclaimer: DISCLAIMER,
  };
}

export async function getHexStakeSummary(
  config: AppConfig,
  stakerAddr: string,
  options: {
    endingWithinDays?: number;
    includeEnded?: boolean;
  } = {},
): Promise<HexStakeResult<HexStakeSummaryData>> {
  const endingWithinDays = options.endingWithinDays ?? 30;
  const includeEnded = options.includeEnded === true;
  if (
    !Number.isInteger(endingWithinDays) ||
    endingWithinDays < 0 ||
    endingWithinDays > 5555
  ) {
    return {
      ok: false,
      source: "hex-rpc",
      reason: "endingWithinDays must be an integer from 0 to 5555",
      path: "endingWithinDays",
    };
  }

  const stakesResult = await getHexStakesForAddress(config, stakerAddr, {
    contract: "phex",
    limit: HEX_STAKE_SUMMARY_LIST_LIMIT,
  });
  if (!stakesResult.ok) return stakesResult;

  const [globals, priceContext] = await Promise.all([
    getHexGlobalState(config, "phex"),
    loadHexPriceContext(config),
  ]);

  const data = summarizeHexStakes({
    stakes: stakesResult.data.stakes,
    stakeCount: stakesResult.data.stakeCount,
    truncated: stakesResult.data.truncated,
    currentDay: globals.ok ? globals.data.currentDay : null,
    shareRate: globals.ok ? globals.data.shareRate : null,
    endingWithinDays,
    includeEnded,
    globalsUnavailableReason: globals.ok ? null : clip(globals.reason),
    priceContext,
  });

  return {
    ok: true,
    source: "hex-rpc",
    contract: stakesResult.contract,
    data,
  };
}

function toSummaryStake(
  row: HexStakeRow,
  currentDay: number | null,
  shareRate: bigint | null,
  yieldBlockReason: string | null,
): HexStakeSummaryStake {
  const endedOnChain = row.unlockedDay !== 0;
  const startDay = row.lockedDay;
  const endDay = row.lockedDay + row.stakedDays;
  const daysLeft = currentDay == null ? null : endDay - currentDay;
  const open = !endedOnChain && daysLeft != null && daysLeft > 0;
  const base: HexStakeSummaryStake = {
    index: row.index,
    stakeId: row.stakeId,
    stakedHearts: row.stakedHearts,
    stakedHex: displayHearts(row.stakedHearts),
    principalHearts: row.stakedHearts,
    principalHex: displayHearts(row.stakedHearts),
    stakeShares: row.stakeShares,
    approximateTShares: displayTShares(row.stakeShares),
    approximate: true,
    stakedDays: row.stakedDays,
    startDay,
    endDay,
    daysLeft,
    locked: daysLeft == null ? null : open,
    early: daysLeft == null ? null : open,
    endedOnChain,
    isAutoStake: row.isAutoStake,
  };

  if (yieldBlockReason) {
    return { ...base, yieldOmittedReason: yieldBlockReason };
  }

  const hearts = parseNonNegBig(row.stakedHearts);
  const shares = parseNonNegBig(row.stakeShares);
  if (hearts == null || shares == null || shareRate == null) {
    return {
      ...base,
      yieldOmittedReason:
        "stakedHearts or stakeShares is not an integer; yield omitted for this stake. No payout was invented.",
    };
  }

  const estimatedValue = (shares * shareRate) / HEX_SHARE_RATE_SCALE;
  const estimatedYield = estimatedValue - hearts;
  return {
    ...base,
    estimatedValueHearts: estimatedValue.toString(),
    estimatedValueHex: formatHexFromHearts(estimatedValue),
    estimatedYieldHearts: estimatedYield.toString(),
    estimatedYieldHex: formatHexFromHearts(estimatedYield),
    yieldLabel: "estimate",
  };
}

function yieldOmittedReason(
  currentDay: number | null,
  shareRate: bigint | null,
): string | null {
  if (currentDay != null && shareRate != null && shareRate > 0n) return null;
  const parts: string[] = [];
  if (currentDay == null) parts.push("current HEX day is missing");
  if (shareRate == null) parts.push("share rate is missing");
  else if (shareRate === 0n) parts.push("share rate is zero");
  return `${parts.join(" and ")}; yield omitted. This is not an endStake payout and none was invented.`;
}

function displayHearts(raw: string): string {
  const hearts = parseNonNegBig(raw);
  return hearts == null ? raw : formatHexFromHearts(hearts);
}

function displayTShares(raw: string): string {
  const shares = parseNonNegBig(raw);
  return shares == null ? raw : formatScaledUnits(shares, HEX_TSHARE_DECIMALS);
}

function parseDay(raw: string | null): number | null {
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function parseNonNegBig(raw: string | null): bigint | null {
  if (raw == null || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

async function loadHexPriceContext(config: AppConfig): Promise<HexPriceContext> {
  const [phex, ehex] = await Promise.all([
    loadTokenPrice(config, HEX_ADDRESS, "pHEX"),
    loadTokenPrice(config, EHEX_ADDRESS, "eHEX"),
  ]);
  return buildHexPriceContext(phex, ehex);
}

async function loadTokenPrice(
  config: AppConfig,
  address: string,
  symbol: "pHEX" | "eHEX",
): Promise<HexTokenPriceContext> {
  let subgraphNote: string;
  try {
    const res = await fetchToken(config, address, "v2");
    const price = positiveFinite(res.token?.derivedUSD);
    if (price != null) {
      return {
        symbol,
        address,
        priceUsd: price,
        source: "pulsex-subgraph-derivedUSD",
        note: null,
      };
    }
    subgraphNote = res.token
      ? "PulseX v2 derivedUSD missing or not positive"
      : "token not on PulseX v2 subgraph";
  } catch (err) {
    subgraphNote = `PulseX price unavailable (${shortError(err)})`;
  }

  try {
    const dex = await getDexScreenerTokenPairs(config, address);
    if (!dex.ok) {
      return missingPrice(
        symbol,
        address,
        `${subgraphNote}. DexScreener: ${dex.reason}. Ethereum RPC was not called.`,
      );
    }
    const best = bestBasePrice(dex.data.pairs, address);
    if (!best) {
      return missingPrice(
        symbol,
        address,
        `${subgraphNote}. DexScreener had no PulseChain pair pricing this token as the base. Ethereum RPC was not called.`,
      );
    }
    return {
      symbol,
      address,
      priceUsd: best.priceUsd,
      source: "dexscreener",
      pairAddress: best.pairAddress,
      note: subgraphNote,
    };
  } catch (err) {
    return missingPrice(
      symbol,
      address,
      `${subgraphNote}. DexScreener failed (${shortError(err)}). Ethereum RPC was not called.`,
    );
  }
}

function missingPrice(
  symbol: "pHEX" | "eHEX",
  address: string,
  note: string,
): HexTokenPriceContext {
  return {
    symbol,
    address,
    priceUsd: null,
    source: null,
    note,
  };
}

function bestBasePrice(
  pairs: readonly DexScreenerPairSummary[],
  token: string,
): { priceUsd: number; pairAddress: string } | null {
  const want = token.toLowerCase();
  let best: { priceUsd: number; pairAddress: string; liquidityUsd: number } | null =
    null;
  for (const pair of pairs) {
    if (pair.baseToken.address.toLowerCase() !== want) continue;
    const price = positiveFinite(pair.priceUsd);
    if (price == null) continue;
    const liquidity =
      typeof pair.liquidity?.usd === "number" && Number.isFinite(pair.liquidity.usd)
        ? pair.liquidity.usd
        : 0;
    if (!best || liquidity > best.liquidityUsd) {
      best = { priceUsd: price, pairAddress: pair.pairAddress, liquidityUsd: liquidity };
    }
  }
  return best;
}

function usableUsd(price: number | null): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  return price;
}

function positiveFinite(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function shortError(err: unknown): string {
  return clip(err instanceof Error ? err.message : String(err), 180);
}

function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
