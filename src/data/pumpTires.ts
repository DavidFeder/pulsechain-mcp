/**
 * Read-only Pump.tires coin status on chain 369.
 *
 * Factory address (not published; not guessed):
 * 0x6538A83a81d855B965983161AF6a83e616D16fD5
 * BlockScout `is_verified` is false for that contract. It was identified from
 * creation transactions of coins first listed by https://api2.pump.tires/api/tokens
 * (source pump-tires-api, discovery_only). Chain data decided the address:
 * - 0x1B7Cd1Cc63964f48A362fB48E488fA1B564E5be8 (BlockScout contract name Token)
 *   creation tx 0x09ac203609938f1bb8759d4907a1df1151d69cba84d8df2f241284f95b90ff19
 *   is a call to this contract, selector 0x2f2f2d56 `createToken(string,string)`.
 * - The same creator contract deployed other checked coins
 *   (0x8d7ef9e82adcd5bf38358e3f58e54bc1cb845974,
 *    0xd21d5dd79f7fdd54b24ba8e1ec74aae4cc597650).
 * - `tokens(address)` on this contract returned the creation-tx sender for
 *   those coins, and the zero address for PLSX, WPLS, pHEX, and platform PUMP.
 *
 * TaxedBondingCurveFactoryUpgradeable at
 * 0xa1203Bc02662E5f86469B09e80ba7fa651f09a39 is a different verified contract
 * with different bytecode. It is not used here.
 *
 * The coin template verified on BlockScout as `Token` exposes `launched()` and
 * `owner()`. It does not expose a PLS trade-burn. A 1% trade burn from
 * secondary writeups is not reported.
 *
 * This module's ABI is view-only. It does not encode create, buy, sell, burn,
 * or launch.
 */

import {
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import {
  EHEX_ADDRESS,
  HEX_ADDRESS,
  PLSX_ADDRESS,
  PULSECHAIN_CHAIN_ID,
  WPLS_ADDRESS,
} from "../constants.js";
import type { AppConfig } from "../types.js";
import { AppError, PolicyError } from "../utils/errors.js";
import { assertAddress } from "../utils/safety.js";
import { getDexScreenerTokenPairs } from "./dexscreener.js";
import { getChainId, getPublicClient } from "./rpc.js";
import { fetchToken } from "./subgraph.js";

/** Creation-tx factory. Source is not verified on BlockScout. */
export const PUMP_TIRES_FACTORY =
  "0x6538A83a81d855B965983161AF6a83e616D16fD5" as const satisfies Address;

/** Platform token. Same Token template bytecode, not a factory-registered coin. */
export const PUMP_TIRES_PLATFORM_TOKEN =
  "0xec4252e62C6dE3D655cA9Ce3AfC12E553ebBA274" as const satisfies Address;

/**
 * Platform PUMP/WPLS PulseX pair. token0/token1 were read on chain before
 * this address was fixed. It is not a launched-coin graduation pair.
 */
export const PUMP_TIRES_PLATFORM_PULSEX_PAIR =
  "0x96Fefb743B1D180363404747bf09BD32657D8B78" as const satisfies Address;

export const PUMP_TIRES_LP_DEAD_ADDRESS =
  "0x000000000000000000000000000000000000dEaD" as const satisfies Address;

/**
 * Runtime codehash of the BlockScout-verified Token template
 * (coin 0x1B7Cd1Cc63964f48A362fB48E488fA1B564E5be8, contract name Token).
 * Other checked factory coins matched this hash. Platform PUMP matches it too
 * and is excluded by address, not by bytecode.
 */
export const PUMP_TIRES_TOKEN_TEMPLATE_CODEHASH =
  "0x2ad3373e76aeb21206440751d44d4a5756e7572af5c0fbbc6726d339514282fe" as const;

/** Documented launch supply. Current `totalSupply` can be lower after burns. */
export const PUMP_TIRES_DOCUMENTED_SUPPLY_TOKENS = 1_000_000_000n;

/** Documented graduation bid. Not an on-chain constant on the live factory. */
export const PUMP_TIRES_DOCUMENTED_BID_PLS = 200_000_000n;

const TOKEN_WEI = 10n ** 18n;

export const PUMP_TIRES_FACTORY_VIEWS = [
  "function TOTAL_SUPPLY() view returns (uint256)",
  "function tokens(address) view returns (address)",
  "function plsReceived(address) view returns (uint256)",
  "function LAUNCH_THRESHOLD() view returns (uint256)",
] as const;

export const PUMP_TIRES_TOKEN_VIEWS = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function launched() view returns (bool)",
] as const;

