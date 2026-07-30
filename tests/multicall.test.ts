import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assembleTokenBalance,
  countNonZeroSuccessfulBalances,
  encodeBalanceOf,
  encodeDecimals,
  encodeName,
  encodeSymbol,
  knownCoreToken,
  mergeErc20Metadata,
  packErc20BalanceCalls,
  packErc20MetadataCalls,
} from "../src/data/multicall.js";
import {
  HEX_ADDRESS,
  WPLS_ADDRESS,
  USDC_FROM_ETH_ADDRESS,
} from "../src/constants.js";
import type { AppConfig } from "../src/types.js";

const OWNER = "0x0000000000000000000000000000000000000001" as const;
const TOKEN = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27" as const;

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

describe("multicall packing", () => {
  it("encodes balanceOf with owner arg", () => {
    const data = encodeBalanceOf(OWNER);
    // balanceOf(address) selector 0x70a08231
    expect(data.startsWith("0x70a08231")).toBe(true);
    expect(data.length).toBe(2 + 8 + 64); // selector + padded address
    expect(data.endsWith(OWNER.slice(2).toLowerCase())).toBe(true);
  });

  it("encodes decimals/symbol/name selectors", () => {
    expect(encodeDecimals()).toBe("0x313ce567");
    expect(encodeSymbol()).toBe("0x95d89b41");
    expect(encodeName()).toBe("0x06fdde03");
  });

  it("packs balance calls for multiple tokens", () => {
    const tokens = [TOKEN, "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39" as const];
    const calls = packErc20BalanceCalls(tokens, OWNER);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.functionName).toBe("balanceOf");
    expect(calls[0]?.address).toBe(TOKEN);
    expect(calls[0]?.args).toEqual([OWNER]);
  });

  it("packs metadata as name/symbol/decimals trio", () => {
    const calls = packErc20MetadataCalls(TOKEN);
    expect(calls.map((c) => c.functionName)).toEqual([
      "name",
      "symbol",
      "decimals",
    ]);
    expect(calls.every((c) => c.address === TOKEN)).toBe(true);
  });
});

describe("core registry + assembleTokenBalance (portfolio path)", () => {
  it("knows WPLS/HEX/USDC from CORE_TOKENS", () => {
    expect(knownCoreToken(WPLS_ADDRESS)?.decimals).toBe(18);
    expect(knownCoreToken(HEX_ADDRESS)?.decimals).toBe(8);
    expect(knownCoreToken(HEX_ADDRESS)?.symbol).toBe("HEX");
    expect(knownCoreToken(USDC_FROM_ETH_ADDRESS)?.decimals).toBe(6);
    expect(knownCoreToken("0x0000000000000000000000000000000000000001")).toBeUndefined();
  });

  it("mergeErc20Metadata prefers on-chain decimals when present", () => {
    const m = mergeErc20Metadata(HEX_ADDRESS, {
      name: "HEX",
      symbol: "HEX",
      decimals: 8,
    });
    expect(m.decimals).toBe(8);
    expect(m.metadataSource).toBe("rpc");
  });

  it("mergeErc20Metadata falls back to HEX=8 (not 18) when on-chain missing", () => {
    const m = mergeErc20Metadata(HEX_ADDRESS, {});
    expect(m.decimals).toBe(8);
    expect(m.symbol).toBe("HEX");
    expect(m.metadataSource).toBe("core_registry");
  });

  it("assembleTokenBalance preserves non-zero balanceRaw and formats with HEX decimals", () => {
    // 1.5 HEX in base units (8 decimals)
    const raw = "150000000";
    const bal = assembleTokenBalance({
      token: HEX_ADDRESS,
      owner: OWNER,
      balanceRaw: raw,
      balanceOk: true,
      // simulate failed metadata → would have defaulted to 18 before fix
    });
    expect(bal.balanceRaw).toBe(raw);
    expect(bal.decimals).toBe(8);
    expect(bal.balanceFormatted).toBe("1.5");
    expect(bal.symbol).toBe("HEX");
  });

  it("assembleTokenBalance zeros only when balanceOk is false", () => {
    const bal = assembleTokenBalance({
      token: WPLS_ADDRESS,
      owner: OWNER,
      balanceRaw: "999",
      balanceOk: false,
    });
    expect(bal.balanceRaw).toBe("0");
    expect(bal.decimals).toBe(18);
    expect(bal.symbol).toBe("WPLS");
    expect(bal.balanceOk).toBe(false);
    expect(bal.balanceError).toBe("balance_read_failed");
  });

  it("failed balance read is distinguishable from successful zero holding", () => {
    const failed = assembleTokenBalance({
      token: WPLS_ADDRESS,
      owner: OWNER,
      balanceRaw: null,
      balanceOk: false,
    });
    const trueZero = assembleTokenBalance({
      token: WPLS_ADDRESS,
      owner: OWNER,
      balanceRaw: "0",
      balanceOk: true,
    });
    // Both surface balanceRaw "0" as the safe numeric field
    expect(failed.balanceRaw).toBe("0");
    expect(trueZero.balanceRaw).toBe("0");
    // Explicit signal separates RPC failure from confirmed empty wallet
    expect(failed.balanceOk).toBe(false);
    expect(failed.balanceError).toBe("balance_read_failed");
    expect(trueZero.balanceOk).toBe(true);
    expect(trueZero.balanceError).toBeUndefined();
  });

  it("assembleTokenBalance keeps successful WPLS holdings", () => {
    const raw = "104417099522848420979364";
    const bal = assembleTokenBalance({
      token: WPLS_ADDRESS,
      owner: OWNER,
      balanceRaw: raw,
      balanceOk: true,
      name: "Wrapped Pulse",
      symbol: "WPLS",
      decimals: 18,
    });
    expect(bal.balanceRaw).toBe(raw);
    expect(bal.decimals).toBe(18);
    expect(Number(bal.balanceFormatted)).toBeGreaterThan(0);
    expect(bal.balanceOk).toBe(true);
    expect(bal.balanceError).toBeUndefined();
  });

  it("countNonZeroSuccessfulBalances ignores failed reads and true zeros", () => {
    expect(
      countNonZeroSuccessfulBalances([
        { balanceRaw: "100", balanceOk: true },
        { balanceRaw: "0", balanceOk: true },
        { balanceRaw: "999", balanceOk: false },
        { balanceRaw: "0", balanceOk: false },
        { balanceRaw: "50" }, // balanceOk undefined → treat as success
      ]),
    ).toBe(2);
    expect(countNonZeroSuccessfulBalances([])).toBe(0);
  });
});

