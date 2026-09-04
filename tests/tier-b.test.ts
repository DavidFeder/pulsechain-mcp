/**
 * Tier B: PulseX soft helpers + HEX stake resolve/decode — drives shipped functions.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDexDayDataSoft,
  getFactoryMetricsSoft,
  getLpEventsSoft,
  LP_MINTS_GLOBAL_QUERY,
  LP_BURNS_GLOBAL_QUERY,
} from "../src/data/subgraph.js";
import {
  resolveHexContract,
  getHexGlobalState,
  getHexStakesForAddress,
  HEX_STAKE_ABI,
  hexStakeSourceLabel,
} from "../src/data/hexStake.js";
import { EHEX_ADDRESS, HEX_ADDRESS } from "../src/constants.js";
import type { AppConfig } from "../src/types.js";
import { getRegisteredTools, resetToolRegistry } from "../src/tools/define.js";
import { registerAllTools } from "../src/tools/registry.js";
import { REGISTERED_TOOL_COUNT_RESEARCH_ONLY } from "./helpers/toolInventory.js";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetToolRegistry();
});

// ── HEX resolve (pure) ───────────────────────────────────────────────────

describe("resolveHexContract (shipped)", () => {
  it("labels pHEX as stakeable state-fork", () => {
    const r = resolveHexContract("phex");
    expect(r.address.toLowerCase()).toBe(HEX_ADDRESS.toLowerCase());
    expect(r.kind).toBe("phex");
    expect(r.supportsStaking).toBe(true);
    expect(r.label).toBe("pHEX");
    expect(r.note).toMatch(/state-fork|pHEX/i);
  });

  it("labels eHEX as bridged non-staking", () => {
    const r = resolveHexContract("ehex");
    expect(r.address.toLowerCase()).toBe(EHEX_ADDRESS.toLowerCase());
    expect(r.kind).toBe("ehex");
    expect(r.supportsStaking).toBe(false);
    expect(r.note).toMatch(/bridged|ERC-20|no stake/i);
  });

  it("maps known addresses to phex/ehex kinds", () => {
    expect(resolveHexContract(HEX_ADDRESS).kind).toBe("phex");
    expect(resolveHexContract(EHEX_ADDRESS).kind).toBe("ehex");
  });

  it("hex alias maps to phex", () => {
    expect(resolveHexContract("hex").kind).toBe("phex");
  });

  it("source label is hex-rpc", () => {
    expect(hexStakeSourceLabel()).toBe("hex-rpc");
  });

  it("HEX_STAKE_ABI includes stake views", () => {
    const names = HEX_STAKE_ABI.map((x) =>
      "name" in x ? String(x.name) : "",
    );
    expect(names).toContain("currentDay");
    expect(names).toContain("globals");
    expect(names).toContain("stakeCount");
    expect(names).toContain("stakeLists");
  });
});

describe("getHexGlobalState / getHexStakesForAddress soft paths", () => {
  it("eHEX global soft-fails without RPC", async () => {
    const r = await getHexGlobalState(baseConfig, "ehex");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.source).toBe("hex-rpc");
      expect(r.reason).toMatch(/bridged|ERC-20|stake/i);
      expect(r.contract?.kind).toBe("ehex");
    }
  });

  it("eHEX stakes soft-fail without RPC", async () => {
    const r = await getHexStakesForAddress(
      baseConfig,
      "0x0000000000000000000000000000000000000001",
      { contract: "ehex" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.source).toBe("hex-rpc");
      expect(r.contract?.supportsStaking).toBe(false);
    }
  });

  it("invalid staker soft-fails", async () => {
    const r = await getHexStakesForAddress(baseConfig, "not-an-address");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/staker|address/i);
  });

  it("pHEX global soft-fails on RPC error (mocked fetch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    // Force fresh multi-rpc client path
    const { resetRpcClient } = await import("../src/data/rpc.js");
    resetRpcClient();
    const r = await getHexGlobalState(baseConfig, "phex");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.source).toBe("hex-rpc");
      expect(r.contract?.kind).toBe("phex");
    }
    resetRpcClient();
  });
});

// ── PulseX soft helpers ──────────────────────────────────────────────────

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

function gqlErrors(message: string) {
  const payload = JSON.stringify({ errors: [{ message }] });
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => payload,
    json: async () => ({ errors: [{ message }] }),
  };
}

describe("PulseX soft helpers (shipped)", () => {
  it("LP query documents include mints/burns fields", () => {
    expect(String(LP_MINTS_GLOBAL_QUERY)).toMatch(/mints/);
    expect(String(LP_BURNS_GLOBAL_QUERY)).toMatch(/burns/);
    expect(String(LP_MINTS_GLOBAL_QUERY)).toMatch(/amountUSD/);
  });

  it("getFactoryMetricsSoft success path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gqlResponse({
          pulseXFactories: [
            {
              id: "0xfactory",
              totalPairs: "10",
              totalTransactions: "100",
              totalVolumeUSD: "1",
              totalVolumePLS: "2",
              untrackedVolumeUSD: "0",
              totalLiquidityUSD: "3",
              totalLiquidityPLS: "4",
            },
          ],
        }),
      ),
    );
    const r = await getFactoryMetricsSoft(baseConfig, "v2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("pulsex-subgraph");
      expect(r.data.factory?.id).toBe("0xfactory");
      expect(r.data.note).toMatch(/pulseXFactories/i);
    }
  });

  it("getFactoryMetricsSoft soft-fails on GraphQL errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gqlErrors("boom")),
    );
    const r = await getFactoryMetricsSoft(baseConfig, "v2");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.source).toBe("pulsex-subgraph");
      expect(r.reason).toBeTruthy();
    }
  });

  it("getDexDayDataSoft maps day rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gqlResponse({
          pulsexDayDatas: [
            {
              id: "1",
              date: 1000,
              dailyVolumeUSD: "10",
              dailyVolumePLS: "20",
              totalLiquidityUSD: "30",
              totalLiquidityPLS: "40",
              totalVolumeUSD: "50",
              totalTransactions: "60",
            },
          ],
        }),
      ),
    );
    const r = await getDexDayDataSoft(baseConfig, 7, "v2");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.count).toBe(1);
      expect(r.data.days[0]?.dailyVolumeUSD).toBe("10");
    }
  });

  it("getLpEventsSoft merges mints and burns", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        const isMint = call === 1;
        return gqlResponse(
          isMint
            ? {
                mints: [
                  {
                    id: "m1",
                    timestamp: "200",
                    amountUSD: "1",
                    pair: {
                      id: "0xpair",
                      token0: { symbol: "A" },
                      token1: { symbol: "B" },
                    },
                  },
                ],
              }
            : {
                burns: [
                  {
                    id: "b1",
                    timestamp: "100",
                    amountUSD: "2",
                    pair: {
                      id: "0xpair",
                      token0: { symbol: "A" },
                      token1: { symbol: "B" },
                    },
                  },
                ],
              },
        );
      }),
    );
    const r = await getLpEventsSoft(baseConfig, {
      first: 5,
      minUsd: 0,
      version: "v2",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source).toBe("pulsex-subgraph");
      expect(r.data.mintCount).toBe(1);
      expect(r.data.burnCount).toBe(1);
      expect(r.data.events[0]?.kind).toBe("mint"); // higher timestamp first
      expect(r.data.note).toMatch(/mint\/burn/i);
    }
  });

  it("getLpEventsSoft soft-fails on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("subgraph down");
      }),
    );
    const r = await getLpEventsSoft(baseConfig, { first: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/subgraph down|PulseX|fetch|network/i);
  });
});

// ── Registration ─────────────────────────────────────────────────────────

describe("Tier B tool registration", () => {
  it("registers five Tier B tools", () => {
    const names: string[] = [];
    const server = {
      registerTool: (name: string) => {
        names.push(name);
      },
    };
    resetToolRegistry();
    registerAllTools(server as never, baseConfig);
    const meta = getRegisteredTools();
    const tierB = [
      "pulsex_factory",
      "pulsex_dex_day_data",
      "pulsex_lp_events",
      "hex_global_state",
      "hex_stakes_for_address",
    ];
    for (const n of tierB) {
      expect(names).toContain(n);
      expect(meta.some((t) => t.name === n && t.category === "analytics")).toBe(
        true,
      );
    }
    expect(meta.length).toBe(REGISTERED_TOOL_COUNT_RESEARCH_ONLY);
  });
});