export const PUMP_TIRES_PAIR_VIEWS = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
] as const;

export const PUMP_TIRES_CREATOR_REWARD_NOTE =
  "documented as 1% of PLS liquidity at graduation";

export const PUMP_TIRES_TRADE_BURN_NOTE =
  "The verified token template ABI does not expose a PLS trade-burn. A 1% figure from secondary writeups is not reported.";

export const PUMP_TIRES_TOOL_DESCRIPTION =
  "Read-only Pump.tires coin status on chain 369. " +
  "Answers whether this address is still on the bonding curve or has graduated. " +
  "The platform PUMP token is labeled as the platform token and is not a launched coin. " +
  "An address the creation-tx factory does not list is not marked graduated. " +
  "Progress is bid PLS versus the documented 200,000,000 PLS only when plsReceived returns a number. " +
  "Does not create, buy, or burn a coin, and does not prepare a swap. " +
  "Meme coin. Discovery only. Not financial advice, not a safety score, and not a buy signal.";

const FACTORY_NOTE =
  "Factory address verified from BlockScout creation transactions of known coins " +
  "(creator and tx.to), including creation tx 0x09ac203609938f1bb8759d4907a1df1151d69cba84d8df2f241284f95b90ff19 " +
  "for token 0x1B7Cd1Cc63964f48A362fB48E488fA1B564E5be8. " +
  "Those sample coins were first seen on the pump.tires indexer (source pump-tires-api, discovery_only). " +
  "This tool does not call the indexer. Chain reads win. " +
  "Factory source code is not verified on BlockScout. A different verified factory was not substituted.";

const FACTORY_FINGERPRINT_NOTE =
  "The creation-tx factory did not return TOTAL_SUPPLY() of 1000000000 tokens, or it has no code. " +
  "Factory is null. Another factory was not guessed. This address was not marked graduated.";

const PAIR_NOTE_ABSENT =
  "pulsexPair is null. The live factory bytecode has no verified pair view, and PulseX getPair was not used. " +
  "Indexer pair addresses are not copied.";

const CURVE_BURN_NOTE =
  "Documented: before graduation, holders can burn coins for a portion of the PLS under the curve. That path ends at graduation. This tool does not burn.";

const LP_DOC_NOTE =
  "Documented: at graduation, LP tokens are burned (not a timed lock). lpBurned is true only when an LP balance was read at the dead or zero address.";

const SUPPLY_NOTE =
  "Documented launch supply is 1_000_000_000. totalSupply is the current ERC-20 reading and can be lower after burns.";

const PROGRESS_NOTE =
  "Percent is bid liquidity PLS versus the documented 200_000_000 PLS, capped at 100. " +
  "The live factory source is not verified. LAUNCH_THRESHOLD() is reported separately when that view returns, and it is not used as this denominator. " +
  "Phase comes from the verified token template launched() view, not from this percent. " +
  "plsReceived is not PulseX pool reserves and not a price.";

export type PumpPhase = "bonding" | "graduated" | "unknown";
export type TriState = true | false | "unknown";

export interface PumpTiresProgress {
  bidLiquidityPls: string;
  bidLiquidityWei: string;
  thresholdPls: "200000000";
  percent: number;
  documented: true;
  note: string;
}

