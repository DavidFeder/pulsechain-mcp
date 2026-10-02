/**
 * Pump.tires coin status fixtures. No live RPC.
 */
import { afterEach, describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { HEX_ADDRESS, PLSX_ADDRESS, WPLS_ADDRESS } from "../src/constants.js";
import {
  PUMP_TIRES_CREATOR_REWARD_NOTE,
  PUMP_TIRES_DOCUMENTED_BID_PLS,
  PUMP_TIRES_FACTORY,
  PUMP_TIRES_FACTORY_VIEWS,
  PUMP_TIRES_PLATFORM_PULSEX_PAIR,
  PUMP_TIRES_PLATFORM_TOKEN,
  PUMP_TIRES_TOKEN_VIEWS,
  PUMP_TIRES_TOOL_DESCRIPTION,
  buildPumpTiresCoinReport,
  emptyAdvisoryPrice,
  interpretLpBurned,
  interpretOwnerRenounced,
  progressPercentFromWholePls,
  type PumpTiresReportInput,
} from "../src/data/pumpTires.js";
import { getRegisteredTools, resetToolRegistry } from "../src/tools/define.js";
import { registerAllTools } from "../src/tools/registry.js";
import type { AppConfig } from "../src/types.js";

const baseConfig: AppConfig = {
  rpcUrl: "https://rpc.pulsechain.com",
  rpcUrls: ["https://rpc.pulsechain.com"],
  network: "mainnet",
  explorerApi: "https://api.scan.pulsechain.com/api",
  pulseXSubgraphV1: "https://example.com/v1",
  pulseXSubgraphV2: "https://example.com/v2",
  agentWalletEnabled: false,
  agentWalletMasterKey: undefined,
  agentWalletDir: "./data/wallets",
  agentWalletMultiprocStrict: false,
  httpTransportPort: undefined,
  logLevel: "error",
  httpTimeoutMs: 5000,
};

const COIN = "0x1B7Cd1Cc63964f48A362fB48E488fA1B564E5be8";
const CREATOR = "0xA3660F6e0b34f9A1679E039B5b3501ebd2dC7912";
const STRANGER = "0x0000000000000000000000000000000000000001";
const WEI = 10n ** 18n;

function input(overrides: Partial<PumpTiresReportInput> = {}): PumpTiresReportInput {
  return {
    token: COIN,
    name: "Example",
    symbol: "EX",
    decimals: 18,
    totalSupplyRaw: 1_000_000_000n * WEI,
    factoryFingerprintOk: true,
    factoryCreator: CREATOR,
    templateCodehashMatches: true,
    launched: false,
    owner: CREATOR,
    bidLiquidityWei: null,
    launchThresholdRaw: null,
    platformPair: null,
    advisoryPrice: emptyAdvisoryPrice("No advisory price in this fixture."),
    ...overrides,
  };
}

describe("bonding progress", () => {
  it("maps 100_000_000 / 200_000_000 PLS to 50 percent and phase bonding", () => {
    expect(progressPercentFromWholePls(100_000_000n)).toBe(50);
    expect(PUMP_TIRES_DOCUMENTED_BID_PLS).toBe(200_000_000n);
    const report = buildPumpTiresCoinReport(
      input({ bidLiquidityWei: 100_000_000n * WEI, launched: false }),
    );
    expect(report.chainId).toBe(369);
    expect(report.phase).toBe("bonding");
    expect(report.graduated).toBe(false);
    expect(report.progress?.percent).toBe(50);
    expect(report.progress?.thresholdPls).toBe("200000000");
    expect(report.progress?.bidLiquidityPls).toBe("100000000");
    expect(report.progress?.documented).toBe(true);
    expect(report.isPumpTiresCoin).toBe(true);
    expect(report.isLaunchedCoin).toBe(true);
    expect(report.isPlatformPump).toBe(false);
    expect(report.swapPrepared).toBe(false);
    expect(report.calledCreate).toBe(false);
    expect(report.calledBuy).toBe(false);
    expect(report.calledBurn).toBe(false);
    expect(report.financialAdvice).toBe(false);
    expect(report.buySignal).toBe(false);
    expect(report.creatorRewardNote).toBe(PUMP_TIRES_CREATOR_REWARD_NOTE);
    expect(report.creatorRewardMeasured).toBe(false);
    expect(report.tradeBurnReported).toBe(false);
  });

  it("does not invent progress when bid liquidity is missing", () => {
    const report = buildPumpTiresCoinReport(input({ bidLiquidityWei: null }));
    expect(report.phase).toBe("bonding");
    expect(report.progress).toBeNull();
  });

  it("keeps the documented 200_000_000 PLS denominator when LAUNCH_THRESHOLD is in tokens", () => {
    const report = buildPumpTiresCoinReport(
      input({
        bidLiquidityWei: 100_000_000n * WEI,
        launchThresholdRaw: 800_000_000n * WEI,
      }),
    );
    expect(report.progress?.percent).toBe(50);
    expect(report.progress?.thresholdPls).toBe("200000000");
    expect(report.launchThreshold?.wholeTokens).toBe("800000000");
    expect(report.launchThreshold?.note).toMatch(/not the documented 200_000_000/);
  });

  it("caps percent at 100 and does not flip phase from the ratio", () => {
    expect(progressPercentFromWholePls(400_000_000n)).toBe(100);
    const report = buildPumpTiresCoinReport(
      input({ bidLiquidityWei: 400_000_000n * WEI, launched: false }),
    );
    expect(report.progress?.percent).toBe(100);
    expect(report.phase).toBe("bonding");
    expect(report.graduated).toBe(false);
  });
});

describe("owner renounced", () => {
  it("is true only when owner() is the zero address", () => {
    expect(interpretOwnerRenounced(zeroAddress, true)).toBe(true);
    const report = buildPumpTiresCoinReport(input({ owner: zeroAddress }));
    expect(report.ownerRenounced).toBe(true);
    expect(report.owner).toBe(zeroAddress);
  });

  it("is false for a non-zero owner and unknown when the template is not trusted", () => {
    expect(interpretOwnerRenounced(CREATOR, true)).toBe(false);
    expect(interpretOwnerRenounced(zeroAddress, false)).toBe("unknown");
    const mismatch = buildPumpTiresCoinReport(
      input({ owner: zeroAddress, templateCodehashMatches: false, launched: true }),
    );
    expect(mismatch.ownerRenounced).toBe("unknown");
    expect(mismatch.phase).toBe("unknown");
    expect(mismatch.graduated).not.toBe(true);
  });
});

describe("platform PUMP", () => {
  it("flags the platform address and does not describe it as a launched coin", () => {
    const report = buildPumpTiresCoinReport(
      input({
        token: PUMP_TIRES_PLATFORM_TOKEN,
        name: "PUMP.tires",
        symbol: "PUMP",
        factoryCreator: null,
        templateCodehashMatches: true,
        launched: true,
        owner: zeroAddress,
        bidLiquidityWei: 0n,
        platformPair: {
          address: PUMP_TIRES_PLATFORM_PULSEX_PAIR,
          token0: WPLS_ADDRESS,
          token1: PUMP_TIRES_PLATFORM_TOKEN,
          lpDeadRaw: 0n,
          lpZeroRaw: 1n,
        },
      }),
    );
    expect(report.isPlatformPump).toBe(true);
    expect(report.isPumpTiresCoin).toBe(false);
    expect(report.isLaunchedCoin).toBe(false);
    expect(report.summary).toMatch(/platform token/i);
    expect(report.summary).toMatch(/not a launched coin/i);
    expect(report.phase).not.toBe("graduated");
    expect(report.phase).not.toBe("bonding");
    expect(report.graduated).not.toBe(true);
    expect(report.progress).toBeNull();
    expect(report.pulsexPair).toBe(PUMP_TIRES_PLATFORM_PULSEX_PAIR);
    expect(report.lpBurned).toBe(true);
    expect(report.ownerRenounced).toBe(true);
    expect(report.summary.toLowerCase()).not.toMatch(/has graduated/);
    expect(report.warnings.join(" ")).toMatch(/not pHEX, eHEX, or PLSX/);
    expect(report.warnings.join(" ")).toMatch(/not a launched coin/);
  });
});

describe("unknown address", () => {
  it("is not marked graduated even when launched() would be true", () => {
    const report = buildPumpTiresCoinReport(
      input({
        token: STRANGER,
        symbol: "HEX",
        name: "Not HEX",
        factoryCreator: zeroAddress,
        templateCodehashMatches: true,
        launched: true,
        owner: zeroAddress,
        bidLiquidityWei: 100_000_000n * WEI,
      }),
    );
    expect(report.isPumpTiresCoin).toBe(false);
    expect(report.isPlatformPump).toBe(false);
    expect(report.isLaunchedCoin).toBe(false);
    expect(report.graduated).not.toBe(true);
    expect(report.phase).not.toBe("graduated");
    expect(report.progress).toBeNull();
    expect(report.summary).toMatch(/not a Pump\.tires coin/);
    expect(report.summary).toMatch(/not marked graduated/i);
  });

  it("does not relabel catalog pHEX or PLSX as a graduated pump coin", () => {
    for (const token of [HEX_ADDRESS, PLSX_ADDRESS]) {
      const report = buildPumpTiresCoinReport(
        input({
          token,
          symbol: "HEX",
          factoryCreator: null,
          launched: true,
          templateCodehashMatches: false,
        }),
      );
      expect(report.graduated).not.toBe(true);
      expect(report.isPumpTiresCoin).toBe(false);
      expect(report.summary).toMatch(/not a Pump\.tires coin/);
    }
  });

  it("nulls the factory when the fingerprint fails", () => {
    const report = buildPumpTiresCoinReport(
      input({ factoryFingerprintOk: false, factoryCreator: CREATOR, launched: true }),
    );
    expect(report.factory).toBeNull();
    expect(report.factoryNote).toMatch(/not guessed/i);
    expect(report.graduated).not.toBe(true);
    expect(report.isPumpTiresCoin).toBe(false);
  });
});

describe("reads stay view-only", () => {
  it("does not encode create, buy, sell, burn, or launch", () => {
    const fragments = [
      ...PUMP_TIRES_FACTORY_VIEWS,
      ...PUMP_TIRES_TOKEN_VIEWS,
      "function token0() view returns (address)",
      "function token1() view returns (address)",
      "function balanceOf(address) view returns (uint256)",
    ];
    for (const fragment of fragments) {
      expect(fragment).toMatch(/view returns/);
      expect(fragment).not.toMatch(/\b(nonpayable|payable)\b/);
      expect(fragment).not.toMatch(/function (create|buy|sell|burn|launch)\(/);
    }
    expect(interpretLpBurned(0n, 0n)).toBe("unknown");
    expect(interpretLpBurned(null, null)).toBe("unknown");
    expect(interpretLpBurned(1n, null)).toBe(true);
  });

  it("registers pump_tires_coin as a read-only meme status tool", () => {
    resetToolRegistry();
    const names: string[] = [];
    const server = {
      registerTool: (name: string) => {
        names.push(name);
      },
    };
    registerAllTools(server as never, baseConfig);
    const tool = getRegisteredTools().find((row) => row.name === "pump_tires_coin");
    expect(names).toContain("pump_tires_coin");
    expect(tool?.write).toBe(false);
    expect(tool?.description).toMatch(/read-only/i);
    expect(tool?.description).toMatch(/meme/i);
    expect(tool?.description).toMatch(/not financial advice/i);
    expect(tool?.description).toMatch(/Does not create, buy, or burn/);
    expect(PUMP_TIRES_TOOL_DESCRIPTION).toBe(tool?.description);
    expect(PUMP_TIRES_FACTORY).toBe("0x6538A83a81d855B965983161AF6a83e616D16fD5");
  });
});

afterEach(() => {
  resetToolRegistry();
});
