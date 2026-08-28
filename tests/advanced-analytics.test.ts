import { describe, expect, it, vi, afterEach } from "vitest";
import {
  computeAddressAge,
  computeHolderRank,
  detectScamAlerts,
  inferFirstFunder,
  scoreAddressRisk,
  weiToPls,
} from "../src/tools/analytics/advanced-helpers.js";
import {
  fetchLargeSwaps,
  fetchWalletSwaps,
  SWAPS_MIN_USD_QUERY,
} from "../src/data/subgraph.js";
import {
  getContractCreation,
  getTokenHoldersModule,
} from "../src/data/explorer.js";
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
  maxPlsPerTx: 100,
  maxPlsDaily: 1000,
  httpTransportPort: undefined,
  logLevel: "info",
  httpTimeoutMs: 5000,
};

const ADDR_A = "0x1111111111111111111111111111111111111111";
const ADDR_B = "0x2222222222222222222222222222222222222222";
const ADDR_C = "0x3333333333333333333333333333333333333333";

describe("advanced-helpers pure risk/scam", () => {
  it("computeAddressAge marks young wallets", () => {
    const now = 1_700_000_000;
    const age = computeAddressAge(now - 2 * 86_400, now);
    expect(age.young).toBe(true);
    expect(age.ageDays).toBeCloseTo(2, 1);
  });

  it("inferFirstFunder finds earliest inbound native transfer", () => {
    const first = inferFirstFunder(ADDR_A, [
      {
        from: ADDR_B,
        to: ADDR_A,
        value: "1000000000000000000",
        hash: "0xabc",
        timeStamp: "100",
      },
      {
        from: ADDR_A,
        to: ADDR_C,
        value: "1",
        hash: "0xdef",
        timeStamp: "200",
      },
    ]);
    expect(first.funder).toBe(ADDR_B.toLowerCase());
    expect(first.valueWei).toBe("1000000000000000000");
  });

  it("scoreAddressRisk elevates young multi-deployers", () => {
    const now = 1_700_000_000;
    const scored = scoreAddressRisk({
      address: ADDR_A,
      earliestTxTs: now - 86_400,
      txCountSample: 30,
      failedTxCount: 0,
      uniqueFunders: [ADDR_B],
      firstFunder: ADDR_B,
      contractCreations: 6,
      nowSec: now,
    });
    expect(scored.riskScore).toBeGreaterThanOrEqual(45);
    expect(["high", "critical"]).toContain(scored.riskLevel);
    expect(scored.signals.some((s) => s.id === "burst_deployer")).toBe(true);
    expect(scored.method).toContain("Public heuristics");
  });

  it("scoreAddressRisk is low for known core addresses", () => {
    const scored = scoreAddressRisk({
      address: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27", // WPLS
      earliestTxTs: undefined,
      txCountSample: 0,
      failedTxCount: 0,
      uniqueFunders: [],
      firstFunder: null,
      contractCreations: 0,
    });
    expect(scored.riskLevel).toBe("low");
    expect(scored.riskScore).toBe(0);
  });

  it("detectScamAlerts flags volume>>liquidity young pairs and LP burns", () => {
    const now = 1_700_000_000;
    const { alerts, method } = detectScamAlerts({
      nowSec: now,
      pairs: [
        {
          id: "0xpair1",
          timestamp: String(now - 86_400),
          reserveUSD: "1000",
          volumeUSD: "50000",
          totalTransactions: "200",
          token0: { id: ADDR_A, symbol: "SCAM" },
          token1: {
            id: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
            symbol: "WPLS",
          },
        },
      ],
      burns: [
        {
          id: "burn1",
          amountUSD: "8000",
          pair: {
            id: "0xpair2",
            reserveUSD: "500",
            token0: { symbol: "X" },
            token1: { symbol: "Y" },
          },
          transaction: { id: "0xtx" },
        },
      ],
    });
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    expect(alerts.some((a) => a.type === "high_volume_low_liquidity_young_pair")).toBe(
      true,
    );
    expect(alerts.some((a) => a.type === "liquidity_pull_signal")).toBe(true);
    expect(method).toContain("PulseX subgraph");
  });

  it("detectScamAlerts uses sanitized liquidity so absurd reserveUSD cannot suppress alerts", () => {
    const now = 1_700_000_000;
    // Raw 1e40 reserve would make volume/liquidity ~0 and silence the signal;
    // sanitation demotes it so the young high-volume pair still alerts.
    const { alerts } = detectScamAlerts({
      nowSec: now,
      pairs: [
        {
          id: "0xpolluted",
          timestamp: String(now - 86_400),
          reserveUSD: "1e40",
          volumeUSD: "50000",
          totalTransactions: "200",
          token0: { id: ADDR_A, symbol: "SCAM" },
          token1: {
            id: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
            symbol: "WPLS",
          },
        },
      ],
      burns: [],
    });
    expect(alerts.length).toBeGreaterThan(0);
    const volAlert = alerts.find(
      (a) => a.type === "high_volume_low_liquidity_young_pair",
    );
    expect(volAlert, `alerts=${JSON.stringify(alerts)}`).toBeTruthy();
    const evidence = volAlert!.evidence as Record<string, unknown>;
    expect(Number(evidence.rawReserveUSD)).toBeGreaterThan(1e20);
    expect(Number(evidence.reserveUSD)).toBeLessThan(100);
    expect(evidence.liquiditySource).toBe("demoted");
    expect(evidence.liquidityPolluted).toBe(true);
  });

  it("computeHolderRank ranks addresses on page", () => {
    const holders = [
      { address: ADDR_B, value: "5000" },
      { address: ADDR_A, value: "3000" },
      { address: ADDR_C, value: "1000" },
    ];
    const rank = computeHolderRank(holders, ADDR_A, {
      page: 1,
      offset: 50,
      totalSupply: "10000",
    });
    expect(rank.found).toBe(true);
    expect(rank.rank).toBe(2);
    expect(rank.shareOfSupplyPct).toBe(30);
    expect(rank.confidence).toBe("medium");
  });

  it("computeHolderRank not-found has low confidence caveats", () => {
    const rank = computeHolderRank([{ address: ADDR_B, value: "1" }], ADDR_A, {
      page: 1,
      offset: 50,
    });
    expect(rank.found).toBe(false);
    expect(rank.rank).toBeNull();
    expect(rank.caveats.length).toBeGreaterThan(0);
  });

  it("weiToPls formats wei", () => {
    expect(weiToPls("1000000000000000000")).toBe("1");
    expect(weiToPls(null)).toBeNull();
  });
});