export interface PumpTiresAdvisoryPrice {
  advisory: true;
  priceUsd: number | null;
  source: "pulsex-subgraph-derivedUSD" | "dexscreener" | null;
  note: string;
  appliedToPhase: false;
  buySignal: false;
}

export interface PumpTiresCoinReport {
  chainId: typeof PULSECHAIN_CHAIN_ID;
  token: Address;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  totalSupply: string | null;
  totalSupplyRaw: string | null;
  isPlatformPump: boolean;
  isPumpTiresCoin: boolean;
  /** True only for a coin the verified factory lists. False for platform PUMP. */
  isLaunchedCoin: boolean;
  summary: string;
  factory: {
    address: typeof PUMP_TIRES_FACTORY;
    verified: true;
    verification: "creation-transaction";
    sourceVerified: false;
    note: string;
    evidence: {
      sampleToken: "0x1B7Cd1Cc63964f48A362fB48E488fA1B564E5be8";
      sampleCreationTx: "0x09ac203609938f1bb8759d4907a1df1151d69cba84d8df2f241284f95b90ff19";
      indexer: "pump-tires-api";
      indexerUse: "discovery_only";
    };
  } | null;
  factoryNote: string;
  /** tokens(address) when the factory lists this coin. */
  creator: Address | null;
  phase: PumpPhase;
  progress: PumpTiresProgress | null;
  graduated: TriState;
  launchThreshold: {
    raw: string;
    wholeTokens: string | null;
    note: string;
  } | null;
  pulsexPair: Address | null;
  pulsexPairNote: string;
  lpBurned: true | "unknown";
  lpBurnNote: string;
  owner: Address | null;
  ownerRenounced: TriState;
  creatorRewardNote: typeof PUMP_TIRES_CREATOR_REWARD_NOTE;
  creatorRewardMeasured: false;
  tradeBurnNote: typeof PUMP_TIRES_TRADE_BURN_NOTE;
  tradeBurnReported: false;
  supplyNote: string;
  curveBurnNote: string;
  templateCodehashMatches: boolean;
  advisoryPrice: PumpTiresAdvisoryPrice;
  indexer: {
    consulted: false;
    source: null;
    note: string;
  };
  warnings: string[];
  financialAdvice: false;
  safetyScore: false;
  buySignal: false;
  swapPrepared: false;
  calledCreate: false;
  calledBuy: false;
  calledBurn: false;
}

export interface PumpTiresPairReading {
  address: Address;
  token0: Address | null;
  token1: Address | null;
  lpDeadRaw: bigint | null;
  lpZeroRaw: bigint | null;
}

export interface PumpTiresReportInput {
  token: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupplyRaw: bigint | null;
  /** TOTAL_SUPPLY() returned 1_000_000_000 tokens on the creation-tx factory. */
  factoryFingerprintOk: boolean;
  /** tokens(address). Null when the call failed. Zero means not listed. */
  factoryCreator: Address | null;
  templateCodehashMatches: boolean;
  launched: boolean | null;
  owner: Address | null;
  /** plsReceived wei. Null when the view was not used or did not return. */
  bidLiquidityWei: bigint | null;
  launchThresholdRaw: bigint | null;
  platformPair: PumpTiresPairReading | null;
  advisoryPrice: PumpTiresAdvisoryPrice;
}

export function progressPercentFromWholePls(
  bidLiquidityPls: bigint,
  thresholdPls: bigint = PUMP_TIRES_DOCUMENTED_BID_PLS,
): number {
  if (bidLiquidityPls < 0n || thresholdPls <= 0n) {
    throw new PolicyError(
      "Refusing Pump.tires progress: bid liquidity or threshold is not a positive reading.",
    );
  }
  const percent = (bidLiquidityPls * 100n) / thresholdPls;
  if (percent > 100n) return 100;
  return Number(percent);
}

export function interpretOwnerRenounced(
  owner: Address | null,
  templateTrusted: boolean,
): TriState {
  if (!templateTrusted || owner === null) return "unknown";
  return getAddress(owner) === zeroAddress ? true : false;
}

