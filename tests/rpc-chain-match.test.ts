/**
 * Live eth_chainId must match configured 369/943 before propose/sign.
 */
import { describe, expect, it } from "vitest";
import {
  assertLiveChainIdMatchesConfig,
  chainIdForConfig,
} from "../src/data/rpc.js";
import { RpcError } from "../src/utils/errors.js";

describe("assertLiveChainIdMatchesConfig", () => {
  it("returns the live id when it matches configured mainnet", () => {
    expect(assertLiveChainIdMatchesConfig(369, { network: "mainnet" })).toBe(
      369,
    );
  });

  it("returns the live id when it matches configured testnet", () => {
    expect(assertLiveChainIdMatchesConfig(943, { network: "testnet" })).toBe(
      943,
    );
  });

  it("refuses when live eth_chainId does not match configured network", () => {
    expect(() =>
      assertLiveChainIdMatchesConfig(1, { network: "mainnet" }),
    ).toThrow(RpcError);
    expect(() =>
      assertLiveChainIdMatchesConfig(1, { network: "mainnet" }),
    ).toThrow(/eth_chainId is 1|configured for chainId 369/i);
    expect(() =>
      assertLiveChainIdMatchesConfig(369, { network: "testnet" }),
    ).toThrow(/eth_chainId is 369|configured for chainId 943/i);
  });

  it("configured ids stay 369/943", () => {
    expect(chainIdForConfig({ network: "mainnet" })).toBe(369);
    expect(chainIdForConfig({ network: "testnet" })).toBe(943);
  });
});
