/**
 * Live chain-id checks against the default public RPC hosts.
 * PublicNode answers eth_chainId only when a user agent is set.
 */
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  CANONICAL_PUBLICNODE_RPC_URL,
  LEGACY_PUBLICNODE_RPC_URL,
  RPC_CLIENT_USER_AGENT,
} from "../src/constants.js";
import {
  readLiquidLoansPosition,
  readLiquidLoansSystem,
  readLiquidLoansVault,
} from "../src/data/liquidLoans.js";
import { testAppConfig } from "./helpers/appConfig.js";

async function ethChainId(url: string): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": RPC_CLIENT_USER_AGENT,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    }),
  });
  expect(res.ok, `${url} HTTP ${res.status}`).toBe(true);
  const json = (await res.json()) as { result?: string };
  expect(json.result, url).toMatch(/^0x[0-9a-fA-F]+$/);
  return Number.parseInt(json.result!, 16);
}

describe("live PulseChain eth_chainId", () => {
  it("canonical and legacy PublicNode hosts report chain id 369", async () => {
    expect(await ethChainId(CANONICAL_PUBLICNODE_RPC_URL)).toBe(369);
    expect(await ethChainId(LEGACY_PUBLICNODE_RPC_URL)).toBe(369);
  }, 30_000);
});

describe("live Liquid Loans system read", () => {
  it("reads a positive PLS price and system debt from mainnet", async () => {
    const cfg = testAppConfig({
      rpcUrl: CANONICAL_PUBLICNODE_RPC_URL,
      rpcUrls: [CANONICAL_PUBLICNODE_RPC_URL, "https://rpc.pulsechain.com"],
      network: "mainnet",
      httpTimeoutMs: 20_000,
    });
    const data = await readLiquidLoansSystem(cfg);
    expect(data.ok, JSON.stringify(data)).toBe(true);
    const price = data.price as { raw: string; source: string; simulated: boolean };
    expect(BigInt(price.raw)).toBeGreaterThan(0n);
    expect(["fetchPrice", "lastGoodPrice"]).toContain(price.source);
    if (price.source === "fetchPrice") expect(price.simulated).toBe(true);
    const debt = data.systemDebtUsdl as { raw: string };
    expect(BigInt(debt.raw)).toBeGreaterThan(0n);
    expect(data.minimumCollateralRatio).toMatchObject({ percent: "110.00%" });
    expect(data.criticalCollateralRatio).toMatchObject({ percent: "150.00%" });
    expect(data.usdlGasCompensation).toMatchObject({ formatted: "200" });
    const borrowing = data.borrowingRate as { percent: string };
    expect(borrowing.percent).toMatch(/^\d+\.\d{4}%$/);
    const lowest = data.lowestIcrVault as {
      address: Address;
      collateralRatio: { percent: string | null };
    };
    expect(lowest.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(lowest.collateralRatio.percent).toMatch(/%$/);

    const vault = await readLiquidLoansVault(cfg, lowest.address);
    expect(vault.ok, JSON.stringify(vault)).toBe(true);
    const nominal = vault.nominalIcr as { plsPerUsdl: string };
    expect(nominal.plsPerUsdl).toMatch(/^\d+\.\d+$/);
    expect(nominal).not.toHaveProperty("percent");
    expect(vault.liquidation).toMatchObject({ advisory: true });
    expect(vault.debtInFront).toMatchObject({
      computed: true,
      vaultsAhead: 0,
      usdl: { raw: "0" },
    });

    const position = await readLiquidLoansPosition(cfg, lowest.address);
    expect(position.ok, JSON.stringify(position)).toBe(true);
    expect(position.stabilityPool).toMatchObject({
      compoundedUsdl: { raw: expect.any(String) },
    });
  }, 60_000);
});
