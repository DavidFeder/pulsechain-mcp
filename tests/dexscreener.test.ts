/**
 * DexScreener client + tools — drives shipped URL builders, normalization,
 * and fail-soft HTTP boundary (mocked fetch only).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGED_DAI_ADDRESS,
  EHEX_ADDRESS,
  EHEX_MAJOR_PAIR_ADDRESS,
  EUSDC_MAJOR_PAIR_ADDRESS,
  EUSDT_MAJOR_PAIR_ADDRESS,
  EWBTC_ADDRESS,
  FORK_DAI_ADDRESS,
  HEX_ADDRESS,
  PLSX_ADDRESS,
  PWBTC_ADDRESS,
  USDC_FROM_ETH_ADDRESS,
  USDT_FROM_ETH_ADDRESS,
} from "../src/constants.js";
import {
  DEFAULT_DEXSCREENER_CHAIN,
  DEXSCREENER_API_BASE,
  DEXSCREENER_PULSECHAIN_ID,
  DEXSCREENER_SEARCH_GUIDANCE,
  buildCatalogSearchCoverage,
  buildDexScreenerPairUrl,
  buildDexScreenerSearchUrl,
  buildDexScreenerTokenPairsUrl,
  buildDexScreenerTokensUrl,
  composeSearchGuidance,
  dexscreenerGetJson,
  extractPairsFromResponse,
  filterPairsByChain,
  getDexScreenerPair,
  getDexScreenerTokenPairs,
  normalizeDexScreenerPair,
  rankAndAnnotateSearchPairs,
  resetDexScreenerSpacing,
  searchDexScreenerPairs,
} from "../src/data/dexscreener.js";

const SAMPLE_PAIR = {
  chainId: "pulsechain",
  dexId: "pulsex",
  url: "https://dexscreener.com/pulsechain/0xabc",
  pairAddress: "0x708E379EC15Be00abf1aC827aF6cFf615945dB61",
  labels: ["v2"],
  baseToken: {
    address: PLSX_ADDRESS,
    name: "PulseX",
    symbol: "PLSX",
  },
  quoteToken: {
    address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
    name: "Wrapped Pulse",
    symbol: "WPLS",
  },
  priceNative: "1.0",
  priceUsd: "0.00001",
  txns: { h24: { buys: 10, sells: 5 } },
  volume: { h24: 1000 },
  priceChange: { h24: 1.5 },
  liquidity: { usd: 50000, base: 1e12, quote: 1e12 },
  fdv: 1e6,
  marketCap: 1e6,
  pairCreatedAt: 1680000000000,
};

const SAMPLE_DAI_PAIR = {
  ...SAMPLE_PAIR,
  pairAddress: "0x1111111111111111111111111111111111111111",
  baseToken: {
    address: BRIDGED_DAI_ADDRESS,
    name: "Dai Stablecoin from Ethereum",
    symbol: "DAI",
  },
  quoteToken: {
    address: FORK_DAI_ADDRESS,
    name: "Dai Stablecoin",
    symbol: "DAI",
  },
};

afterEach(() => {
  resetDexScreenerSpacing();
  vi.restoreAllMocks();
});

describe("DexScreener URL builders (shipped)", () => {
  it("search URL uses /latest/dex/search and encodes query", () => {
    const url = buildDexScreenerSearchUrl("PLSX");
    expect(url).toBe(
      `${DEXSCREENER_API_BASE}/latest/dex/search?q=PLSX`,
    );
    expect(buildDexScreenerSearchUrl("eHEX WPLS")).toContain(
      "q=eHEX+WPLS",
    );
  });

  it("pair URL defaults path with pulsechain chain id", () => {
    const pair = "0x708E379EC15Be00abf1aC827aF6cFf615945dB61";
    const url = buildDexScreenerPairUrl(DEFAULT_DEXSCREENER_CHAIN, pair);
    expect(url).toBe(
      `${DEXSCREENER_API_BASE}/latest/dex/pairs/pulsechain/${pair}`,
    );
    expect(DEXSCREENER_PULSECHAIN_ID).toBe("pulsechain");
  });

  it("token-pairs and tokens URLs use v1 paths", () => {
    const token = PLSX_ADDRESS;
    expect(buildDexScreenerTokenPairsUrl("pulsechain", token)).toBe(
      `${DEXSCREENER_API_BASE}/token-pairs/v1/pulsechain/${token}`,
    );
    expect(buildDexScreenerTokensUrl("pulsechain", [token, HEX_ADDRESS])).toBe(
      `${DEXSCREENER_API_BASE}/tokens/v1/pulsechain/${encodeURIComponent(`${token},${HEX_ADDRESS}`)}`,
    );
  });
});

describe("normalizeDexScreenerPair / extract / filter (shipped)", () => {
  it("normalizes pair and attaches origin labels for known tokens", () => {
    const n = normalizeDexScreenerPair(SAMPLE_DAI_PAIR)!;
    expect(n).not.toBeNull();
    expect(n.chainId).toBe("pulsechain");
    expect(n.baseToken.origin?.token_origin).toBe("bridged");
    expect(n.baseToken.origin?.is_bridged_dai).toBe(true);
    expect(n.quoteToken.origin?.is_fork_dai).toBe(true);
    expect(n.quoteToken.origin?.do_not_treat_as_usd_stable).toBe(true);
    expect(n.liquidity?.usd).toBe(50000);
  });

  it("extracts pairs from { pairs } envelope and raw array", () => {
    expect(extractPairsFromResponse({ pairs: [SAMPLE_PAIR] })).toHaveLength(1);
    expect(extractPairsFromResponse([SAMPLE_PAIR, SAMPLE_PAIR])).toHaveLength(2);
    expect(extractPairsFromResponse({ pair: SAMPLE_PAIR })).toHaveLength(1);
    expect(extractPairsFromResponse(null)).toEqual([]);
  });

  it("filters to pulsechain only", () => {
    const eth = normalizeDexScreenerPair({
      ...SAMPLE_PAIR,
      chainId: "ethereum",
      pairAddress: "0x2222222222222222222222222222222222222222",
    })!;
    const pls = normalizeDexScreenerPair(SAMPLE_PAIR)!;
    const filtered = filterPairsByChain([eth, pls], "pulsechain");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.chainId).toBe("pulsechain");
  });

  it("returns null for malformed pair", () => {
    expect(normalizeDexScreenerPair({})).toBeNull();
    expect(normalizeDexScreenerPair(null)).toBeNull();
  });
});

describe("dexscreenerGetJson fail-soft (shipped HTTP path)", () => {
  const cfg = { httpTimeoutMs: 5_000 };

  it("returns body on HTTP 200", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ pairs: [SAMPLE_PAIR] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await dexscreenerGetJson(
      buildDexScreenerSearchUrl("PLSX"),
      cfg,
      { fetchImpl: fetchImpl as unknown as typeof fetch, skipSpacing: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.body as { pairs: unknown[] }).pairs).toHaveLength(1);
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledUrl = String(fetchImpl.mock.calls[0]![0]);
    expect(calledUrl).toContain("/latest/dex/search?q=PLSX");
  });

  it("soft-fails on HTTP 429", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("rate", { status: 429 }),
    );
    const res = await dexscreenerGetJson(
      buildDexScreenerSearchUrl("x"),
      cfg,
      { fetchImpl: fetchImpl as unknown as typeof fetch, skipSpacing: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(429);
      expect(res.reason).toMatch(/rate limit|429/i);
    }
  });

  it("soft-fails on network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await dexscreenerGetJson(
      buildDexScreenerSearchUrl("x"),
      cfg,
      { fetchImpl: fetchImpl as unknown as typeof fetch, skipSpacing: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/network|ECONNREFUSED/i);
    }
  });

  it("soft-fails on HTTP 500", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("err", { status: 500 }),
    );
    const res = await dexscreenerGetJson(
      buildDexScreenerPairUrl("pulsechain", SAMPLE_PAIR.pairAddress),
      cfg,
      { fetchImpl: fetchImpl as unknown as typeof fetch, skipSpacing: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(500);
      expect(res.reason).toMatch(/HTTP 500/);
    }
  });
});

describe("rankAndAnnotateSearchPairs (shipped spoof-aware search)", () => {
  const SPOOF_DAI = "0xf598cb1d27fb2c5c731f535ad6c1d0ec5efe1320";
  const SPOOF_HEX = "0x55c50875e890c7ee5621480bab02511c380e12c6";

  it("ranks catalogued same-symbol ahead of unknown low-liq spoof and annotates spoof", () => {
    const spoofRaw = {
      chainId: "pulsechain",
      dexId: "pulsex",
      url: "https://dexscreener.com/pulsechain/0xspoof",
      pairAddress: "0xeC052d46D3115DF7F6058160Cd0b87b272201341",
      baseToken: {
        address: SPOOF_DAI,
        name: "DAI",
        symbol: "DAI",
      },
      quoteToken: {
        address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
        name: "Wrapped Pulse",
        symbol: "WPLS",
      },
      liquidity: { usd: 32_000 },
      priceUsd: "0.00019",
    };
    const knownRaw = {
      ...SAMPLE_DAI_PAIR,
      pairAddress: "0xB2893ceA8080bF43b7b60B589EDaAb5211D98F23",
      baseToken: {
        address: BRIDGED_DAI_ADDRESS,
        name: "Dai Stablecoin from Ethereum",
        symbol: "DAI",
      },
      quoteToken: {
        address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
        name: "Wrapped Pulse",
        symbol: "WPLS",
      },
      liquidity: { usd: 80_000 },
    };
    // Spoof first in input order (upstream ranking); catalog must win after rank
    const input = [
      normalizeDexScreenerPair(spoofRaw)!,
      normalizeDexScreenerPair(knownRaw)!,
    ];
    expect(input[0]!.baseToken.origin).toBeUndefined();
    expect(input[1]!.baseToken.origin?.is_bridged_dai).toBe(true);

    const { pairs, symbol_collisions } = rankAndAnnotateSearchPairs(input);

    expect(pairs).toHaveLength(2);
    // Known catalogued DAI pair first
    expect(pairs[0]!.baseToken.address.toLowerCase()).toBe(
      BRIDGED_DAI_ADDRESS.toLowerCase(),
    );
    expect(pairs[0]!.baseToken.origin?.token_origin).toBe("bridged");
    // Spoof never gets fabricated origin
    expect(pairs[1]!.baseToken.origin).toBeUndefined();
    expect(pairs[1]!.baseToken.address.toLowerCase()).toBe(SPOOF_DAI);
    expect(pairs[1]!.search_flags?.symbol_collision).toBe(true);
    expect(pairs[1]!.search_flags?.ticker_spoof_risk).toBe("high");
    expect(pairs[1]!.search_flags?.demoted).toBe(true);
    expect(pairs[1]!.search_flags?.prefer_address_tools).toBe(true);
    expect(pairs[1]!.search_flags?.reason).toMatch(/catalog|spoof|address/i);

    const daiCol = symbol_collisions.find((c) => c.symbol === "DAI");
    expect(daiCol).toBeDefined();
    expect(daiCol!.known_catalog_addresses).toContain(
      BRIDGED_DAI_ADDRESS.toLowerCase(),
    );
    expect(daiCol!.unknown_addresses).toContain(SPOOF_DAI.toLowerCase());
  });

  it("does not drop discovery pairs (only demotes/annotates)", () => {
    const a = normalizeDexScreenerPair({
      chainId: "pulsechain",
      dexId: "pulsex",
      url: "u",
      pairAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseToken: { address: SPOOF_HEX, name: "HEX", symbol: "HEX" },
      quoteToken: {
        address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
        name: "WPLS",
        symbol: "WPLS",
      },
      liquidity: { usd: 1000 },
    })!;
    const b = normalizeDexScreenerPair({
      chainId: "pulsechain",
      dexId: "pulsex",
      url: "u2",
      pairAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      baseToken: {
        address: HEX_ADDRESS,
        name: "HEX",
        symbol: "HEX",
      },
      quoteToken: {
        address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
        name: "WPLS",
        symbol: "WPLS",
      },
      liquidity: { usd: 500_000 },
    })!;
    const { pairs } = rankAndAnnotateSearchPairs([a, b]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.baseToken.address.toLowerCase()).toBe(
      HEX_ADDRESS.toLowerCase(),
    );
    expect(pairs[0]!.baseToken.origin?.is_phex).toBe(true);
    expect(pairs[1]!.search_flags?.ticker_spoof_risk).toBeDefined();
  });

  it("annotates multi-unknown same-symbol without inventing origin", () => {
    const u1 = normalizeDexScreenerPair({
      chainId: "pulsechain",
      dexId: "x",
      url: "u",
      pairAddress: "0x1111111111111111111111111111111111111111",
      baseToken: {
        address: "0x11111111111111111111111111111111111111aa",
        name: "X",
        symbol: "FOO",
      },
      quoteToken: {
        address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
        name: "WPLS",
        symbol: "WPLS",
      },
      liquidity: { usd: 500 },
    })!;
    const u2 = normalizeDexScreenerPair({
      chainId: "pulsechain",
      dexId: "x",
      url: "u",
      pairAddress: "0x2222222222222222222222222222222222222222",
      baseToken: {
        address: "0x22222222222222222222222222222222222222bb",
        name: "X",
        symbol: "FOO",
      },
      quoteToken: {
        address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
        name: "WPLS",
        symbol: "WPLS",
      },
      liquidity: { usd: 900 },
    })!;
    const { pairs, symbol_collisions } = rankAndAnnotateSearchPairs([u1, u2]);
    expect(pairs).toHaveLength(2);
    for (const p of pairs) {
      expect(p.baseToken.origin).toBeUndefined();
      expect(p.search_flags?.symbol_collision).toBe(true);
      expect(p.search_flags?.ticker_spoof_risk).toBeDefined();
    }
    expect(symbol_collisions.some((c) => c.symbol === "FOO")).toBe(true);
  });
});

describe("buildCatalogSearchCoverage (missing canonical / spoof-dominated)", () => {
  const SPOOF_DAI = "0xf598cb1d27fb2c5c731f535ad6c1d0ec5efe1320";
  const SPOOF_USDC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SPOOF_WBTC = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("flags missing bridged DAI when upstream is spoof-only and recommends address follow-ups", () => {
    const spoofOnly = rankAndAnnotateSearchPairs([
      normalizeDexScreenerPair({
        chainId: "pulsechain",
        dexId: "pulsex",
        url: "u",
        pairAddress: "0xeC052d46D3115DF7F6058160Cd0b87b272201341",
        baseToken: {
          address: SPOOF_DAI,
          name: "DAI",
          symbol: "DAI",
        },
        quoteToken: {
          address: FORK_DAI_ADDRESS,
          name: "pDAI",
          symbol: "DAI",
        },
        liquidity: { usd: 32_000 },
      })!,
    ]);

    const { catalog_coverage, recommended_address_followups } =
      buildCatalogSearchCoverage("DAI", spoofOnly.pairs);

    expect(catalog_coverage).not.toBeNull();
    expect(catalog_coverage!.query_matched_catalog).toBe(true);
    expect(catalog_coverage!.canonical_missing_from_upstream).toBe(true);
    expect(catalog_coverage!.spoof_dominated).toBe(true);
    expect(catalog_coverage!.note).toMatch(
      /missing|omits|spoof-dominated|canonical|address/i,
    );
    // Bridged DAI must be recommended — never invent a pair row for it
    expect(
      recommended_address_followups.some(
        (f) =>
          f.address.toLowerCase() === BRIDGED_DAI_ADDRESS.toLowerCase() &&
          f.preferred_tool === "dexscreener_token_pairs",
      ),
    ).toBe(true);
    expect(recommended_address_followups[0]!.reason).toMatch(
      /missing|canonical|dexscreener_token_pairs|address/i,
    );
    // Guidance composition includes follow-ups without fabricating pairs
    const guidance = composeSearchGuidance(
      DEXSCREENER_SEARCH_GUIDANCE,
      catalog_coverage,
      recommended_address_followups,
    );
    expect(guidance).toMatch(/bridged DAI|0xefD7|dexscreener_token_pairs/i);
    expect(guidance).toMatch(/discovery-only|never invent/i);
    // No invented pair addresses in follow-ups beyond catalog
    for (const f of recommended_address_followups) {
      expect(f.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(f.preferred_tool).toBe("dexscreener_token_pairs");
    }
  });

  it("does not claim missing when bridged DAI is present in results", () => {
    const withCanonical = rankAndAnnotateSearchPairs([
      normalizeDexScreenerPair({
        chainId: "pulsechain",
        dexId: "pulsex",
        url: "u",
        pairAddress: "0xB2893ceA8080bF43b7b60B589EDaAb5211D98F23",
        baseToken: {
          address: BRIDGED_DAI_ADDRESS,
          name: "Dai Stablecoin from Ethereum",
          symbol: "DAI",
        },
        quoteToken: {
          address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
          name: "WPLS",
          symbol: "WPLS",
        },
        liquidity: { usd: 100_000 },
      })!,
    ]);
    const { catalog_coverage, recommended_address_followups } =
      buildCatalogSearchCoverage("DAI", withCanonical.pairs);
    expect(catalog_coverage).not.toBeNull();
    expect(catalog_coverage!.canonical_missing_from_upstream).toBe(false);
    expect(catalog_coverage!.spoof_dominated).toBe(false);
    expect(recommended_address_followups).toHaveLength(0);
  });

  it("returns null coverage for unknown symbols (no catalog expansion)", () => {
    const { catalog_coverage, recommended_address_followups } =
      buildCatalogSearchCoverage("MEMECOINXYZ", []);
    expect(catalog_coverage).toBeNull();
    expect(recommended_address_followups).toHaveLength(0);
  });

  it("USDC spoof-dominated search recommends eUSDC token + known major pair (no fabricated rows)", () => {
    const spoofOnly = rankAndAnnotateSearchPairs([
      normalizeDexScreenerPair({
        chainId: "pulsechain",
        dexId: "pulsex",
        url: "u",
        pairAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
        baseToken: {
          address: SPOOF_USDC,
          name: "Fake USDC",
          symbol: "USDC",
        },
        quoteToken: {
          address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
          name: "WPLS",
          symbol: "WPLS",
        },
        liquidity: { usd: 1_000 },
      })!,
    ]);

    const { catalog_coverage, recommended_address_followups } =
      buildCatalogSearchCoverage("USDC", spoofOnly.pairs);

    expect(catalog_coverage).not.toBeNull();
    expect(catalog_coverage!.canonical_missing_from_upstream).toBe(true);
    expect(catalog_coverage!.spoof_dominated).toBe(true);

    const tokenFollow = recommended_address_followups.find(
      (f) =>
        f.address.toLowerCase() === USDC_FROM_ETH_ADDRESS.toLowerCase() &&
        f.preferred_tool === "dexscreener_token_pairs",
    );
    expect(tokenFollow).toBeDefined();
    expect(tokenFollow!.display_name).toMatch(/eUSDC|bridged USDC/i);

    const pairFollow = recommended_address_followups.find(
      (f) =>
        f.address.toLowerCase() === EUSDC_MAJOR_PAIR_ADDRESS.toLowerCase() &&
        f.preferred_tool === "dexscreener_pair",
    );
    expect(pairFollow).toBeDefined();
    expect(pairFollow!.role).toBe("known_major_pair_guidance");
    expect(pairFollow!.reason).toMatch(/guidance|not a fabricated/i);
    // v0.1.36 regression: never recommend the stale pHEX/WPLS pair as eUSDC major
    expect(
      recommended_address_followups.some(
        (f) =>
          f.address.toLowerCase() ===
          "0x8c357be2cf2c1de1c4dca8aea0af1529f789976b",
      ),
    ).toBe(false);
    expect(EUSDC_MAJOR_PAIR_ADDRESS.toLowerCase()).toBe(
      "0x3225e3b0d3c6b97ec9848f7b40bb3030e5497709",
    );

    // No invented pair rows beyond catalog token + known major pair
    for (const f of recommended_address_followups) {
      expect(f.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(["dexscreener_token_pairs", "dexscreener_pair"]).toContain(
        f.preferred_tool,
      );
    }
  });

  it("EUSDT missing-canonical recommends eUSDT token + major pair", () => {
    const { catalog_coverage, recommended_address_followups } =
      buildCatalogSearchCoverage("EUSDT", []);
    expect(catalog_coverage).not.toBeNull();
    expect(catalog_coverage!.canonical_missing_from_upstream).toBe(true);
    expect(
      recommended_address_followups.some(
        (f) =>
          f.address.toLowerCase() === USDT_FROM_ETH_ADDRESS.toLowerCase() &&
          f.preferred_tool === "dexscreener_token_pairs",
      ),
    ).toBe(true);
    expect(
      recommended_address_followups.some(
        (f) =>
          f.address.toLowerCase() === EUSDT_MAJOR_PAIR_ADDRESS.toLowerCase() &&
          f.preferred_tool === "dexscreener_pair",
      ),
    ).toBe(true);
  });

  it("EHEX missing recommends eHEX token + major pair; does not invent rows", () => {
    const { recommended_address_followups } = buildCatalogSearchCoverage(
      "EHEX",
      [],
    );
    expect(
      recommended_address_followups.some(
        (f) =>
          f.address.toLowerCase() === EHEX_ADDRESS.toLowerCase() &&
          f.preferred_tool === "dexscreener_token_pairs",
      ),
    ).toBe(true);
    expect(
      recommended_address_followups.some(
        (f) =>
          f.address.toLowerCase() === EHEX_MAJOR_PAIR_ADDRESS.toLowerCase() &&
          f.preferred_tool === "dexscreener_pair",
      ),
    ).toBe(true);
  });

  it("WBTC spoof-dominated recommends eWBTC; PWBTC sibling when primary missing", () => {
    const spoofOnly = rankAndAnnotateSearchPairs([
      normalizeDexScreenerPair({
        chainId: "pulsechain",
        dexId: "pulsex",
        url: "u",
        pairAddress: "0xdddddddddddddddddddddddddddddddddddddddd",
        baseToken: {
          address: SPOOF_WBTC,
          name: "Fake WBTC",
          symbol: "WBTC",
        },
        quoteToken: {
          address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
          name: "WPLS",
          symbol: "WPLS",
        },
        liquidity: { usd: 500 },
      })!,
    ]);
    const { catalog_coverage, recommended_address_followups } =
      buildCatalogSearchCoverage("WBTC", spoofOnly.pairs);
    expect(catalog_coverage!.canonical_missing_from_upstream).toBe(true);
    expect(catalog_coverage!.spoof_dominated).toBe(true);
    expect(
      recommended_address_followups.some(
        (f) => f.address.toLowerCase() === EWBTC_ADDRESS.toLowerCase(),
      ),
    ).toBe(true);
    // Sibling pWBTC also recommended when primary missing (dual-asset family)
    expect(
      recommended_address_followups.some(
        (f) => f.address.toLowerCase() === PWBTC_ADDRESS.toLowerCase(),
      ),
    ).toBe(true);
  });

  it("does not force follow-ups when eUSDC is already present", () => {
    const withCanonical = rankAndAnnotateSearchPairs([
      normalizeDexScreenerPair({
        chainId: "pulsechain",
        dexId: "pulsex",
        url: "u",
        pairAddress: EUSDC_MAJOR_PAIR_ADDRESS,
        baseToken: {
          address: USDC_FROM_ETH_ADDRESS,
          name: "USD Coin from Ethereum",
          symbol: "USDC",
        },
        quoteToken: {
          address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
          name: "WPLS",
          symbol: "WPLS",
        },
        liquidity: { usd: 200_000 },
      })!,
    ]);
    const { catalog_coverage, recommended_address_followups } =
      buildCatalogSearchCoverage("USDC", withCanonical.pairs);
    expect(catalog_coverage!.canonical_missing_from_upstream).toBe(false);
    expect(recommended_address_followups).toHaveLength(0);
  });
});

describe("high-level search / pair / token pairs (shipped)", () => {
  const cfg = { httpTimeoutMs: 5_000 };

  it("searchDexScreenerPairs filters to pulsechain and returns structured data", async () => {
    const ethPair = { ...SAMPLE_PAIR, chainId: "ethereum", pairAddress: "0x3333333333333333333333333333333333333333" };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ pairs: [SAMPLE_PAIR, ethPair] }), {
          status: 200,
        }),
    );
    const result = await searchDexScreenerPairs(cfg, "PLSX", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      skipSpacing: true,
      pulsechainOnly: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chainId).toBe("pulsechain");
      expect(result.pulsechainOnly).toBe(true);
      expect(result.data.query).toBe("PLSX");
      expect(result.data.pairs).toHaveLength(1);
      expect(result.data.pairs[0]!.baseToken.symbol).toBe("PLSX");
      expect(result.data.discovery_only).toBe(true);
      expect(result.data.guidance).toBe(DEXSCREENER_SEARCH_GUIDANCE);
      expect(Array.isArray(result.data.symbol_collisions)).toBe(true);
    }
  });

  it("searchDexScreenerPairs ranks spoof behind catalog via full shipped path", async () => {
    const spoofPair = {
      chainId: "pulsechain",
      dexId: "pulsex",
      url: "https://dexscreener.com/pulsechain/spoof",
      pairAddress: "0xeC052d46D3115DF7F6058160Cd0b87b272201341",
      baseToken: {
        address: "0xf598cb1d27fb2c5c731f535ad6c1d0ec5efe1320",
        name: "DAI",
        symbol: "DAI",
      },
      quoteToken: {
        address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
        name: "Wrapped Pulse",
        symbol: "WPLS",
      },
      liquidity: { usd: 32_000 },
      priceUsd: "0.00019",
    };
    const knownPair = {
      chainId: "pulsechain",
      dexId: "pulsex",
      url: "https://dexscreener.com/pulsechain/known",
      pairAddress: "0xB2893ceA8080bF43b7b60B589EDaAb5211D98F23",
      baseToken: {
        address: BRIDGED_DAI_ADDRESS,
        name: "Dai Stablecoin from Ethereum",
        symbol: "DAI",
      },
      quoteToken: {
        address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
        name: "Wrapped Pulse",
        symbol: "WPLS",
      },
      liquidity: { usd: 100_000 },
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ pairs: [spoofPair, knownPair] }), {
          status: 200,
        }),
    );
    const result = await searchDexScreenerPairs(cfg, "DAI", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      skipSpacing: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pairs[0]!.baseToken.address.toLowerCase()).toBe(
        BRIDGED_DAI_ADDRESS.toLowerCase(),
      );
      expect(result.data.pairs[0]!.baseToken.origin?.is_bridged_dai).toBe(true);
      const spoof = result.data.pairs.find(
        (p) =>
          p.baseToken.address.toLowerCase() ===
          "0xf598cb1d27fb2c5c731f535ad6c1d0ec5efe1320",
      );
      expect(spoof).toBeDefined();
      expect(spoof!.baseToken.origin).toBeUndefined();
      expect(spoof!.search_flags?.ticker_spoof_risk).toBe("high");
      expect(result.data.symbol_collisions.some((c) => c.symbol === "DAI")).toBe(
        true,
      );
      // Canonical present → no missing-canonical follow-ups
      expect(result.data.catalog_coverage?.canonical_missing_from_upstream).toBe(
        false,
      );
      expect(result.data.recommended_address_followups).toBeUndefined();
    }
  });

  it("searchDexScreenerPairs surfaces missing bridged DAI when upstream is spoof-only", async () => {
    const spoofPair = {
      chainId: "pulsechain",
      dexId: "pulsex",
      url: "https://dexscreener.com/pulsechain/spoof",
      pairAddress: "0xeC052d46D3115DF7F6058160Cd0b87b272201341",
      baseToken: {
        address: "0xf598cb1d27fb2c5c731f535ad6c1d0ec5efe1320",
        name: "DAI",
        symbol: "DAI",
      },
      quoteToken: {
        address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
        name: "Wrapped Pulse",
        symbol: "WPLS",
      },
      liquidity: { usd: 32_000 },
      priceUsd: "0.00019",
    };
    // pDAI as quote only (fork present) but bridged still missing — live residual
    const pDaiQuotePair = {
      chainId: "pulsechain",
      dexId: "pulsex",
      url: "https://dexscreener.com/pulsechain/pdai-q",
      pairAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      baseToken: {
        address: "0xf598cb1d27fb2c5c731f535ad6c1d0ec5efe1320",
        name: "DAI",
        symbol: "DAI",
      },
      quoteToken: {
        address: FORK_DAI_ADDRESS,
        name: "Dai Stablecoin",
        symbol: "DAI",
      },
      liquidity: { usd: 50_000 },
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ pairs: [spoofPair, pDaiQuotePair] }), {
          status: 200,
        }),
    );
    const result = await searchDexScreenerPairs(cfg, "DAI", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      skipSpacing: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Still discovery pairs only — no invented bridged-DAI pair row
      expect(
        result.data.pairs.every(
          (p) =>
            p.baseToken.address.toLowerCase() !==
              BRIDGED_DAI_ADDRESS.toLowerCase() &&
            p.quoteToken.address.toLowerCase() !==
              BRIDGED_DAI_ADDRESS.toLowerCase(),
        ),
      ).toBe(true);
      expect(result.data.catalog_coverage?.canonical_missing_from_upstream).toBe(
        true,
      );
      expect(result.data.catalog_coverage?.spoof_dominated).toBe(true);
      expect(result.data.guidance).toMatch(
        /missing|omits|spoof-dominated|canonical|dexscreener_token_pairs/i,
      );
      expect(result.data.recommended_address_followups).toBeDefined();
      const bridgedFollow = result.data.recommended_address_followups!.find(
        (f) => f.address.toLowerCase() === BRIDGED_DAI_ADDRESS.toLowerCase(),
      );
      expect(bridgedFollow).toBeDefined();
      expect(bridgedFollow!.preferred_tool).toBe("dexscreener_token_pairs");
      expect(bridgedFollow!.display_name).toMatch(/bridged DAI/i);
    }
  });

  it("getDexScreenerTokenPairs does not attach search_flags (address path)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ pairs: [SAMPLE_DAI_PAIR] }), {
          status: 200,
        }),
    );
    const result = await getDexScreenerTokenPairs(cfg, BRIDGED_DAI_ADDRESS, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      skipSpacing: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pairs[0]!.baseToken.origin?.is_bridged_dai).toBe(true);
      expect(result.data.pairs[0]!.search_flags).toBeUndefined();
      // no discovery_only on address tools
      expect(
        (result.data as { discovery_only?: boolean }).discovery_only,
      ).toBeUndefined();
    }
  });

  it("search soft-fails on empty query without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await searchDexScreenerPairs(cfg, "  ", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      skipSpacing: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/empty/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("getDexScreenerPair builds pair URL and returns first pair", async () => {
    const fetchImpl = vi.fn(
      async (url: string) => {
        expect(String(url)).toContain("/latest/dex/pairs/pulsechain/");
        return new Response(JSON.stringify({ pairs: [SAMPLE_PAIR] }), {
          status: 200,
        });
      },
    );
    const result = await getDexScreenerPair(cfg, SAMPLE_PAIR.pairAddress, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      skipSpacing: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pair?.pairAddress).toBe(SAMPLE_PAIR.pairAddress);
    }
  });

  it("getDexScreenerTokenPairs rejects bad address soft", async () => {
    const result = await getDexScreenerTokenPairs(cfg, "not-an-address", {
      skipSpacing: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/0x/i);
  });

  it("getDexScreenerTokenPairs returns pools for token", async () => {
    const ehexPair = {
      ...SAMPLE_PAIR,
      baseToken: {
        address: EHEX_ADDRESS,
        name: "HEX from Ethereum",
        symbol: "eHEX",
      },
    };
    const fetchImpl = vi.fn(
      async (url: string) => {
        expect(String(url)).toContain(
          `/token-pairs/v1/pulsechain/${EHEX_ADDRESS}`,
        );
        return new Response(JSON.stringify([ehexPair]), { status: 200 });
      },
    );
    const result = await getDexScreenerTokenPairs(cfg, EHEX_ADDRESS, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      skipSpacing: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pairs[0]!.baseToken.origin?.is_ehex).toBe(true);
      expect(result.data.pairs[0]!.baseToken.origin?.token_origin).toBe(
        "bridged",
      );
    }
  });
});