describe("batchErc20Balances shipped path (mocked multicall)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../src/data/rpc.js");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("preserves multicall balances and core decimals when metadata fails", async () => {
    const hexBal = 150_000_000n; // 1.5 HEX
    const wplsBal = 10n ** 18n; // 1 WPLS

    const readContract = vi.fn();
    let multicallCalls = 0;
    const multicall = vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
      multicallCalls += 1;
      // First call: balance-only (2 tokens)
      if (multicallCalls === 1 || contracts.length === 2) {
        return [
          { status: "success" as const, result: wplsBal },
          { status: "success" as const, result: hexBal },
        ];
      }
      // Metadata call: force all failures → must use core registry
      return contracts.map(() => ({
        status: "failure" as const,
        error: new Error("decode failed"),
      }));
    });

    vi.doMock("../src/data/rpc.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/rpc.js")>(
        "../src/data/rpc.js",
      );
      return {
        ...actual,
        getPublicClient: () => ({ multicall, readContract }),
      };
    });

    const { batchErc20Balances: batch } = await import(
      "../src/data/multicall.js"
    );

    const rows = await batch(
      baseConfig,
      OWNER,
      [WPLS_ADDRESS, HEX_ADDRESS],
      true,
    );

    expect(rows).toHaveLength(2);
    const wpls = rows.find(
      (r) => r.token.toLowerCase() === WPLS_ADDRESS.toLowerCase(),
    )!;
    const hex = rows.find(
      (r) => r.token.toLowerCase() === HEX_ADDRESS.toLowerCase(),
    )!;

    expect(wpls.balanceRaw).toBe(wplsBal.toString());
    expect(wpls.decimals).toBe(18);
    expect(hex.balanceRaw).toBe(hexBal.toString());
    expect(hex.decimals).toBe(8); // NOT 18
    expect(hex.balanceFormatted).toBe("1.5");
    expect(hex.symbol).toBe("HEX");
    expect(readContract).not.toHaveBeenCalled();
  });

  it("retries individual balanceOf when multicall balance entry fails", async () => {
    const recovered = 42n * 10n ** 18n;
    const readContract = vi.fn(async () => recovered);
    const multicall = vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
      if (contracts.length === 1) {
        // balance multicall fails
        return [{ status: "failure" as const, error: new Error("timeout") }];
      }
      // metadata ok
      return [
        { status: "success" as const, result: "Wrapped Pulse" },
        { status: "success" as const, result: "WPLS" },
        { status: "success" as const, result: 18 },
      ];
    });

    vi.doMock("../src/data/rpc.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/rpc.js")>(
        "../src/data/rpc.js",
      );
      return {
        ...actual,
        getPublicClient: () => ({ multicall, readContract }),
      };
    });

    const { batchErc20Balances: batch } = await import(
      "../src/data/multicall.js"
    );

    const rows = await batch(baseConfig, OWNER, [WPLS_ADDRESS], true);
    expect(rows[0]!.balanceRaw).toBe(recovered.toString());
    expect(readContract).toHaveBeenCalled();
  });
});
