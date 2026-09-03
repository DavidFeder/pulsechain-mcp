/**
 * Dual-DAI / fork-vs-bridged labeling — drives shipped constants + resolve path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import {
  BRIDGED_DAI_ADDRESS,
  BRIDGED_DAI_IDENTITY,
  BRIDGED_DAI_WARNING,
  CORE_TOKENS,
  DAI_ADDRESS,
  DUAL_DAI_GUIDANCE,
  FORK_DAI_ADDRESS,
  FORK_DAI_IDENTITY,
  FORK_DAI_WARNING,
  PDAI_ADDRESS,
  getTokenIdentityLabel,
  resolveCoreToken,
  tokenLabelFields,
} from "../src/constants.js";
import { resolveTokenAddress } from "../src/tools/chain/operations.js";
import { knownCoreToken } from "../src/data/multicall.js";

describe("canonical dual-DAI registry (shipped constants)", () => {
  it("bridged DAI constant is valid EIP-55 (viem getAddress)", () => {
    // Live P0: bad checksum …bfCe… caused balance_read_failed on strict clients
    expect(BRIDGED_DAI_ADDRESS).toBe(getAddress(BRIDGED_DAI_ADDRESS));
    expect(DAI_ADDRESS).toBe(getAddress(DAI_ADDRESS));
    expect(BRIDGED_DAI_ADDRESS).toBe(
      "0xefD766cCb38EaF1dfd701853BFCe31359239F305",
    );
    // Same 20-byte address as pre-fix (only casing differs)
    expect(BRIDGED_DAI_ADDRESS.toLowerCase()).toBe(
      "0xefd766ccb38eaf1dfd701853bfce31359239f305",
    );
    expect(FORK_DAI_ADDRESS).toBe(getAddress(FORK_DAI_ADDRESS));
  });

  it("symbol DAI resolves only to bridged real stable", () => {
    const dai = resolveCoreToken("DAI");
    expect(dai).toBeDefined();
    expect(dai!.address.toLowerCase()).toBe(BRIDGED_DAI_ADDRESS.toLowerCase());
    expect(dai!.address.toLowerCase()).toBe(DAI_ADDRESS.toLowerCase());
    expect(dai!.isRealStablecoin).toBe(true);
    expect(dai!.origin).toBe("bridged");
    expect(dai!.warning).toMatch(/bridged DAI|real stablecoin/i);
    // Must NOT be the fork address
    expect(dai!.address.toLowerCase()).not.toBe(FORK_DAI_ADDRESS.toLowerCase());
  });

  it("PDAI / FORK_DAI resolve to forked pDAI only", () => {
    for (const sym of ["PDAI", "FORK_DAI", "FORKED_DAI", "pdai"]) {
      const t = resolveCoreToken(sym);
      expect(t?.address.toLowerCase()).toBe(FORK_DAI_ADDRESS.toLowerCase());
      expect(t?.isRealStablecoin).toBe(false);
      expect(t?.origin).toBe("state_fork");
      expect(t?.displaySymbol).toBe("pDAI");
    }
  });

  it("CORE_TOKENS.DAI is bridged; fork is not a default core portfolio key", () => {
    expect(CORE_TOKENS.DAI!.address.toLowerCase()).toBe(
      BRIDGED_DAI_ADDRESS.toLowerCase(),
    );
    expect(
      Object.values(CORE_TOKENS).some(
        (t) => t.address.toLowerCase() === FORK_DAI_ADDRESS.toLowerCase(),
      ),
    ).toBe(false);
  });

  it("PDAI_ADDRESS aliases FORK_DAI_ADDRESS", () => {
    expect(PDAI_ADDRESS.toLowerCase()).toBe(FORK_DAI_ADDRESS.toLowerCase());
  });
});

describe("getTokenIdentityLabel / tokenLabelFields (shipped)", () => {
  it("labels bridged DAI as real stable with bridge URL", () => {
    const label = getTokenIdentityLabel(BRIDGED_DAI_ADDRESS);
    expect(label).not.toBeNull();
    expect(label!.isBridgedDai).toBe(true);
    expect(label!.isForkDai).toBe(false);
    expect(label!.isRealStablecoin).toBe(true);
    expect(label!.origin).toBe("bridged");
    expect(label!.identityNote).toBe(BRIDGED_DAI_IDENTITY);
    expect(label!.warning).toBe(BRIDGED_DAI_WARNING);

    const fields = tokenLabelFields(BRIDGED_DAI_ADDRESS)!;
    expect(fields.is_bridged_dai).toBe(true);
    expect(fields.is_real_stablecoin).toBe(true);
    expect(fields.bridge_url).toBe("https://bridge.pulsechain.com");
    expect(fields.fork_dai_address).toBe(FORK_DAI_ADDRESS);
    expect(String(fields.warning)).toMatch(/bridged DAI|real stablecoin/i);
    expect(fields.do_not_treat_as_usd_stable).toBeUndefined();
  });

  it("labels forked pDAI as NOT dollar-stable with warning", () => {
    const label = getTokenIdentityLabel(FORK_DAI_ADDRESS);
    expect(label).not.toBeNull();
    expect(label!.isForkDai).toBe(true);
    expect(label!.isBridgedDai).toBe(false);
    expect(label!.isRealStablecoin).toBe(false);
    expect(label!.origin).toBe("state_fork");
    expect(label!.displaySymbol).toBe("pDAI");
    expect(label!.identityNote).toBe(FORK_DAI_IDENTITY);
    expect(label!.warning).toBe(FORK_DAI_WARNING);
    expect(label!.warning).toMatch(/NOT the bridged stable|forked from Ethereum/i);

    const fields = tokenLabelFields(FORK_DAI_ADDRESS)!;
    expect(fields.is_fork_dai).toBe(true);
    expect(fields.is_pdai).toBe(true);
    expect(fields.do_not_treat_as_usd_stable).toBe(true);
    expect(fields.is_real_stablecoin).toBe(false);
    expect(fields.bridged_dai_address).toBe(BRIDGED_DAI_ADDRESS);
    expect(String(fields.identity_note)).toMatch(/not dollar-stable|pDAI|fork/i);
  });

  it("returns null for unknown address", () => {
    expect(
      getTokenIdentityLabel("0x0000000000000000000000000000000000000001"),
    ).toBeNull();
    expect(
      tokenLabelFields("0x0000000000000000000000000000000000000001"),
    ).toBeNull();
  });
});

describe("resolveTokenAddress shipped path", () => {
  it("DAI symbol → bridged address", () => {
    expect(resolveTokenAddress("DAI").toLowerCase()).toBe(
      BRIDGED_DAI_ADDRESS.toLowerCase(),
    );
    expect(resolveTokenAddress("dai").toLowerCase()).toBe(
      BRIDGED_DAI_ADDRESS.toLowerCase(),
    );
  });

  it("PDAI symbol → fork address (not bridged)", () => {
    expect(resolveTokenAddress("PDAI").toLowerCase()).toBe(
      FORK_DAI_ADDRESS.toLowerCase(),
    );
    expect(resolveTokenAddress("FORK_DAI").toLowerCase()).toBe(
      FORK_DAI_ADDRESS.toLowerCase(),
    );
  });

  it("accepts either DAI address literally", () => {
    expect(resolveTokenAddress(BRIDGED_DAI_ADDRESS).toLowerCase()).toBe(
      BRIDGED_DAI_ADDRESS.toLowerCase(),
    );
    expect(resolveTokenAddress(FORK_DAI_ADDRESS).toLowerCase()).toBe(
      FORK_DAI_ADDRESS.toLowerCase(),
    );
  });
});

describe("knownCoreToken includes fork DAI for metadata", () => {
  it("knows both DAI addresses", () => {
    expect(knownCoreToken(BRIDGED_DAI_ADDRESS)?.isRealStablecoin).toBe(true);
    expect(knownCoreToken(FORK_DAI_ADDRESS)?.isRealStablecoin).toBe(false);
    expect(knownCoreToken(FORK_DAI_ADDRESS)?.displaySymbol).toBe("pDAI");
  });
});

describe("DUAL_DAI_GUIDANCE payload", () => {
  it("teaches bridge URL, both addresses, and agent rules", () => {
    expect(DUAL_DAI_GUIDANCE.bridgedDai.address).toBe(BRIDGED_DAI_ADDRESS);
    expect(DUAL_DAI_GUIDANCE.forkedDai.address).toBe(FORK_DAI_ADDRESS);
    expect(DUAL_DAI_GUIDANCE.bridgedDai.bridge).toMatch(/bridge\.pulsechain\.com/);
    expect(DUAL_DAI_GUIDANCE.rulesForAgents.length).toBeGreaterThanOrEqual(3);
    expect(
      DUAL_DAI_GUIDANCE.rulesForAgents.some((r) =>
        /address|symbol alone/i.test(r),
      ),
    ).toBe(true);
    expect(DUAL_DAI_GUIDANCE.standardNote).toMatch(/PRC-20/);
  });
});

describe("portfolio-facing assembleTokenBalance dual-DAI labels (shipped path)", () => {
  it("attaches bridged DAI identity on balance rows", async () => {
    const { assembleTokenBalance } = await import("../src/data/multicall.js");
    const owner = "0x0000000000000000000000000000000000000001" as const;
    const bal = assembleTokenBalance({
      token: BRIDGED_DAI_ADDRESS as `0x${string}`,
      owner,
      balanceRaw: "1000000000000000000",
      balanceOk: true,
    });
    expect(bal.balanceOk).toBe(true);
    expect((bal as { is_bridged_dai?: boolean }).is_bridged_dai).toBe(true);
    expect((bal as { is_real_stablecoin?: boolean }).is_real_stablecoin).toBe(
      true,
    );
    expect(String((bal as { warning?: string }).warning)).toMatch(
      /bridged DAI|real stablecoin/i,
    );
    expect((bal as { do_not_treat_as_usd_stable?: boolean }).do_not_treat_as_usd_stable).toBeUndefined();
  });

  it("attaches forked pDAI do-not-treat-as-stable on balance rows", async () => {
    const { assembleTokenBalance } = await import("../src/data/multicall.js");
    const owner = "0x0000000000000000000000000000000000000001" as const;
    const bal = assembleTokenBalance({
      token: FORK_DAI_ADDRESS as `0x${string}`,
      owner,
      balanceRaw: "0",
      balanceOk: true,
    });
    expect(bal.balanceOk).toBe(true);
    expect((bal as { is_fork_dai?: boolean }).is_fork_dai).toBe(true);
    expect((bal as { is_pdai?: boolean }).is_pdai).toBe(true);
    expect((bal as { do_not_treat_as_usd_stable?: boolean }).do_not_treat_as_usd_stable).toBe(
      true,
    );
    expect(String((bal as { identity_note?: string }).identity_note)).toMatch(
      /not dollar-stable|pDAI|fork/i,
    );
  });
});

describe("free-tier get_token_price dual-DAI labels (shipped handler)", () => {
  const baseConfig = {
    rpcUrl: "https://rpc.pulsechain.com",
    rpcUrls: ["https://rpc.pulsechain.com"],
    network: "mainnet" as const,
    explorerApi: "https://api.scan.pulsechain.com/api",
    pulseXSubgraphV1: "https://graph.example.test/v1",
    pulseXSubgraphV2: "https://graph.example.test/v2",
    agentWalletEnabled: false,
    agentWalletMasterKey: undefined,
    agentWalletDir: "./data/wallets",
    agentWalletMultiprocStrict: false,
    agentWalletEnforceLegacyCaps: false,
    maxPlsPerTx: 100,
    maxPlsDaily: 1000,
    httpTransportPort: undefined,
    logLevel: "error" as const,
    httpTimeoutMs: 5_000,
  };

  function captureHandlers() {
    const handlers = new Map<
      string,
      (args?: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>
    >();
    return {
      handlers,
      server: {
        registerTool: (name: unknown, ...rest: unknown[]) => {
          const cb = rest[rest.length - 1];
          if (typeof name === "string" && typeof cb === "function") {
            handlers.set(name, cb as (args?: Record<string, unknown>) => Promise<{
              content: Array<{ type: string; text: string }>;
              isError?: boolean;
            }>);
          }
        },
      },
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("labels bridged DAI as real stable and forked pDAI as not dollar-stable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes("example.test")) {
          return {
            ok: false,
            status: 404,
            headers: new Headers(),
            json: async () => ({}),
            text: async () => "",
          };
        }
        const body =
          typeof init?.body === "string"
            ? init.body
            : init?.body
              ? String(init.body)
              : "";
        // Return token keyed by address in query if present
        const isFork =
          body.toLowerCase().includes(FORK_DAI_ADDRESS.toLowerCase().slice(2));
        const addr = isFork
          ? FORK_DAI_ADDRESS.toLowerCase()
          : BRIDGED_DAI_ADDRESS.toLowerCase();
        const symbol = isFork ? "DAI" : "DAI";
        const payload = {
          data: {
            token: {
              id: addr,
              symbol,
              name: isFork ? "Dai Stablecoin" : "Dai Stablecoin from Ethereum",
              decimals: "18",
              totalSupply: "1000",
              tradeVolume: "0",
              tradeVolumeUSD: "100",
              untrackedVolumeUSD: "0",
              totalTransactions: "1",
              totalLiquidity: "100",
              derivedPLS: "1",
              derivedUSD: isFork ? "0.0004" : "1.0",
            },
            tokenDayDatas: [],
            bundle: { id: "1", plsPrice: "0.00003" },
          },
        };
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        };
      }),
    );

    const { handlers, server } = captureHandlers();
    const { registerFreeTierAnalyticsTools } = await import(
      "../src/tools/analytics/freeTier.js"
    );
    const { resetToolRegistry } = await import("../src/tools/define.js");
    resetToolRegistry();
    registerFreeTierAnalyticsTools(server as never, baseConfig);

    const price = handlers.get("get_token_price")!;
    const bridgedRes = await price({
      address: BRIDGED_DAI_ADDRESS,
      version: "v2",
    });
    const bridged = JSON.parse(bridgedRes.content[0]!.text) as {
      ok: boolean;
      data?: Record<string, unknown>;
    };
    expect(bridged.ok).toBe(true);
    expect(bridged.data?.is_bridged_dai).toBe(true);
    expect(bridged.data?.is_real_stablecoin).toBe(true);
    expect(bridged.data?.do_not_treat_as_usd_stable).toBeUndefined();

    const forkRes = await price({
      address: FORK_DAI_ADDRESS,
      version: "v2",
    });
    const fork = JSON.parse(forkRes.content[0]!.text) as {
      ok: boolean;
      data?: Record<string, unknown>;
    };
    expect(fork.ok).toBe(true);
    expect(fork.data?.is_fork_dai).toBe(true);
    expect(fork.data?.do_not_treat_as_usd_stable).toBe(true);
    expect(fork.data?.confidence).toBe("low");
    expect(String(fork.data?.price_note ?? "")).toMatch(/NOT a claim of dollar|bridged DAI/i);
  });
});
