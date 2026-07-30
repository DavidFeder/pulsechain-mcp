import { describe, expect, it } from "vitest";
import {
  bucketHoldersByLeague,
  buildTokenInfoPayload,
  catalogPairSideLabels,
  computeSafetyScore,
  estimatePairLiquidityUsd,
  isSaneReserveUsd,
  isoDateFromUnix,
  labelSubgraphPairRow,
  labelSubgraphSwapRow,
  labelSubgraphTokenRow,
  mapPairsWithSaneLiquidity,
  MAX_SANE_PAIR_RESERVE_USD,
  MAX_SANE_TOKEN_DERIVED_USD,
  num,
  PAIR_PRICE_FIELDS_NOTE,
  pctChange,
  rankPairsBySaneLiquidity,
  resolvePairLiquidityUsd,
  resolveTokenLiquidityUsdEstimate,
  saneLiquidityUsd,
  scanSuspiciousPatterns,
  scoreToGrade,
  selectTopPairsByLiquidity,
  sumSanePairLiquidity,
  swapInvolvesToken,
  tierForUsd,
} from "../src/tools/analytics/helpers.js";
import {
  filterSwapsByToken,
  MAX_TOKEN_SWAP_PAIR_QUERIES,
  mergeTokenFilteredSwaps,
  selectTokenSwapPairIds,
  swapInvolvesToken as swapInvolvesTokenSubgraph,
} from "../src/data/subgraph.js";
import {
  BRIDGED_DAI_ADDRESS,
  EHEX_ADDRESS,
  EWBTC_ADDRESS,
  FORK_DAI_ADDRESS,
  HEX_ADDRESS,
  PLSX_ADDRESS,
  PWBTC_ADDRESS,
  USDC_FROM_ETH_ADDRESS,
  USDC_FROM_ETH_ADDRESS,
  WPLS_ADDRESS,
} from "../src/constants.js";

describe("num / pctChange / dates", () => {
  it("parses numbers safely", () => {
    expect(num("1.5")).toBe(1.5);
    expect(num(undefined)).toBe(0);
    expect(num("nope", 3)).toBe(3);
  });

  it("computes percent change", () => {
    expect(pctChange(110, 100)).toBeCloseTo(10);
    expect(pctChange(50, 100)).toBeCloseTo(-50);
    expect(pctChange(1, 0)).toBeNull();
  });

  it("formats unix dates", () => {
    expect(isoDateFromUnix(0)).toBe("1970-01-01");
  });
});

describe("safety scoring", () => {
  it("maps scores to grades", () => {
    expect(scoreToGrade(90)).toBe("A");
    expect(scoreToGrade(75)).toBe("B");
    expect(scoreToGrade(60)).toBe("C");
    expect(scoreToGrade(45)).toBe("D");
    expect(scoreToGrade(10)).toBe("F");
  });

  it("scores renounced verified liquid tokens highly", () => {
    const { score, grade } = computeSafetyScore({
      verified: true,
      ownershipRenounced: true,
      liquidityUsd: 200_000,
      topHolderShare: 0.05,
      top10Share: 0.2,
      ageDays: 400,
      honeypotFlags: [],
      suspiciousAbi: [],
    });
    expect(score).toBeGreaterThanOrEqual(80);
    expect(["A", "B"]).toContain(grade);
  });

  it("penalizes unverified low-liq honeypot flags", () => {
    const { score, grade } = computeSafetyScore({
      verified: false,
      ownershipRenounced: false,
      liquidityUsd: 50,
      topHolderShare: 0.9,
      top10Share: 0.99,
      ageDays: 1,
      honeypotFlags: ["transfer_simulation_revert", "dust_liquidity"],
      suspiciousAbi: ["blacklist", "mutable_tax"],
    });
    expect(score).toBeLessThan(45);
    expect(["D", "F"]).toContain(grade);
  });
});

