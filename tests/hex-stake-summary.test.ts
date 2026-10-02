/**
 * HEX stake summary math. No live RPC.
 */
import { describe, expect, it } from "vitest";
import { EHEX_ADDRESS, HEX_ADDRESS } from "../src/constants.js";
import type { HexStakeRow } from "../src/data/hexStake.js";
import {
  HEX_HEARTS_PER_HEX,
  HEX_SHARE_RATE_SCALE,
  HEX_STAKE_SUMMARY_TOOL_DESCRIPTION,
  buildHexPriceContext,
  formatHexFromHearts,
  getHexStakeSummary,
  summarizeHexStakes,
  type HexPriceContext,
  type HexTokenPriceContext,
} from "../src/data/hexStakeSummary.js";
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

function row(partial: Partial<HexStakeRow> & Pick<HexStakeRow, "index">): HexStakeRow {
  return {
    stakeId: String(partial.index + 1),
    stakedHearts: "100000000",
    stakeShares: "1000000000000",
    lockedDay: 900,
    stakedDays: 100,
    unlockedDay: 0,
    isAutoStake: false,
    stillLocked: true,
    ...partial,
  };
}

function price(
  symbol: "pHEX" | "eHEX",
  address: string,
  priceUsd: number | null,
): HexTokenPriceContext {
  return { symbol, address, priceUsd, source: priceUsd == null ? null : "pulsex-subgraph-derivedUSD", note: null };
}

function prices(phex: number | null, ehex: number | null): HexPriceContext {
  return buildHexPriceContext(
    price("pHEX", HEX_ADDRESS, phex),
    price("eHEX", EHEX_ADDRESS, ehex),
  );
}

describe("HEX display and T-shares", () => {
  it("formats hearts as HEX without rounding", () => {
    expect(HEX_HEARTS_PER_HEX).toBe(100_000_000n);
    expect(formatHexFromHearts(0n)).toBe("0");
    expect(formatHexFromHearts(1n)).toBe("0.00000001");
    expect(formatHexFromHearts(100_000_000n)).toBe("1");
    expect(formatHexFromHearts(150_000_000n)).toBe("1.5");
    expect(formatHexFromHearts(123_456_789n)).toBe("1.23456789");
    expect(formatHexFromHearts(-50_000n)).toBe("-0.0005");
  });
});