export function interpretLpBurned(
  deadRaw: bigint | null,
  zeroRaw: bigint | null,
): true | "unknown" {
  if ((deadRaw !== null && deadRaw > 0n) || (zeroRaw !== null && zeroRaw > 0n)) {
    return true;
  }
  return "unknown";
}

export function isPlatformPumpAddress(token: string): boolean {
  return isAddress(token) && getAddress(token) === PUMP_TIRES_PLATFORM_TOKEN;
}

export function buildPumpTiresCoinReport(
  input: PumpTiresReportInput,
): PumpTiresCoinReport {
  const token = checksumOrThrow(input.token);
  const isPlatformPump = token === PUMP_TIRES_PLATFORM_TOKEN;
  const creator = nonZeroAddress(input.factoryCreator);
  const isPumpTiresCoin = input.factoryFingerprintOk && creator !== null && !isPlatformPump;
  const templateTrusted = input.templateCodehashMatches && !isPlatformPump && isPumpTiresCoin;
  const launched = templateTrusted ? input.launched : null;

  let phase: PumpPhase = "unknown";
  let graduated: TriState = "unknown";
  if (templateTrusted && launched === true) {
    phase = "graduated";
    graduated = true;
  } else if (templateTrusted && launched === false) {
    phase = "bonding";
    graduated = false;
  }

  const progress =
    isPumpTiresCoin && input.bidLiquidityWei !== null && input.bidLiquidityWei >= 0n
      ? progressFromWei(input.bidLiquidityWei)
      : null;

  const platformPair = isPlatformPump ? acceptedPlatformPair(input.platformPair) : null;
  const pulsexPair = platformPair?.address ?? null;

  const owner = templateTrusted || (isPlatformPump && input.templateCodehashMatches)
    ? nullableAddress(input.owner)
    : null;
  const ownerTrusted =
    (isPumpTiresCoin && input.templateCodehashMatches) ||
    (isPlatformPump && input.templateCodehashMatches);
  const ownerRenounced = interpretOwnerRenounced(owner, ownerTrusted);

  const factory = input.factoryFingerprintOk
    ? {
        address: PUMP_TIRES_FACTORY,
        verified: true as const,
        verification: "creation-transaction" as const,
        sourceVerified: false as const,
        note: FACTORY_NOTE,
        evidence: {
          sampleToken: "0x1B7Cd1Cc63964f48A362fB48E488fA1B564E5be8" as const,
          sampleCreationTx:
            "0x09ac203609938f1bb8759d4907a1df1151d69cba84d8df2f241284f95b90ff19" as const,
          indexer: "pump-tires-api" as const,
          indexerUse: "discovery_only" as const,
        },
      }
    : null;

  const summary = summaryFor({
    isPlatformPump,
    isPumpTiresCoin,
    phase,
    templateCodehashMatches: input.templateCodehashMatches,
    token,
  });

  const decimals = validDecimals(input.decimals);
  const totalSupplyRaw =
    input.totalSupplyRaw !== null && input.totalSupplyRaw >= 0n
      ? input.totalSupplyRaw
      : null;

  return {
    chainId: PULSECHAIN_CHAIN_ID,
    token,
    symbol: input.symbol,
    name: input.name,
    decimals,
    totalSupply:
      totalSupplyRaw !== null && decimals !== null
        ? formatUnits(totalSupplyRaw, decimals)
        : null,
    totalSupplyRaw: totalSupplyRaw === null ? null : totalSupplyRaw.toString(),
    isPlatformPump,
    isPumpTiresCoin,
    isLaunchedCoin: isPumpTiresCoin,
    summary,
    factory,
    factoryNote: factory ? FACTORY_NOTE : FACTORY_FINGERPRINT_NOTE,
    creator: isPumpTiresCoin ? creator : null,
    phase,
    progress,
    graduated,
    launchThreshold: input.factoryFingerprintOk
      ? launchThreshold(input.launchThresholdRaw)
      : null,
    pulsexPair,
    pulsexPairNote: pulsexPair
      ? "Platform PUMP/WPLS PulseX pair. token0 and token1 matched WPLS and the platform PUMP address. Not a launched-coin graduation pair."
      : PAIR_NOTE_ABSENT,
    lpBurned: platformPair
      ? interpretLpBurned(platformPair.lpDeadRaw, platformPair.lpZeroRaw)
      : "unknown",
    lpBurnNote: LP_DOC_NOTE,
    owner,
    ownerRenounced,
    creatorRewardNote: PUMP_TIRES_CREATOR_REWARD_NOTE,
    creatorRewardMeasured: false,
    tradeBurnNote: PUMP_TIRES_TRADE_BURN_NOTE,
    tradeBurnReported: false,
    supplyNote: SUPPLY_NOTE,
    curveBurnNote: CURVE_BURN_NOTE,
    templateCodehashMatches: input.templateCodehashMatches,
    advisoryPrice: input.advisoryPrice,
    indexer: {
      consulted: false,
      source: null,
      note:
        "The pump.tires indexer is not called. Sample coins used to find the factory were discovery_only. Chain reads win.",
    },
    warnings: warningsFor(input.symbol, isPlatformPump, token),
    financialAdvice: false,
    safetyScore: false,
    buySignal: false,
    swapPrepared: false,
    calledCreate: false,
    calledBuy: false,
    calledBurn: false,
  };
}