describe("suspicious ABI scan", () => {
  it("detects blacklist and tax patterns", () => {
    const flags = scanSuspiciousPatterns(
      "function setTax(uint) external; mapping isBlacklisted; maxTxAmount",
    );
    expect(flags).toContain("blacklist");
    expect(flags).toContain("mutable_tax");
    expect(flags).toContain("max_tx_limits");
  });

  it("returns empty for clean ERC20", () => {
    expect(
      scanSuspiciousPatterns("function transfer(address to, uint256 amount)"),
    ).toEqual([]);
  });
});

describe("holder leagues", () => {
  it("assigns tiers by USD", () => {
    // Thresholds: poseidon≥1M, whale≥100k, shark≥10k, dolphin≥1k, squid≥100, turtle≥0
    expect(tierForUsd(2_000_000)).toBe("poseidon");
    expect(tierForUsd(150_000)).toBe("whale");
    expect(tierForUsd(50_000)).toBe("shark");
    expect(tierForUsd(15_000)).toBe("shark");
    expect(tierForUsd(5_000)).toBe("dolphin");
    expect(tierForUsd(1_500)).toBe("dolphin");
    expect(tierForUsd(500)).toBe("squid");
    expect(tierForUsd(50)).toBe("turtle");
    expect(tierForUsd(1)).toBe("turtle");
  });

  it("buckets holders", () => {
    const tiers = bucketHoldersByLeague([
      { balanceUsd: 2_000_000 },
      { balanceUsd: 150_000 },
      { balanceUsd: 120_000 },
      { balanceUsd: 5 },
    ]);
    const poseidon = tiers.find((t) => t.tier === "poseidon");
    const whale = tiers.find((t) => t.tier === "whale");
    const turtle = tiers.find((t) => t.tier === "turtle");
    expect(poseidon?.holder_count).toBe(1);
    expect(whale?.holder_count).toBe(2);
    expect(turtle?.holder_count).toBe(1);
  });
});