describe("summarizeHexStakes", () => {
  const stakes: HexStakeRow[] = [
    row({
      index: 0,
      stakeId: "10",
      lockedDay: 900,
      stakedDays: 200,
      stakedHearts: "100000000",
      stakeShares: "2500000000000",
    }),
    row({
      index: 1,
      stakeId: "11",
      lockedDay: 980,
      stakedDays: 30,
      stakedHearts: "300000000",
      stakeShares: "100000",
    }),
    row({
      index: 2,
      stakeId: "12",
      lockedDay: 900,
      stakedDays: 50,
      stakedHearts: "100000000",
      stakeShares: "100000",
    }),
    row({
      index: 3,
      stakeId: "13",
      lockedDay: 990,
      stakedDays: 10,
      unlockedDay: 1000,
      stillLocked: false,
      stakedHearts: "800000000",
      stakeShares: "100000",
    }),
    row({
      index: 4,
      stakeId: "14",
      lockedDay: 700,
      stakedDays: 300,
      stakedHearts: "100000000",
      stakeShares: "200000",
    }),
  ];

  it("computes daysLeft, endingSoon, late, and approximate T-shares", () => {
    const summary = summarizeHexStakes({
      stakes,
      stakeCount: "5",
      truncated: false,
      currentDay: "1000",
      shareRate: "150000",
      endingWithinDays: 30,
      includeEnded: false,
      priceContext: prices(null, null),
    });

    expect(summary.chainId).toBe(369);
    expect(summary.contract).toBe("pHEX");
    expect(summary.contractAddress).toBe(HEX_ADDRESS);
    expect(summary.versionNote).toMatch(/pHEX/);
    expect(summary.versionNote).toMatch(/not Ethereum eHEX/i);
    expect(summary.heartsDecimals).toBe(8);
    expect(summary.currentDay).toBe("1000");
    expect(summary.disclaimer).toMatch(/not financial advice/i);
    expect(summary.disclaimer).toMatch(/estimate/i);
    expect(summary.stakes.map((s) => s.stakeId)).toEqual(["10", "11", "12", "14"]);

    const soon = summary.stakes.find((s) => s.stakeId === "11")!;
    expect(soon.startDay).toBe(980);
    expect(soon.endDay).toBe(1010);
    expect(soon.daysLeft).toBe(10);
    expect(soon.locked).toBe(true);
    expect(soon.early).toBe(true);
    expect(soon.stakedHex).toBe("3");
    expect(soon.principalHearts).toBe("300000000");
    expect(soon.principalHex).toBe("3");

    const long = summary.stakes.find((s) => s.stakeId === "10")!;
    expect(long.endDay).toBe(1100);
    expect(long.daysLeft).toBe(100);
    expect(long.approximateTShares).toBe("2.5");
    expect(long.approximate).toBe(true);

    const matureToday = summary.stakes.find((s) => s.stakeId === "14")!;
    expect(matureToday.daysLeft).toBe(0);
    expect(matureToday.locked).toBe(false);
    expect(matureToday.early).toBe(false);

    const late = summary.stakes.find((s) => s.stakeId === "12")!;
    expect(late.daysLeft).toBe(-50);
    expect(late.locked).toBe(false);

    expect(summary.endingSoon.map((s) => s.stakeId)).toEqual(["14", "11"]);
    expect(summary.counts).toEqual({
      active: 2,
      endingSoon: 2,
      late: 2,
      endedOnChain: 1,
    });
    expect(summary.endedOnChainExcluded).toBe(1);
    expect(summary.totals.stakedHearts).toBe("600000000");
    expect(summary.totals.stakedHex).toBe("6");
    expect(summary.totals.heartsPerStake).toBe("150000000");
    expect(summary.totals.hexPerStake).toBe("1.5");
    expect(summary.totals.approximateTShares).toBe("2.5000004");
    expect(summary.totals.approximate).toBe(true);
  });

  it("sorts endingSoon soonest first and honors a zero-day window", () => {
    const summary = summarizeHexStakes({
      stakes,
      stakeCount: "5",
      truncated: false,
      currentDay: "1000",
      shareRate: "150000",
      endingWithinDays: 0,
      includeEnded: false,
      priceContext: prices(null, null),
    });
    expect(summary.endingSoon.map((s) => s.stakeId)).toEqual(["14"]);
  });

  it("includes ended stakes when asked and does not call them active or late", () => {
    const summary = summarizeHexStakes({
      stakes,
      stakeCount: "5",
      truncated: false,
      currentDay: "1000",
      shareRate: "150000",
      endingWithinDays: 30,
      includeEnded: true,
      priceContext: prices(null, null),
    });
    const ended = summary.stakes.find((s) => s.stakeId === "13")!;
    expect(ended.endedOnChain).toBe(true);
    expect(ended.locked).toBe(false);
    expect(ended.early).toBe(false);
    expect(summary.endingSoon.some((s) => s.stakeId === "13")).toBe(false);
    expect(summary.counts.active).toBe(2);
    expect(summary.counts.late).toBe(2);
    expect(summary.endedOnChainExcluded).toBe(0);
  });

  it("estimates yield from the share rate and does not clamp a negative result", () => {
    expect(HEX_SHARE_RATE_SCALE).toBe(100_000n);
    const summary = summarizeHexStakes({
      stakes: [
        row({
          index: 0,
          stakedHearts: "100000",
          stakeShares: "200000",
        }),
        row({
          index: 1,
          stakedHearts: "100000",
          stakeShares: "100000",
        }),
      ],
      stakeCount: "2",
      truncated: false,
      currentDay: "1000",
      shareRate: "150000",
      endingWithinDays: 30,
      includeEnded: false,
      priceContext: prices(2, 1),
    });
    const up = summary.stakes[0]!;
    expect(up.estimatedValueHearts).toBe("300000");
    expect(up.estimatedYieldHearts).toBe("200000");
    expect(up.estimatedValueHex).toBe("0.003");
    expect(up.estimatedYieldHex).toBe("0.002");
    expect(up.yieldLabel).toBe("estimate");
    expect(summary.yield.present).toBe(true);
    expect(summary.yield.notEndStakePayout).toBe(true);
    expect(summary.yield.method).toMatch(/not the amount endStake will pay/i);
    expect(summary.yield.method).toMatch(/100000/);

    const summaryLow = summarizeHexStakes({
      stakes: [
        row({
          index: 0,
          stakedHearts: "100000",
          stakeShares: "100000",
        }),
      ],
      stakeCount: "1",
      truncated: false,
      currentDay: "1000",
      shareRate: "50000",
      endingWithinDays: 30,
      includeEnded: false,
      priceContext: prices(null, null),
    });
    expect(summaryLow.stakes[0]!.estimatedValueHearts).toBe("50000");
    expect(summaryLow.stakes[0]!.estimatedYieldHearts).toBe("-50000");
    expect(summaryLow.stakes[0]!.estimatedYieldHex).toBe("-0.0005");
  });

  it("omits yield when share rate is missing and still reports days left", () => {
    const summary = summarizeHexStakes({
      stakes: [row({ index: 0, lockedDay: 900, stakedDays: 200 })],
      stakeCount: "1",
      truncated: false,
      currentDay: "1000",
      shareRate: null,
      endingWithinDays: 30,
      includeEnded: false,
      globalsUnavailableReason: "globals reverted",
      priceContext: prices(null, null),
    });
    expect(summary.stakes[0]!.daysLeft).toBe(100);
    expect(summary.stakes[0]!.estimatedYieldHearts).toBeUndefined();
    expect(summary.stakes[0]!.yieldOmittedReason).toMatch(/share rate is missing/i);
    expect(summary.stakes[0]!.yieldOmittedReason).toMatch(/none was invented|no payout/i);
    expect(summary.yield.present).toBe(false);
    expect(summary.yield.method).toBeNull();
    expect(summary.yield.omittedReason).toMatch(/share rate is missing/i);
    expect(summary.globalsUnavailableReason).toBe("globals reverted");
  });

  it("omits yield and day math when current day is missing", () => {
    const summary = summarizeHexStakes({
      stakes: [row({ index: 0, stakeShares: "200000", stakedHearts: "100000" })],
      stakeCount: "1",
      truncated: false,
      currentDay: null,
      shareRate: "150000",
      endingWithinDays: 30,
      includeEnded: false,
      priceContext: prices(null, null),
    });
    expect(summary.currentDay).toBeNull();
    expect(summary.stakes[0]!.daysLeft).toBeNull();
    expect(summary.stakes[0]!.locked).toBeNull();
    expect(summary.stakes[0]!.early).toBeNull();
    expect(summary.stakes[0]!.estimatedYieldHearts).toBeUndefined();
    expect(summary.yield.omittedReason).toMatch(/current HEX day is missing/i);
    expect(summary.counts.active).toBeNull();
    expect(summary.counts.endingSoon).toBeNull();
    expect(summary.counts.late).toBeNull();
    expect(summary.endingSoon).toEqual([]);
    expect(summary.countsOmittedReason).toMatch(/current HEX day is missing/i);
  });

  it("omits yield when share rate is zero", () => {
    const summary = summarizeHexStakes({
      stakes: [row({ index: 0 })],
      stakeCount: "1",
      truncated: false,
      currentDay: "1000",
      shareRate: "0",
      endingWithinDays: 30,
      includeEnded: false,
      priceContext: prices(null, null),
    });
    expect(summary.shareRate).toBe("0");
    expect(summary.stakes[0]!.estimatedValueHearts).toBeUndefined();
    expect(summary.yield.omittedReason).toMatch(/share rate is zero/i);
  });

  it("leaves an unparseable amount out of the total", () => {
    const summary = summarizeHexStakes({
      stakes: [row({ index: 0, stakedHearts: "nope", stakeShares: "200000" })],
      stakeCount: "1",
      truncated: false,
      currentDay: "1000",
      shareRate: "150000",
      endingWithinDays: 30,
      includeEnded: false,
      priceContext: prices(null, null),
    });
    expect(summary.totals.stakedHearts).toBeNull();
    expect(summary.totals.heartsPerStake).toBeNull();
    expect(summary.stakes[0]!.yieldOmittedReason).toMatch(/not an integer/i);
    expect(summary.totals.note).toMatch(/null/);
  });
});