export function emptyAdvisoryPrice(note: string): PumpTiresAdvisoryPrice {
  return {
    advisory: true,
    priceUsd: null,
    source: null,
    note,
    appliedToPhase: false,
    buySignal: false,
  };
}

export async function readPumpTiresCoin(
  config: AppConfig,
  tokenArg: string,
): Promise<PumpTiresCoinReport> {
  if (config.network !== "mainnet") {
    throw new AppError(
      "pump_tires_coin reads PulseChain mainnet (chain 369) only.",
      "CHAIN_MISMATCH",
    );
  }
  const token = assertAddress(tokenArg);
  const client = getPublicClient(config);
  const pricePromise = readAdvisoryPrice(config, token);

  try {
    const liveChainId = await getChainId(config);
    if (liveChainId !== PULSECHAIN_CHAIN_ID) {
      throw new AppError(
        `pump_tires_coin refuses to read because RPC eth_chainId is ${liveChainId}, not 369.`,
        "CHAIN_MISMATCH",
      );
    }

    const factory = getAddress(PUMP_TIRES_FACTORY);
    const [factoryCode, tokenCode] = await Promise.all([
      client.getCode({ address: factory }),
      client.getCode({ address: token }),
    ]);
    const factoryFingerprintOk = await factoryFingerprint(client, factory, factoryCode);
    const templateCodehashMatches = codehashMatchesTemplate(tokenCode);

    const factoryAbi = parseAbi([...PUMP_TIRES_FACTORY_VIEWS]);
    const factoryRows = factoryFingerprintOk
      ? await client.multicall({
          allowFailure: true,
          contracts: [
            { address: factory, abi: factoryAbi, functionName: "tokens", args: [token] },
            { address: factory, abi: factoryAbi, functionName: "plsReceived", args: [token] },
            { address: factory, abi: factoryAbi, functionName: "LAUNCH_THRESHOLD" },
          ],
        })
      : [];

    const factoryCreator = factoryFingerprintOk
      ? asAddress(succeeded(factoryRows[0]))
      : null;
    const listed = nonZeroAddress(factoryCreator) !== null;
    const isPlatform = token === PUMP_TIRES_PLATFORM_TOKEN;
    const bidLiquidityWei =
      factoryFingerprintOk && listed && !isPlatform
        ? asUint(succeeded(factoryRows[1]))
        : null;
    const launchThresholdRaw = factoryFingerprintOk
      ? asUint(succeeded(factoryRows[2]))
      : null;

    const metadata = await readTokenMetadata(client, token);
    const platformPair = isPlatform
      ? await readPlatformPair(client)
      : null;
    const advisoryPrice = await pricePromise;

    return buildPumpTiresCoinReport({
      token,
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      totalSupplyRaw: metadata.totalSupplyRaw,
      factoryFingerprintOk,
      factoryCreator,
      templateCodehashMatches,
      launched: metadata.launched,
      owner: metadata.owner,
      bidLiquidityWei,
      launchThresholdRaw,
      platformPair,
      advisoryPrice,
    });
  } catch (err) {
    await Promise.allSettled([pricePromise]);
    throw err;
  }
}