describe("reserveUSD sanity / liquidity ranking", () => {
  it("accepts major-pool scale and rejects absurd reserveUSD", () => {
    expect(isSaneReserveUsd(1_500_000)).toBe(true);
    expect(isSaneReserveUsd(0)).toBe(true);
    expect(isSaneReserveUsd(MAX_SANE_PAIR_RESERVE_USD)).toBe(true);
    expect(isSaneReserveUsd(MAX_SANE_PAIR_RESERVE_USD + 1)).toBe(false);
    expect(isSaneReserveUsd("1e30")).toBe(false);
    expect(isSaneReserveUsd(Number.POSITIVE_INFINITY)).toBe(false);
    expect(saneLiquidityUsd("1e40")).toBe(0);
    expect(saneLiquidityUsd("2500000")).toBe(2_500_000);
  });

  it("resolveTokenLiquidityUsdEstimate demotes absurd derivedUSD products", () => {
    const sane = resolveTokenLiquidityUsdEstimate(1_000_000, 0.05);
    expect(sane.liquidityUsd).toBeCloseTo(50_000);
    expect(sane.polluted).toBe(false);
    expect(sane.priceSane).toBe(true);

    // Unit price above MAX_SANE_TOKEN_DERIVED_USD → demote
    const absurdPrice = resolveTokenLiquidityUsdEstimate(
      1,
      MAX_SANE_TOKEN_DERIVED_USD + 1,
    );
    expect(absurdPrice.liquidityUsd).toBe(0);
    expect(absurdPrice.polluted).toBe(true);
    expect(absurdPrice.priceSane).toBe(false);
    expect(absurdPrice.rawEstimate).toBeGreaterThan(0);

    // Product above hard pair cap → demote
    const absurdTvl = resolveTokenLiquidityUsdEstimate(
      MAX_SANE_PAIR_RESERVE_USD,
      2,
    );
    expect(absurdTvl.liquidityUsd).toBe(0);
    expect(absurdTvl.polluted).toBe(true);
  });

  it("demotes absurd pairs and prefers sane major pools in ranking", () => {
    const pairs = [
      {
        id: "dust-meme",
        reserveUSD: "9.9e30",
        reserve0: "1",
        reserve1: "1",
        // No usable derivedUSD → cannot re-estimate; fully demoted
        token0: { symbol: "SCAM" },
        token1: { symbol: "WPLS" },
      },
      {
        id: "wpls-dai",
        reserveUSD: "12500000",
        // Consistent-ish reserves: do not set low derivedUSD that would
        // trigger reserve-vs-estimate cross-check demotion of a major pool.
        reserve0: "1000000",
        reserve1: "1000000",
        token0: { symbol: "WPLS" },
        token1: { symbol: "DAI" },
      },
      {
        id: "hex-wpls",
        reserveUSD: "8000000",
        token0: { symbol: "HEX" },
        token1: { symbol: "WPLS" },
      },
    ];
    const ranked = rankPairsBySaneLiquidity(pairs);
    expect(ranked[0]!.id).toBe("wpls-dai");
    expect(ranked[0]!._saneLiquidityUsd).toBe(12_500_000);
    const dust = ranked.find((p) => p.id === "dust-meme")!;
    expect(dust._saneLiquidityUsd).toBe(0);
    expect(dust._liquidityPolluted).toBe(true);

    const sum = sumSanePairLiquidity(pairs);
    expect(sum.totalUsd).toBe(12_500_000 + 8_000_000);
    expect(sum.pollutedPairCount).toBeGreaterThanOrEqual(1);
  });

  it("estimates liquidity from reserves×derivedUSD when reserveUSD is absurd", () => {
    const pair = {
      reserveUSD: "1e40",
      reserve0: "1000",
      reserve1: "500",
      token0: { derivedUSD: "1" },
      token1: { derivedUSD: "2" },
    };
    expect(estimatePairLiquidityUsd(pair)).toBe(1000 * 1 + 500 * 2);
    const resolved = resolvePairLiquidityUsd(pair);
    expect(resolved.source).toBe("estimated");
    expect(resolved.liquidityUsd).toBe(2000);
    expect(resolved.polluted).toBe(true);
  });

  it("bridge-stats-style aggregation demotes absurd reserveUSD in totals", () => {
    // Same reduce path as get_bridge_stats: sumSanePairLiquidity + rankPairsBySaneLiquidity
    const pairs = [
      {
        id: "polluted",
        reserveUSD: "9.9e30",
        token0: { symbol: "DAI" },
        token1: { symbol: "SCAM" },
      },
      {
        id: "real-dai-wpls",
        reserveUSD: "2500000",
        token0: { symbol: "DAI" },
        token1: { symbol: "WPLS" },
      },
    ];
    const liq = sumSanePairLiquidity(pairs);
    expect(liq.totalUsd).toBe(2_500_000);
    expect(liq.pollutedPairCount).toBe(1);
    const ranked = rankPairsBySaneLiquidity(pairs);
    expect(ranked[0]!.id).toBe("real-dai-wpls");
    expect(ranked[0]!._saneLiquidityUsd).toBe(2_500_000);
    expect(ranked.find((p) => p.id === "polluted")!._saneLiquidityUsd).toBe(0);
  });

  it("mapPairsWithSaneLiquidity attaches catalog origin/display_symbol only for known addresses", () => {
    const rows = mapPairsWithSaneLiquidity([
      {
        id: "hex-wpls",
        reserveUSD: "1000000",
        volumeUSD: "500000",
        totalTransactions: "100",
        token0Price: "0.5",
        token1Price: "2",
        token0: { id: HEX_ADDRESS, symbol: "HEX" },
        token1: { id: WPLS_ADDRESS, symbol: "WPLS" },
      },
      {
        id: "pdai-unknown",
        reserveUSD: "200000",
        volumeUSD: "1000",
        token0: { id: FORK_DAI_ADDRESS, symbol: "DAI" },
        token1: {
          id: "0x00000000000000000000000000000000000000aa",
          symbol: "SCAM",
        },
      },
      {
        id: "bridged-dai-ehex",
        reserveUSD: "300000",
        volumeUSD: "2000",
        token0: { id: BRIDGED_DAI_ADDRESS, symbol: "DAI" },
        token1: { id: EHEX_ADDRESS, symbol: "HEX" },
      },
    ]);

    const hexRow = rows.find((r) => r.pair_address === "hex-wpls")!;
    expect(hexRow.token0_display_symbol).toMatch(/pHEX|HEX/i);
    expect(hexRow.token0_origin).toBeTruthy();
    expect(hexRow.token1_display_symbol).toBeTruthy(); // WPLS catalogued
    // Pair-relative prices preserved (not treated as USD by note)
    expect(hexRow.token0_price).toBe(0.5);
    expect(hexRow.token1_price).toBe(2);
    expect(PAIR_PRICE_FIELDS_NOTE).toMatch(/not usd/i);

    const pdaiRow = rows.find((r) => r.pair_address === "pdai-unknown")!;
    expect(pdaiRow.token0_display_symbol).toMatch(/pDAI|DAI/i);
    expect(pdaiRow.token0_origin).toBeTruthy();
    // Unknown SCAM side: no invented origin/display
    expect(pdaiRow.token1_display_symbol).toBeUndefined();
    expect(pdaiRow.token1_origin).toBeUndefined();

    const dual = rows.find((r) => r.pair_address === "bridged-dai-ehex")!;
    expect(dual.token0_display_symbol).toMatch(/DAI/i);
    expect(String(dual.token0_origin)).toMatch(/bridg|ethereum/i);
    expect(dual.token1_display_symbol).toMatch(/eHEX|HEX/i);
  });

  it("catalogPairSideLabels never invents origin for unknown addresses", () => {
    expect(catalogPairSideLabels("0x00000000000000000000000000000000000000bb")).toEqual(
      {},
    );
    expect(catalogPairSideLabels(undefined)).toEqual({});
    const phex = catalogPairSideLabels(HEX_ADDRESS);
    expect(phex.display_symbol).toBeTruthy();
    expect(phex.origin).toBeTruthy();
  });

  it("catalogPairSideLabels surfaces eUSDC / eWBTC / pWBTC display labels", () => {
    expect(catalogPairSideLabels(USDC_FROM_ETH_ADDRESS).display_symbol).toBe(
      "eUSDC",
    );
    expect(catalogPairSideLabels(USDC_FROM_ETH_ADDRESS).origin).toBeTruthy();
    expect(catalogPairSideLabels(EWBTC_ADDRESS).display_symbol).toBe("eWBTC");
    expect(catalogPairSideLabels(PWBTC_ADDRESS).display_symbol).toBe("pWBTC");
  });

  it("selectTopPairsByLiquidity stays non-empty when raw reserveUSD window is all polluted", () => {
    // Live P1: get_top_pairs(sort=liquidity) emptied after demoting multi-trillion rows
    const pollutedOnlyWindow = [
      {
        id: "poll-1",
        reserveUSD: "9e30",
        volumeUSD: "10",
        totalTransactions: "1",
        token0: { id: "0x1", symbol: "SCAM" },
        token1: { id: "0x2", symbol: "WPLS" },
      },
      {
        id: "poll-2",
        reserveUSD: "8e30",
        volumeUSD: "5",
        totalTransactions: "1",
        token0: { id: "0x3", symbol: "DUST" },
        token1: { id: "0x2", symbol: "WPLS" },
      },
    ];
    const emptyish = selectTopPairsByLiquidity(pollutedOnlyWindow, 10);
    expect(emptyish.pairs.length).toBeGreaterThan(0);
    expect(emptyish.usedVolumeFallback).toBe(true);
    expect(emptyish.pairs[0]!.pair_address).toBe("poll-1"); // higher volume

    // Mixed window (volume-active sane + polluted reserve leaders): sane ranks first
    const mixed = [
      ...pollutedOnlyWindow,
      {
        id: "wpls-plsx",
        reserveUSD: "15000000",
        volumeUSD: "9000000",
        totalTransactions: "50000",
        token0: { id: "0xa", symbol: "WPLS", derivedUSD: "0.00003" },
        token1: { id: "0xb", symbol: "PLSX", derivedUSD: "0.0001" },
      },
      {
        id: "hex-wpls",
        reserveUSD: "8000000",
        volumeUSD: "4000000",
        totalTransactions: "20000",
        token0: { id: "0xc", symbol: "HEX" },
        token1: { id: "0xa", symbol: "WPLS" },
      },
    ];
    const ranked = selectTopPairsByLiquidity(mixed, 5);
    expect(ranked.usedVolumeFallback).toBe(false);
    expect(ranked.pairs.length).toBeGreaterThanOrEqual(2);
    expect(ranked.pairs[0]!.pair_address).toBe("wpls-plsx");
    expect(ranked.pairs[0]!.liquidity_usd).toBe(15_000_000);
    expect(ranked.pairs[0]!.liquidity_polluted).toBe(false);
    // Fully demoted not included when sane rows remain
    expect(
      ranked.pairs.every((p) => p.liquidity_usd > 0 || ranked.usedVolumeFallback),
    ).toBe(true);
    expect(ranked.pairs.some((p) => p.pair_address.startsWith("poll-"))).toBe(
      false,
    );
  });

  it("token liquidity ranking does not put obviously polluted pools first", () => {
    const pairs = [
      {
        id: "polluted-est",
        reserveUSD: "1e40",
        // Absurd derivedUSD must not re-inflate ranking
        reserve0: "1e20",
        reserve1: "1e20",
        token0: { derivedUSD: String(MAX_SANE_TOKEN_DERIVED_USD * 10) },
        token1: { derivedUSD: String(MAX_SANE_TOKEN_DERIVED_USD * 10) },
      },
      {
        id: "polluted-demoted",
        reserveUSD: "9.9e30",
        token0: { symbol: "SCAM" },
        token1: { symbol: "WPLS" },
      },
      {
        id: "sane-major",
        reserveUSD: "5000000",
        token0: { symbol: "PLSX" },
        token1: { symbol: "WPLS" },
      },
      {
        id: "sane-mid",
        reserveUSD: "1200000",
        token0: { symbol: "HEX" },
        token1: { symbol: "WPLS" },
      },
    ];

    const ranked = rankPairsBySaneLiquidity(pairs);
    expect(ranked[0]!.id).toBe("sane-major");
    expect(ranked[0]!._liquidityPolluted).toBe(false);
    expect(ranked[0]!._saneLiquidityUsd).toBe(5_000_000);
    expect(ranked[1]!.id).toBe("sane-mid");
    // Polluted rows sink after positive sane liquidity
    const firstPollutedIdx = ranked.findIndex((p) => p._liquidityPolluted);
    expect(firstPollutedIdx).toBeGreaterThan(1);
    expect(estimatePairLiquidityUsd(pairs[0]!)).toBeNull();
  });

  it("rejects absurd derivedUSD in estimatePairLiquidityUsd", () => {
    expect(
      estimatePairLiquidityUsd({
        reserve0: "100",
        reserve1: "100",
        token0: { derivedUSD: String(MAX_SANE_TOKEN_DERIVED_USD + 1) },
        token1: { derivedUSD: "1" },
      }),
    ).toBeNull();
  });

  it("cross-checks inflated reserveUSD against reserves×derivedUSD", () => {
    // Under hard cap but 10×+ above estimate → prefer estimate + polluted
    const pair = {
      reserveUSD: "50000000",
      reserve0: "1000",
      reserve1: "1000",
      token0: { derivedUSD: "1" },
      token1: { derivedUSD: "1" },
    };
    const resolved = resolvePairLiquidityUsd(pair);
    expect(resolved.source).toBe("estimated");
    expect(resolved.liquidityUsd).toBe(2000);
    expect(resolved.polluted).toBe(true);
  });
});