describe("buildHexPriceContext", () => {
  it("returns premiumMultiple only when both prices exist", () => {
    const both = prices(0.02, 0.01);
    expect(both.premiumMultiple).toBe(2);
    expect(both.ethereumRpcCalled).toBe(false);
    expect(both.note).toMatch(/not financial advice/i);

    const missingEhex = prices(0.02, null);
    expect(missingEhex.premiumMultiple).toBeNull();
    expect(missingEhex.ehex.priceUsd).toBeNull();
    expect(missingEhex.note).toMatch(/eHEX price is missing/i);
    expect(missingEhex.note).toMatch(/Ethereum RPC was not called/i);

    const missingBoth = prices(null, null);
    expect(missingBoth.premiumMultiple).toBeNull();
    expect(missingBoth.note).toMatch(/pHEX and eHEX/);
  });

  it("rejects a non-positive price", () => {
    const ctx = buildHexPriceContext(
      price("pHEX", HEX_ADDRESS, 0),
      price("eHEX", EHEX_ADDRESS, 1),
    );
    expect(ctx.phex.priceUsd).toBe(0);
    expect(ctx.premiumMultiple).toBeNull();
    expect(ctx.note).toMatch(/pHEX price is missing/i);
  });
});

describe("getHexStakeSummary fail-closed inputs", () => {
  it("rejects a bad endingWithinDays before any RPC", async () => {
    const result = await getHexStakeSummary(
      baseConfig,
      "0x0000000000000000000000000000000000000001",
      { endingWithinDays: -1, includeEnded: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/endingWithinDays/);
  });

  it("rejects an invalid staker without inventing stakes", async () => {
    const result = await getHexStakeSummary(baseConfig, "not-an-address", {
      endingWithinDays: 30,
      includeEnded: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/staker|address/i);
  });
});

describe("hex_stake_summary tool description", () => {
  it("says estimate, pHEX only, and not financial advice", () => {
    expect(HEX_STAKE_SUMMARY_TOOL_DESCRIPTION).toMatch(/estimate/i);
    expect(HEX_STAKE_SUMMARY_TOOL_DESCRIPTION).toMatch(/pHEX/);
    expect(HEX_STAKE_SUMMARY_TOOL_DESCRIPTION).toMatch(/not Ethereum eHEX/i);
    expect(HEX_STAKE_SUMMARY_TOOL_DESCRIPTION).toMatch(/not financial advice/i);
    expect(HEX_STAKE_SUMMARY_TOOL_DESCRIPTION).toMatch(/endStake/);
    expect(HEX_STAKE_SUMMARY_TOOL_DESCRIPTION).toMatch(/Does not startStake, endStake, or goodAccounting/);
  });
});