function progressFromWei(bidWei: bigint): PumpTiresProgress {
  const percent = progressPercentFromWholePls(bidWei, PUMP_TIRES_DOCUMENTED_BID_PLS * TOKEN_WEI);
  return {
    bidLiquidityPls: formatEther(bidWei),
    bidLiquidityWei: bidWei.toString(),
    thresholdPls: "200000000",
    percent,
    documented: true,
    note: PROGRESS_NOTE,
  };
}

function launchThreshold(raw: bigint | null): PumpTiresCoinReport["launchThreshold"] {
  if (raw === null || raw < 0n) return null;
  return {
    raw: raw.toString(),
    wholeTokens: raw % TOKEN_WEI === 0n ? (raw / TOKEN_WEI).toString() : null,
    note:
      "LAUNCH_THRESHOLD() uint256 from the creation-tx factory. " +
      "It is not the documented 200_000_000 PLS figure, and progress does not use it as the denominator.",
  };
}

function acceptedPlatformPair(
  pair: PumpTiresPairReading | null,
): PumpTiresPairReading | null {
  if (!pair) return null;
  if (getAddress(pair.address) !== PUMP_TIRES_PLATFORM_PULSEX_PAIR) return null;
  if (!pair.token0 || !pair.token1) return null;
  const sides = new Set([
    getAddress(pair.token0).toLowerCase(),
    getAddress(pair.token1).toLowerCase(),
  ]);
  if (
    !sides.has(WPLS_ADDRESS.toLowerCase()) ||
    !sides.has(PUMP_TIRES_PLATFORM_TOKEN.toLowerCase())
  ) {
    return null;
  }
  return {
    address: PUMP_TIRES_PLATFORM_PULSEX_PAIR,
    token0: getAddress(pair.token0),
    token1: getAddress(pair.token1),
    lpDeadRaw: pair.lpDeadRaw,
    lpZeroRaw: pair.lpZeroRaw,
  };
}

function summaryFor(input: {
  isPlatformPump: boolean;
  isPumpTiresCoin: boolean;
  phase: PumpPhase;
  templateCodehashMatches: boolean;
  token: Address;
}): string {
  if (input.isPlatformPump) {
    return "Platform token. Not a launched coin and not the factory. Not pHEX, eHEX, or PLSX.";
  }
  const catalog = catalogName(input.token);
  if (!input.isPumpTiresCoin) {
    return catalog
      ? `This address is ${catalog}, not a Pump.tires coin. It was not marked graduated.`
      : "This address is not a Pump.tires coin. It was not marked graduated.";
  }
  if (!input.templateCodehashMatches) {
    return "The creation-tx factory lists this address, but the bytecode does not match the verified Token template. launched() was not treated as graduation.";
  }
  if (input.phase === "bonding") {
    return "Pump.tires coin still on the bonding curve. launched() is false. Not a buy signal.";
  }
  if (input.phase === "graduated") {
    return "Pump.tires coin has graduated. The verified token template launched() is true. Not a buy signal.";
  }
  return "The creation-tx factory lists this address, but launched() did not return a boolean. Phase is unknown.";
}

