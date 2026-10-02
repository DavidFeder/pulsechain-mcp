/**
 * PulseX buy-and-burn status fixtures. No live RPC.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getAddress, zeroAddress } from "viem";
import { HEX_ADDRESS, PLSX_ADDRESS, USDC_FROM_ETH_ADDRESS, WPLS_ADDRESS } from "../src/constants.js";
import {
  ERC1967_IMPLEMENTATION_SLOT,
  FEE_TOKEN_BALANCE_CAP,
  PULSEX_BUY_AND_BURN_IMPLEMENTATION_SEEN,
  PULSEX_BUY_AND_BURN_KNOWN_FEE_TOKENS,
  PULSEX_BUY_AND_BURN_PROXY,
  PULSEX_BUY_AND_BURN_READ_FRAGMENTS,
  PULSEX_BUY_AND_BURN_TOOL_DESCRIPTION,
  PULSEX_BURN_DEAD_ADDRESS,
  addressFromImplementationSlot,
  advisoryPriceFromDerivedUsd,
  assertCatalogPlsx,
  buildPulsexBuyAndBurnReport,
  feeTokenReadPlan,
  selectFeeTokenBalances,
  summarizeBuybackPlsxTransfers,
  type BuyAndBurnReportInput,
} from "../src/data/pulsexBuyAndBurn.js";
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

const STRANGER = "0x0000000000000000000000000000000000000001";
const TX_A = `0x${"11".repeat(32)}`;
const TX_B = `0x${"22".repeat(32)}`;

function reportInput(
  overrides: Partial<BuyAndBurnReportInput> = {},
): BuyAndBurnReportInput {
  return {
    implementation: PULSEX_BUY_AND_BURN_IMPLEMENTATION_SEEN,
    paused: true,
    enabled: null,
    anyAuth: false,
    wpls: WPLS_ADDRESS,
    deadPlsxRaw: 1000n,
    zeroPlsxRaw: 0n,
    buybackPlsxRaw: 5n,
    nativePlsRaw: 7n,
    feeTokens: [
      { address: WPLS_ADDRESS, balanceRaw: 9n, source: "abi" },
    ],
    lastBurn: summarizeBuybackPlsxTransfers([], PULSEX_BUY_AND_BURN_PROXY),
    plsxPrice: advisoryPriceFromDerivedUsd(null),
    ...overrides,
  };
}

describe("paused flag", () => {
  it("maps paused true to running false", () => {
    const report = buildPulsexBuyAndBurnReport(reportInput());
    expect(report.running).toBe(false);
    expect(report.runningView).toBe("paused()");
    expect(report.runningChecked).toEqual(["paused()", "enabled()"]);
    expect(report.runningNote).toMatch(/fees may be sitting/i);
    expect(report.runningNote).toMatch(/not happening until someone can call it again/i);
    expect(report.runningNote.toLowerCase()).not.toMatch(/every trade burns plsx/);
    expect(report.calledBuyAndBurn).toBe(false);
    expect(report.calledConvertLps).toBe(false);
    expect(report.financialAdvice).toBe(false);
  });

  it("lets paused() win when enabled() is also true", () => {
    const report = buildPulsexBuyAndBurnReport(
      reportInput({ paused: true, enabled: true }),
    );
    expect(report.running).toBe(false);
    expect(report.runningView).toBe("paused()");
  });

  it("maps enabled false to running false when paused() is absent", () => {
    const report = buildPulsexBuyAndBurnReport(
      reportInput({ paused: null, enabled: false }),
    );
    expect(report.running).toBe(false);
    expect(report.runningView).toBe("enabled()");
    expect(report.runningNote).toMatch(/fees may be sitting/i);
  });

  it("says unknown when neither pause view returns a boolean", () => {
    const report = buildPulsexBuyAndBurnReport(
      reportInput({ paused: null, enabled: null, anyAuth: false }),
    );
    expect(report.running).toBe("unknown");
    expect(report.runningView).toBeNull();
    expect(report.runningNote).toMatch(/unknown/);
    expect(report.runningNote.toLowerCase()).not.toMatch(/burns are not happening/);
    expect(report.runningNote.toLowerCase()).not.toMatch(/every trade burns plsx/);
    expect(report.anyAuth).toBe(false);
    expect(report.anyAuthView).toBe("anyAuth()");
    expect(report.callerGateNote).toMatch(/not a paused/i);
    expect(report.callerGateNote).toMatch(/authorized callers can still convert/i);
  });
});

describe("dead address versus buyback PLSX", () => {
  it("reports the two balances separately", () => {
    const report = buildPulsexBuyAndBurnReport(reportInput());
    expect(report.chainId).toBe(369);
    expect(report.proxy).toBe(getAddress(PULSEX_BUY_AND_BURN_PROXY));
    expect(report.implementation).toBe(PULSEX_BUY_AND_BURN_IMPLEMENTATION_SEEN);
    expect(report.implementationMatchesSeen).toBe(true);
    expect(report.implementationSlot).toBe(ERC1967_IMPLEMENTATION_SLOT);
    expect(report.plsx).toBe(getAddress(PLSX_ADDRESS));
    expect(report.dead).toBe(PULSEX_BURN_DEAD_ADDRESS);
    expect(report.plsxBalances.dead.address).toBe(getAddress(PULSEX_BURN_DEAD_ADDRESS));
    expect(report.plsxBalances.dead.balanceRaw).toBe("1000");
    expect(report.plsxBalances.dead.balance).toBe("0.000000000000001");
    expect(report.plsxBalances.buyback.address).toBe(report.proxy);
    expect(report.plsxBalances.buyback.address).not.toBe(report.implementation);
    expect(report.plsxBalances.buyback.balanceRaw).toBe("5");
    expect(report.plsxBalances.buyback.balance).toBe("0.000000000000000005");
    expect(report.plsxBalances.dead.balanceRaw).not.toBe(
      report.plsxBalances.buyback.balanceRaw,
    );
    expect(report.plsxBalances.dead.note).toMatch(/not only/i);
    expect(report.plsxBalances.zero.address).toBe(zeroAddress);
    expect(report.plsxBalances.zero.balanceRaw).toBe("0");
    expect(report.nativePls.balanceRaw).toBe("7");
    expect(report.nativePls.address).toBe(report.proxy);
    expect(report.note).toMatch(/21%/);
    expect(report.note).toMatch(/76%/);
    expect(report.note).toMatch(/pays gas/);
    expect(report.note).toMatch(/not a price promise/);
    expect(report.note).toMatch(/not proof the next call will succeed/);
    expect(report.plsxPrice.advisory).toBe(true);
    expect(report.plsxPrice.priceUsd).toBeNull();
    expect(report.plsxPrice.appliedToBalances).toBe(false);
  });
});

describe("fail closed addresses", () => {
  it("decodes the ERC-1967 slot and rejects the zero implementation", () => {
    expect(
      addressFromImplementationSlot(
        "0x0000000000000000000000005f02fbb0f8d924e9b67c7daae523ff51175699f9",
      ),
    ).toBe(PULSEX_BUY_AND_BURN_IMPLEMENTATION_SEEN);
    expect(() => addressFromImplementationSlot(`0x${"0".repeat(64)}`)).toThrow(
      /zero address/,
    );
    expect(() => addressFromImplementationSlot("not-hex")).toThrow(/not hex/);
  });

  it("rejects a PLSX() result that is not catalog PLSX", () => {
    expect(assertCatalogPlsx(PLSX_ADDRESS)).toBe(getAddress(PLSX_ADDRESS));
    expect(() => assertCatalogPlsx(STRANGER)).toThrow(/catalog PLSX/);
    expect(() => assertCatalogPlsx(null)).toThrow(/not guessed/);
  });

  it("rejects a zero implementation inside the report", () => {
    expect(() =>
      buildPulsexBuyAndBurnReport(
        reportInput({ implementation: zeroAddress }),
      ),
    ).toThrow(/zero address/);
  });
});

describe("fee tokens", () => {
  it("keeps ABI WPLS, caps the list, and labels unverified tokens", () => {
    const plan = feeTokenReadPlan(WPLS_ADDRESS);
    expect(plan).toHaveLength(PULSEX_BUY_AND_BURN_KNOWN_FEE_TOKENS.length);
    expect(plan.filter((row) => row.address === getAddress(WPLS_ADDRESS))).toEqual([
      { address: getAddress(WPLS_ADDRESS), source: "abi" },
    ]);
    expect(plan.some((row) => row.address === getAddress(PLSX_ADDRESS))).toBe(false);

    const strangerPlan = feeTokenReadPlan(STRANGER);
    expect(strangerPlan[0]).toEqual({
      address: getAddress(STRANGER),
      source: "abi",
    });
    expect(
      strangerPlan.find((row) => row.address === getAddress(WPLS_ADDRESS))?.source,
    ).toBe("known-list");

    const selected = selectFeeTokenBalances(
      [
        { address: WPLS_ADDRESS, balanceRaw: 1n, source: "abi" },
        { address: STRANGER, balanceRaw: 50n, source: "known-list" },
        { address: HEX_ADDRESS, balanceRaw: 0n, source: "known-list" },
      ],
      2,
    );
    expect(selected.cap).toBe(2);
    expect(selected.truncated).toBe(true);
    expect(selected.tokens.map((row) => row.balanceRaw)).toEqual(["1", "50"]);
    const unverified = selected.tokens.find((row) => row.balanceRaw === "50");
    expect(unverified?.label).toBe("unverified");
    expect(unverified?.balance).toBeNull();
    expect(unverified?.symbol).toBeNull();
    const wpls = selected.tokens.find((row) => row.symbol === "WPLS");
    expect(wpls?.label).toBe("catalogued");
    expect(wpls?.source).toBe("abi");
    expect(wpls?.balance).toBe("0.000000000000000001");
    expect(FEE_TOKEN_BALANCE_CAP).toBe(8);
  });

  it("ranks 1 eUSDC above 1 wei of WPLS without inventing USD", () => {
    const selected = selectFeeTokenBalances(
      [
        { address: WPLS_ADDRESS, balanceRaw: 1n, source: "abi" },
        { address: USDC_FROM_ETH_ADDRESS, balanceRaw: 1_000_000n, source: "known-list" },
      ],
      2,
    );
    expect(selected.truncated).toBe(false);
    expect(selected.tokens.map((row) => row.symbol)).toEqual(["USDC", "WPLS"]);
    expect(selected.tokens[0]?.balance).toBe("1");
    expect(selected.tokens.every((row) => !("usd" in row))).toBe(true);
  });
});

describe("burn transfer evidence", () => {
  it("keeps a dead-address transfer apart from a later zero-address burn", () => {
    const evidence = summarizeBuybackPlsxTransfers(
      [
        {
          from: PULSEX_BUY_AND_BURN_PROXY,
          to: PULSEX_BURN_DEAD_ADDRESS,
          value: "10",
          blockNumber: "1",
          logIndex: "0",
          tokenDecimal: "18",
          hash: TX_A,
        },
        {
          from: PULSEX_BUY_AND_BURN_PROXY,
          to: zeroAddress,
          value: "99",
          blockNumber: "5",
          logIndex: "1",
          tokenDecimal: "18",
          hash: TX_B,
          timeStamp: "1787928775",
        },
      ],
      PULSEX_BUY_AND_BURN_PROXY,
    );
    expect(evidence.ok).toBe(true);
    expect(evidence.softFail).toBe(false);
    expect(evidence.latestToDead?.valueRaw).toBe("10");
    expect(evidence.latestToDead?.toDead).toBe(true);
    expect(evidence.latest?.valueRaw).toBe("99");
    expect(evidence.latest?.toZero).toBe(true);
    expect(evidence.latest?.txHash).toBe(TX_B);
    expect(evidence.note).toMatch(/zero address/);
    expect(evidence.note).toMatch(/dead-address balance is separate/i);
  });

  it("soft-fails a non-list explorer payload", () => {
    const evidence = summarizeBuybackPlsxTransfers(
      { message: "not a list" },
      PULSEX_BUY_AND_BURN_PROXY,
    );
    expect(evidence.ok).toBe(false);
    expect(evidence.softFail).toBe(true);
    expect(evidence.latest).toBeNull();
    expect(evidence.note).toMatch(/No burn transfer was invented/);
  });
});

describe("price helper", () => {
  it("keeps non-positive derivedUSD empty and does not apply it to balances", () => {
    expect(advisoryPriceFromDerivedUsd("0.00001")).toMatchObject({
      advisory: true,
      priceUsd: 0.00001,
      source: "pulsex-subgraph-derivedUSD",
      appliedToBalances: false,
    });
    expect(advisoryPriceFromDerivedUsd("0").priceUsd).toBeNull();
    expect(advisoryPriceFromDerivedUsd("-3").priceUsd).toBeNull();
    expect(advisoryPriceFromDerivedUsd("nope").priceUsd).toBeNull();
  });
});

describe("read ABI and registration", () => {
  afterEach(() => {
    resetToolRegistry();
  });

  it("exposes view functions only", () => {
    expect(PULSEX_BUY_AND_BURN_READ_FRAGMENTS.length).toBeGreaterThan(0);
    for (const fragment of PULSEX_BUY_AND_BURN_READ_FRAGMENTS) {
      expect(fragment).toMatch(/^function .+ view returns \((bool|address)\)$/);
      expect(fragment).not.toMatch(/buyAndBurn|convertLps/);
    }
  });

  it("registers pulsex_buy_and_burn as a read-only contract status tool", () => {
    const names: string[] = [];
    registerAllTools(
      {
        registerTool: (name: string) => {
          names.push(name);
        },
      } as never,
      baseConfig,
    );
    const tool = getRegisteredTools().find((row) => row.name === "pulsex_buy_and_burn");
    expect(names).toContain("pulsex_buy_and_burn");
    expect(tool?.write).toBe(false);
    expect(tool?.category).toBe("analytics");
    expect(tool?.description).toBe(PULSEX_BUY_AND_BURN_TOOL_DESCRIPTION);
    expect(tool?.description).toMatch(/not financial advice/i);
    expect(tool?.description).toMatch(/Does not call buyAndBurn, convertLps/);
  });
});
