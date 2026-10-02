import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  assessLiquidation,
  assembleVaultView,
  formatRatioPercent,
  formatSignedRatioPercent,
  plsPerUsdlFromNicr,
  priceStatusName,
  sumDebtInFront,
} from "../src/data/liquidLoans.js";

const borrower =
  "0x0000000000000000000000000000000000000001" as Address;

describe("Liquid Loans ratio formatting", () => {
  it("renders 110% MCR from 1.1e18", () => {
    expect(formatRatioPercent(1_100_000_000_000_000_000n)).toBe("110.00%");
  });

  it("keeps four decimal places on a borrowing fee", () => {
    expect(formatRatioPercent(5_014_000_000_000_000n, 4)).toBe("0.5014%");
  });

  it("formats a shortfall against the minimum as negative", () => {
    expect(formatSignedRatioPercent(-50_000_000_000_000_000n)).toBe("-5.00%");
  });

  it("converts nominal ICR to PLS per USDL instead of a percent", () => {
    expect(plsPerUsdlFromNicr(124_331_895_123_436_115_922_675_213n)).toBe(
      "1243318.95123436115922675213",
    );
  });

  it("names the price-feed status enum", () => {
    expect(priceStatusName(0)).toBe("fetchWorking");
    expect(priceStatusName(2)).toBe("bothOraclesUntrusted");
  });
});

describe("Liquid Loans liquidation advisory", () => {
  const mcr = 1_100_000_000_000_000_000n;
  const ccrBand = 1_450_000_000_000_000_000n;

  it("flags an active vault below the minimum", () => {
    expect(
      assessLiquidation({
        status: "active",
        icr: 1_050_000_000_000_000_000n,
        mcr,
        tcr: 2_000_000_000_000_000_000n,
        recoveryMode: false,
      }).state,
    ).toBe("below_minimum");
  });

  it("flags recovery mode when ICR is below the system ratio", () => {
    expect(
      assessLiquidation({
        status: "active",
        icr: 1_400_000_000_000_000_000n,
        mcr,
        tcr: ccrBand,
        recoveryMode: true,
      }).state,
    ).toBe("recovery_mode");
  });

  it("does not flag a vault above the minimum and above TCR", () => {
    expect(
      assessLiquidation({
        status: "active",
        icr: 1_600_000_000_000_000_000n,
        mcr,
        tcr: ccrBand,
        recoveryMode: true,
      }).state,
    ).toBe("above_thresholds");
  });

  it("ignores closed vaults", () => {
    expect(
      assessLiquidation({
        status: "closedByOwner",
        icr: 0n,
        mcr,
        tcr: ccrBand,
        recoveryMode: false,
      }).state,
    ).toBe("not_active");
  });
});

describe("Liquid Loans debt in front", () => {
  it("sums only vaults with a lower nominal ICR", () => {
    const summed = sumDebtInFront(100n, [
      { nicr: 50n, debt: 10n },
      { nicr: 100n, debt: 7n },
      { nicr: 150n, debt: 4n },
      { nicr: 40n, debt: 0n },
    ]);
    expect(summed).toEqual({ debt: 10n, vaultsAhead: 1 });
  });
});

describe("Liquid Loans vault view", () => {
  it("uses entire debt, subtracts the gas reserve, and does not percent-format NICR", () => {
    const entireDebt = 2_200n * 10n ** 18n;
    const pendingDebt = 100n * 10n ** 18n;
    const gas = 200n * 10n ** 18n;
    const view = assembleVaultView({
      borrower,
      price: {
        price: 9_861_034_793_091n,
        source: "fetchPrice",
        simulated: true,
        oracleStatus: "fetchWorking",
        note: "simulated",
      },
      statusCode: 1n,
      entireDebt,
      entireColl: 1_000_000n * 10n ** 18n,
      pendingDebt,
      pendingColl: 0n,
      icr: 1_310_000_000_000_000_000n,
      nicr: 124_331_895_123_436_115_922_675_213n,
      mcr: 1_100_000_000_000_000_000n,
      ccr: 1_500_000_000_000_000_000n,
      tcr: 2_990_000_000_000_000_000n,
      recoveryMode: false,
      gasCompensation: gas,
    });

    expect(view.status).toBe("active");
    expect(view.debtUsdl).toMatchObject({ formatted: "2200" });
    expect(view.recordedDebtUsdl).toMatchObject({ formatted: "2100" });
    expect(view.netDebtUsdl).toMatchObject({ formatted: "2000" });
    expect(view.collateralRatio).toMatchObject({ percent: "131.00%" });
    expect(view.nominalIcr).toMatchObject({
      plsPerUsdl: "1243318.95123436115922675213",
    });
    expect(view.nominalIcr).not.toHaveProperty("percent");
    expect(view.liquidation).toMatchObject({
      advisory: true,
      state: "above_thresholds",
      bufferToMinimum: "21.00%",
    });
    expect(view.price).toMatchObject({ source: "fetchPrice", simulated: true });
  });
});