function warningsFor(
  symbol: string | null,
  isPlatformPump: boolean,
  token: Address,
): string[] {
  const warnings = [
    "Meme coin. Not a safety score and not a buy signal.",
    "Factory source is not verified on BlockScout.",
    "Pump.tires tickers are not pHEX, eHEX, or PLSX. Address is identity.",
    "Discovery only. Not financial advice.",
  ];
  if (isPlatformPump) {
    warnings.push(
      "Symbol PUMP on this address is the platform token, not a launched coin.",
    );
  } else if (symbol && /^(pump|hex|phex|ehex|plsx)$/i.test(symbol.trim())) {
    const catalog = catalogName(token);
    warnings.push(
      catalog
        ? `Symbol ${symbol} collides with other tickers. This address is ${catalog}, not a Pump.tires coin.`
        : `Symbol ${symbol} is not identity. This address is not pHEX, eHEX, or PLSX.`,
    );
  }
  return warnings;
}

function catalogName(token: Address): string | null {
  const key = token.toLowerCase();
  if (key === HEX_ADDRESS.toLowerCase()) return "catalog pHEX";
  if (key === EHEX_ADDRESS.toLowerCase()) return "catalog eHEX";
  if (key === PLSX_ADDRESS.toLowerCase()) return "catalog PLSX";
  if (key === WPLS_ADDRESS.toLowerCase()) return "catalog WPLS";
  if (key === PUMP_TIRES_PLATFORM_TOKEN.toLowerCase()) return "the platform PUMP token";
  return null;
}

function checksumOrThrow(token: string): Address {
  if (!isAddress(token)) {
    throw new PolicyError("Refusing Pump.tires read: token is not an address.");
  }
  return getAddress(token);
}

function nonZeroAddress(value: Address | null): Address | null {
  if (!value) return null;
  const address = getAddress(value);
  return address === zeroAddress ? null : address;
}

function nullableAddress(value: Address | null): Address | null {
  if (!value || !isAddress(value)) return null;
  return getAddress(value);
}

function validDecimals(value: number | null): number | null {
  if (value === null || !Number.isInteger(value) || value < 0 || value > 36) return null;
  return value;
}

function codehashMatchesTemplate(code: string | undefined): boolean {
  if (!code || code === "0x" || code.length <= 2) return false;
  return keccak256(code as `0x${string}`) === PUMP_TIRES_TOKEN_TEMPLATE_CODEHASH;
}

async function factoryFingerprint(
  client: ReturnType<typeof getPublicClient>,
  factory: Address,
  code: string | undefined,
): Promise<boolean> {
  if (!code || code === "0x" || code.length <= 2) return false;
  const abi = parseAbi(["function TOTAL_SUPPLY() view returns (uint256)"]);
  try {
    const supply = await client.readContract({
      address: factory,
      abi,
      functionName: "TOTAL_SUPPLY",
    });
    return supply === PUMP_TIRES_DOCUMENTED_SUPPLY_TOKENS * TOKEN_WEI;
  } catch {
    return false;
  }
}

async function readTokenMetadata(
  client: ReturnType<typeof getPublicClient>,
  token: Address,
): Promise<{
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupplyRaw: bigint | null;
  owner: Address | null;
  launched: boolean | null;
}> {
  const abi = parseAbi([...PUMP_TIRES_TOKEN_VIEWS]);
  const rows = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: token, abi, functionName: "name" },
      { address: token, abi, functionName: "symbol" },
      { address: token, abi, functionName: "decimals" },
      { address: token, abi, functionName: "totalSupply" },
      { address: token, abi, functionName: "owner" },
      { address: token, abi, functionName: "launched" },
    ],
  });
  const decimals = succeeded(rows[2]);
  return {
    name: typeof succeeded(rows[0]) === "string" ? (succeeded(rows[0]) as string) : null,
    symbol: typeof succeeded(rows[1]) === "string" ? (succeeded(rows[1]) as string) : null,
    decimals: typeof decimals === "number" && Number.isInteger(decimals) ? decimals : null,
    totalSupplyRaw: asUint(succeeded(rows[3])),
    owner: asAddress(succeeded(rows[4])),
    launched: typeof succeeded(rows[5]) === "boolean" ? (succeeded(rows[5]) as boolean) : null,
  };
}