describe("token-filtered swap path (shipped helpers)", () => {
  const plsx = PLSX_ADDRESS.toLowerCase();
  const wpls = WPLS_ADDRESS.toLowerCase();
  const pairA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const pairB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const pairC = "0xcccccccccccccccccccccccccccccccccccccccc";
  const pairD = "0xdddddddddddddddddddddddddddddddddddddddd";
  const pairE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const other = "0x1111111111111111111111111111111111111111";

  it("selectTokenSwapPairIds caps fan-out and prefers volume", () => {
    expect(MAX_TOKEN_SWAP_PAIR_QUERIES).toBeLessThanOrEqual(8);
    const many = [pairA, pairB, pairC, pairD, pairE, pairA, pairB].map(
      (id, i) => ({
        id: id.slice(0, -1) + i.toString(16), // unique ids
        volumeUSD: String(100 - i),
        reserveUSD: "1000000",
        token0: { id: plsx },
        token1: { id: wpls },
      }),
    );
    // ensure unique valid-length ids
    const unique = [pairA, pairB, pairC, pairD, pairE].map((id, i) => ({
      id,
      volumeUSD: String((5 - i) * 1_000_000),
      reserveUSD: "1000000",
      token0: { id: plsx },
      token1: { id: wpls },
    }));
    const ids = selectTokenSwapPairIds(unique, plsx);
    expect(ids.length).toBeLessThanOrEqual(MAX_TOKEN_SWAP_PAIR_QUERIES);
    expect(ids[0]).toBe(pairA); // highest volume
    // Unrelated pair dropped
    const mixed = [
      {
        id: pairA,
        volumeUSD: "999",
        reserveUSD: "1000",
        token0: { id: other },
        token1: { id: wpls },
      },
      {
        id: pairB,
        volumeUSD: "10",
        reserveUSD: "1000",
        token0: { id: plsx },
        token1: { id: wpls },
      },
    ];
    expect(selectTokenSwapPairIds(mixed, plsx)).toEqual([pairB]);
    void many;
  });

  it("mergeTokenFilteredSwaps keeps strict filter and pair-id fallback", () => {
    const results = [
      {
        pairId: pairA,
        swaps: [
          {
            id: "s1",
            timestamp: "200",
            amountUSD: "50",
            pair: {
              id: pairA,
              token0: { id: plsx, symbol: "PLSX" },
              token1: { id: wpls, symbol: "WPLS" },
            },
          },
          {
            id: "s-bad",
            timestamp: "150",
            amountUSD: "9",
            pair: {
              id: pairB,
              token0: { id: other, symbol: "SCAM" },
              token1: { id: wpls, symbol: "WPLS" },
            },
          },
        ],
      },
      {
        pairId: pairC,
        swaps: [
          {
            id: "s2",
            timestamp: "300",
            amountUSD: "12",
            // symbol-only shape — kept via verified pair id
            pair: {
              id: pairC,
              token0: { symbol: "PLSX" },
              token1: { symbol: "WPLS" },
            },
          },
        ],
      },
      {
        pairId: pairD,
        swaps: [],
        error: "timeout",
      },
    ];
    const merged = mergeTokenFilteredSwaps({
      results,
      tokenFilter: plsx,
      first: 10,
    });
    expect(merged.partial).toBe(true);
    expect(merged.pairsFailed).toEqual([pairD]);
    expect(merged.swaps.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(merged.droppedUnrelated).toBe(1);
  });

  it("mergeTokenFilteredSwaps surfaces all-failed partial soft path inputs", () => {
    const merged = mergeTokenFilteredSwaps({
      results: [
        { pairId: pairA, swaps: [], error: "timeout" },
        { pairId: pairB, swaps: [], error: "abort" },
      ],
      tokenFilter: plsx,
      first: 5,
    });
    expect(merged.swaps).toEqual([]);
    expect(merged.partial).toBe(true);
    expect(merged.pairsFailed).toHaveLength(2);
  });
});

describe("swap token filter (strict)", () => {
  const plsx = PLSX_ADDRESS.toLowerCase();
  const wpls = WPLS_ADDRESS.toLowerCase();
  const other = "0x1111111111111111111111111111111111111111";
  const pairPlsxWpls = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const pairScamWpls = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  const swaps = [
    {
      id: "1",
      timestamp: "100",
      pair: {
        id: pairPlsxWpls,
        token0: { id: plsx, symbol: "PLSX" },
        token1: { id: wpls, symbol: "WPLS" },
      },
    },
    {
      id: "2",
      timestamp: "200",
      pair: {
        id: pairScamWpls,
        token0: { id: other, symbol: "SCAM" },
        token1: { id: wpls, symbol: "WPLS" },
      },
    },
    {
      id: "3",
      timestamp: "300",
      pair: {
        id: pairPlsxWpls,
        token0: { id: wpls, symbol: "WPLS" },
        token1: { id: plsx, symbol: "PLSX" },
      },
    },
  ];

  it("swapInvolvesToken matches token0 or token1 only", () => {
    expect(swapInvolvesToken(swaps[0]!, plsx)).toBe(true);
    expect(swapInvolvesToken(swaps[1]!, plsx)).toBe(false);
    expect(swapInvolvesTokenSubgraph(swaps[2]!, plsx)).toBe(true);
  });

  it("filterSwapsByToken drops unrelated pairs (no silent pollution)", () => {
    const filtered = filterSwapsByToken(swaps, plsx);
    expect(filtered.map((s) => s.id)).toEqual(["1", "3"]);
    expect(filtered.every((s) => swapInvolvesTokenSubgraph(s, plsx))).toBe(
      true,
    );
  });

  /**
   * Live SWAPS_QUERY historically selected only token0/1.symbol (no id).
   * Id-only post-filter emptied get_recent_swaps(token=…). Regression must use
   * that real GraphQL shape + verified pairIds (shipped path).
   */
  it("keeps swaps when GraphQL returns symbol-only tokens if pairId is verified", () => {
    const symbolOnlyShape = [
      {
        id: "live-1",
        timestamp: "1000",
        pair: {
          id: pairPlsxWpls,
          token0: { symbol: "PLSX" }, // no id — real pre-fix SWAPS_QUERY shape
          token1: { symbol: "WPLS" },
        },
        amountUSD: "50",
      },
      {
        id: "live-2",
        timestamp: "1001",
        pair: {
          id: pairScamWpls,
          token0: { symbol: "SCAM" },
          token1: { symbol: "WPLS" },
        },
        amountUSD: "99",
      },
    ];

    // Without pairIds: token id missing → drop all (cannot guarantee)
    expect(filterSwapsByToken(symbolOnlyShape, plsx)).toEqual([]);
    expect(
      symbolOnlyShape.every(
        (s) => !swapInvolvesTokenSubgraph(s, plsx),
      ),
    ).toBe(true);

    // With verified pairIds from fetchPairsForToken (shipped token path)
    const allowed = new Set([pairPlsxWpls.toLowerCase()]);
    const kept = filterSwapsByToken(symbolOnlyShape, plsx, allowed);
    expect(kept.map((s) => s.id)).toEqual(["live-1"]);
    expect(kept).toHaveLength(1);
    expect(
      swapInvolvesTokenSubgraph(symbolOnlyShape[0]!, plsx, allowed),
    ).toBe(true);
    expect(
      swapInvolvesTokenSubgraph(symbolOnlyShape[1]!, plsx, allowed),
    ).toBe(false);
  });
});

describe("buildTokenInfoPayload soft-fail identity (v0.1.37)", () => {
  const eusdc = USDC_FROM_ETH_ADDRESS;
  const unknown = "0x1111111111111111111111111111111111111111";

  it("returns partial success with catalog identity when subgraph token blips", () => {
    const result = buildTokenInfoPayload({
      address: eusdc,
      version: "v2",
      token: null,
      pairs: [],
      explorerMeta: null,
      v2Meta: null,
      subgraphTokenFailed: true,
      subgraphTokenError: "database unavailable",
    });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.data.display_symbol).toBe("eUSDC");
    expect(result.data.token_origin).toBe("bridged");
    expect(result.data.partial).toBe(true);
    expect(result.data.price_usd).toBeNull();
    expect(Array.isArray(result.data.source_notes)).toBe(true);
    expect(result.data.is_eusdc === true || result.data.is_bridged_usdc === true).toBe(
      true,
    );
  });

  it("does not invent origin for unknown address with no sources", () => {
    const result = buildTokenInfoPayload({
      address: unknown,
      version: "v2",
      token: null,
      pairs: [],
      explorerMeta: null,
      v2Meta: null,
      subgraphTokenFailed: true,
    });
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toMatch(/not found/i);
  });

  it("succeeds with explorer-only metadata and no invented origin for unknown", () => {
    const result = buildTokenInfoPayload({
      address: unknown,
      version: "v2",
      token: null,
      pairs: [],
      explorerMeta: { name: "Mystery", symbol: "MYST", decimals: "18" },
      v2Meta: null,
      subgraphTokenFailed: true,
    });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.data.symbol).toBe("MYST");
    expect(result.data.token_origin).toBeUndefined();
    expect(result.data.display_symbol).toBeUndefined();
    expect(result.data.partial).toBe(true);
  });

  it("preserves nested pair labels and market fields when token entity present", () => {
    const result = buildTokenInfoPayload({
      address: eusdc,
      version: "v2",
      token: {
        id: eusdc.toLowerCase(),
        symbol: "USDC",
        name: "USD Coin from Ethereum",
        decimals: "6",
        totalSupply: "1",
        tradeVolumeUSD: "100",
        totalTransactions: "9",
        totalLiquidity: "10",
        derivedUSD: "1",
        derivedPLS: "100",
      },
      pairs: [
        {
          id: "0x3225e3b0d3c6b97ec9848f7b40bb3030e5497709",
          token0: {
            id: eusdc.toLowerCase(),
            symbol: "USDC",
            derivedUSD: "1",
          },
          token1: {
            id: BRIDGED_DAI_ADDRESS.toLowerCase(),
            symbol: "DAI",
            derivedUSD: "1",
          },
          reserveUSD: "199000",
          volumeUSD: "1000",
        },
      ],
      explorerMeta: null,
      v2Meta: { holders: "100" },
    });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.data.display_symbol).toBe("eUSDC");
    const pairs = result.data.pairs as Array<Record<string, unknown>>;
    expect(pairs[0]!.token0_display_symbol).toBe("eUSDC");
    expect(pairs[0]!.token1_display_symbol).toBe("DAI");
    expect(pairs[0]!.token1_origin).toBe("bridged");
  });
});

