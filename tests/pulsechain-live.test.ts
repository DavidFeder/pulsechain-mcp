/**
 * Live chain-id checks against the default public RPC hosts.
 * PublicNode answers eth_chainId only when a user agent is set.
 */
import { describe, expect, it } from "vitest";
import {
  CANONICAL_PUBLICNODE_RPC_URL,
  LEGACY_PUBLICNODE_RPC_URL,
  RPC_CLIENT_USER_AGENT,
} from "../src/constants.js";
import { readLiquidLoansSystem } from "../src/data/liquidLoans.js";
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
    const data = await readLiquidLoansSystem(
      testAppConfig({
        rpcUrl: CANONICAL_PUBLICNODE_RPC_URL,
        rpcUrls: [CANONICAL_PUBLICNODE_RPC_URL, "https://rpc.pulsechain.com"],
        network: "mainnet",
        httpTimeoutMs: 20_000,
      }),
    );
    expect(data.ok, JSON.stringify(data)).toBe(true);
    const price = data.price as { raw: string };
    expect(BigInt(price.raw)).toBeGreaterThan(0n);
    const debt = data.systemDebtUsdl as { raw: string };
    expect(BigInt(debt.raw)).toBeGreaterThan(0n);
  }, 40_000);
});