async function readPlatformPair(
  client: ReturnType<typeof getPublicClient>,
): Promise<PumpTiresPairReading> {
  const pair = PUMP_TIRES_PLATFORM_PULSEX_PAIR;
  const abi = parseAbi([...PUMP_TIRES_PAIR_VIEWS]);
  const rows = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: pair, abi, functionName: "token0" },
      { address: pair, abi, functionName: "token1" },
      {
        address: pair,
        abi,
        functionName: "balanceOf",
        args: [getAddress(PUMP_TIRES_LP_DEAD_ADDRESS)],
      },
      { address: pair, abi, functionName: "balanceOf", args: [zeroAddress] },
    ],
  });
  return {
    address: pair,
    token0: asAddress(succeeded(rows[0])),
    token1: asAddress(succeeded(rows[1])),
    lpDeadRaw: asUint(succeeded(rows[2])),
    lpZeroRaw: asUint(succeeded(rows[3])),
  };
}

async function readAdvisoryPrice(
  config: AppConfig,
  token: Address,
): Promise<PumpTiresAdvisoryPrice> {
  const base = {
    advisory: true as const,
    appliedToPhase: false as const,
    buySignal: false as const,
  };
  let subgraphNote: string;
  try {
    const res = await fetchToken(config, token, "v2");
    const price = positiveFinite(res.token?.derivedUSD);
    if (price !== null) {
      return {
        ...base,
        priceUsd: price,
        source: "pulsex-subgraph-derivedUSD",
        note: "Advisory only, from the existing PulseX derivedUSD read. Not a buy signal and not used to decide phase.",
      };
    }
    subgraphNote = res.token
      ? "PulseX v2 derivedUSD missing or not positive."
      : "Token not on the PulseX v2 subgraph.";
  } catch (err) {
    subgraphNote = `PulseX price unavailable (${shortError(err)}).`;
  }

  try {
    const dex = await getDexScreenerTokenPairs(config, token);
    if (!dex.ok) {
      return {
        ...base,
        priceUsd: null,
        source: null,
        note: `${subgraphNote} DexScreener: ${dex.reason}. No price was invented.`,
      };
    }
    const best = bestBasePrice(dex.data.pairs, token);
    if (!best) {
      return {
        ...base,
        priceUsd: null,
        source: null,
        note: `${subgraphNote} DexScreener had no PulseChain pair pricing this token as the base. No price was invented.`,
      };
    }
    return {
      ...base,
      priceUsd: best,
      source: "dexscreener",
      note: `${subgraphNote} Advisory DexScreener base-token price only. Not a buy signal and not used to decide phase.`,
    };
  } catch (err) {
    return {
      ...base,
      priceUsd: null,
      source: null,
      note: `${subgraphNote} DexScreener failed (${shortError(err)}). No price was invented.`,
    };
  }
}

function bestBasePrice(
  pairs: ReadonlyArray<{
    baseToken: { address: string };
    priceUsd?: string | null;
    liquidity?: { usd?: number | null } | null;
  }>,
  token: Address,
): number | null {
  const want = token.toLowerCase();
  let best: { price: number; liquidity: number } | null = null;
  for (const pair of pairs) {
    if (pair.baseToken.address.toLowerCase() !== want) continue;
    const price = positiveFinite(pair.priceUsd);
    if (price === null) continue;
    const liquidity =
      typeof pair.liquidity?.usd === "number" && Number.isFinite(pair.liquidity.usd)
        ? pair.liquidity.usd
        : 0;
    if (!best || liquidity > best.liquidity) best = { price, liquidity };
  }
  return best?.price ?? null;
}

function positiveFinite(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : "request failed";
  return message.slice(0, 160);
}

function succeeded(
  row: { status: string; result?: unknown } | undefined,
): unknown {
  if (!row || row.status !== "success") return undefined;
  return row.result;
}

function asAddress(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null;
}

function asUint(value: unknown): bigint | null {
  return typeof value === "bigint" && value >= 0n ? value : null;
}
