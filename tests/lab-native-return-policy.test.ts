/**
 * Operator-trust: ordinary funded sends are not blocked by legacy caps/allowlists.
 * Uses placeholder addresses only (no live lab identities).
 */
import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/wallet/policy.js";
import { DEFAULT_POLICY } from "../src/wallet/types.js";
import { parsePlsToWei, weiToPlsNumber } from "../src/wallet/value.js";

/** Obviously fake placeholders — not live lab wallets */
const FUNDER = "0x00000000000000000000000000000000000000f1" as const;
const LAB = "0x00000000000000000000000000000000000000a1" as const;

describe("operator-trust native send path", () => {
  it("allows 10000 PLS native EOA transfer even with low legacy caps 500/2000", () => {
    const amountPls = 10_000;
    const valueWei = parsePlsToWei(amountPls);
    expect(valueWei.toString()).toBe("10000000000000000000000");
    expect(weiToPlsNumber(valueWei)).toBe(10_000);

    const policy = {
      ...DEFAULT_POLICY(500, 2000),
      allowNativeTransfers: true,
      contractAllowlist: [] as `0x${string}`[],
      enabled: true,
      killed: false,
    };

    const check = evaluatePolicy({
      policy,
      dailySpend: {
        date: new Date().toISOString().slice(0, 10),
        spentPls: 0,
        spentWei: "0",
      },
      to: FUNDER,
      valueWei,
      valuePls: amountPls,
      data: "0x",
      destinationIsContract: false,
    });

    expect(check.allowed).toBe(true);
    expect(check.reasons).toEqual([]);
    expect(check.isContractInteraction).toBe(false);
    expect(check.valuePls).toBe(10_000);
  });

  it("allows contract interaction with empty allowlist (not deny-by-default gate)", () => {
    const check = evaluatePolicy({
      policy: {
        ...DEFAULT_POLICY(1, 5),
        contractAllowlist: [],
        enabled: true,
        killed: false,
      },
      dailySpend: {
        date: new Date().toISOString().slice(0, 10),
        spentPls: 0,
        spentWei: "0",
      },
      to: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
      valueWei: 0n,
      valuePls: 0,
      data: "0xa9059cbb",
      destinationIsContract: true,
    });
    expect(check.allowed).toBe(true);
    expect(check.tokenNotional?.notes.join(" ")).toMatch(/Operator-trust/i);
  });

  it("placeholder lab and funder addresses are distinct", () => {
    expect(LAB.toLowerCase()).not.toBe(FUNDER.toLowerCase());
  });
});