describe("label parity for raw tops and swaps (v0.1.37)", () => {
  it("labelSubgraphTokenRow labels catalogued pHEX and leaves unknown bare", () => {
    const labeled = labelSubgraphTokenRow({
      id: HEX_ADDRESS.toLowerCase(),
      symbol: "HEX",
    });
    expect(labeled.display_symbol).toBe("pHEX");
    expect(labeled.token_origin).toBe("state_fork");
    expect(labeled.symbol).toBe("HEX");

    const bare = labelSubgraphTokenRow({
      id: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
      symbol: "SCAM",
    });
    expect(bare.display_symbol).toBeUndefined();
    expect(bare.token_origin).toBeUndefined();
    expect(bare.symbol).toBe("SCAM");
  });

  it("labelSubgraphPairRow labels eUSDC/bridged-DAI sides only", () => {
    const labeled = labelSubgraphPairRow({
      id: "0x3225e3b0d3c6b97ec9848f7b40bb3030e5497709",
      token0: {
        id: USDC_FROM_ETH_ADDRESS.toLowerCase(),
        symbol: "USDC",
      },
      token1: {
        id: BRIDGED_DAI_ADDRESS.toLowerCase(),
        symbol: "DAI",
      },
    });
    expect(labeled.token0_display_symbol).toBe("eUSDC");
    expect(labeled.token0_origin).toBe("bridged");
    expect(labeled.token1_display_symbol).toBe("DAI");
    expect(labeled.token1_origin).toBe("bridged");
    expect(labeled.token0?.display_symbol).toBe("eUSDC");
  });

  it("labelSubgraphSwapRow attaches pair-side labels for catalogued assets", () => {
    const labeled = labelSubgraphSwapRow({
      id: "swap1",
      pair: {
        id: "0xabc",
        token0: { id: HEX_ADDRESS.toLowerCase(), symbol: "HEX" },
        token1: {
          id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          symbol: "UNK",
        },
      },
    });
    expect(labeled.pair?.token0_display_symbol).toBe("pHEX");
    expect(labeled.pair?.token0_origin).toBe("state_fork");
    expect(labeled.pair?.token1_display_symbol).toBeUndefined();
    expect(labeled.pair?.token1_origin).toBeUndefined();
  });
});