describe("subgraph advanced fetchers (mocked)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function gqlResponse(data: unknown) {
    const payload = JSON.stringify({ data });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => payload,
      json: async () => ({ data }),
    };
  }

  it("fetchLargeSwaps posts minUsd filter", async () => {
    const fetchMock = vi.fn(async () =>
      gqlResponse({
        swaps: [
          {
            id: "1",
            timestamp: "100",
            amountUSD: "25000",
            sender: ADDR_A,
            to: ADDR_B,
            pair: {
              id: "0xpair",
              token0: { symbol: "WPLS" },
              token1: { symbol: "HEX" },
            },
            transaction: { id: "0xtx" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchLargeSwaps(baseConfig, {
      minUsd: 10_000,
      first: 10,
    });
    expect(result.swaps).toHaveLength(1);
    expect(result.swaps[0]?.amountUSD).toBe("25000");

    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body?: string })?.body ?? "{}",
    );
    expect(body.variables.minUsd).toBe("10000");
    expect(String(body.query ?? SWAPS_MIN_USD_QUERY)).toContain("amountUSD_gt");
  });

  it("fetchWalletSwaps merges sender and to sides", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gqlResponse({
          asSender: [
            {
              id: "s1",
              timestamp: "200",
              amountUSD: "10",
              sender: ADDR_A,
              to: ADDR_B,
            },
          ],
          asTo: [
            {
              id: "s2",
              timestamp: "300",
              amountUSD: "20",
              sender: ADDR_B,
              to: ADDR_A,
            },
            {
              id: "s1",
              timestamp: "200",
              amountUSD: "10",
              sender: ADDR_A,
              to: ADDR_B,
            },
          ],
        }),
      ),
    );

    const result = await fetchWalletSwaps(baseConfig, ADDR_A, { first: 10 });
    expect(result.swaps).toHaveLength(2);
    expect(result.swaps[0]?.id).toBe("s2"); // newest first
    expect(result.method).toContain("sender or to");
  });

  it("fetchWalletSwaps deep skip is passed to subgraph instead of emptying the page", async () => {
    const fetchMock = vi.fn(async () =>
      gqlResponse({
        asSender: [{ id: "deep-s", timestamp: "1", sender: ADDR_A, to: ADDR_B }],
        asTo: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWalletSwaps(baseConfig, ADDR_A, {
      first: 25,
      skip: 100,
    });
    expect(result.swaps).toHaveLength(1);
    expect(result.method).toMatch(/deep skip/i);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body?: string })?.body ?? "{}",
    );
    expect(body.variables.skip).toBe(100);
    expect(body.variables.first).toBe(25);
  });
});

describe("explorer advanced helpers (mocked)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getContractCreation calls module contract getcontractcreation", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "1",
        message: "OK",
        result: [
          {
            contractAddress: ADDR_A,
            contractCreator: ADDR_B,
            txHash: "0xdead",
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getContractCreation(baseConfig, ADDR_A);
    expect(Array.isArray(result)).toBe(true);
    expect((result as { contractCreator: string }[])[0]?.contractCreator).toBe(
      ADDR_B,
    );
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("module=contract");
    expect(url).toContain("action=getcontractcreation");
  });

  it("getTokenHoldersModule returns holder rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "1",
          message: "OK",
          result: [
            { address: ADDR_B, value: "100" },
            { address: ADDR_A, value: "50" },
          ],
        }),
      })),
    );

    const result = await getTokenHoldersModule(baseConfig, ADDR_C, 1, 50);
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(2);
  });
});
