/**
 * Read-only Liquid Loans tools. No vault open/adjust/redeem.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  readLiquidLoansPosition,
  readLiquidLoansSystem,
  readLiquidLoansVault,
} from "../../data/liquidLoans.js";
import type { AppConfig } from "../../types.js";
import { assertAddress } from "../../utils/safety.js";
import { ok } from "../../utils/result.js";
import { registerTool } from "../define.js";

const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .describe("0x-prefixed address");

export function registerLiquidLoansTools(
  server: McpServer,
  config: AppConfig,
): void {
  registerTool(server, config, {
    name: "liquid_loans_system",
    description:
      "Read-only Liquid Loans system snapshot on PulseChain mainnet: simulated PLS price, " +
      "system collateral and USDL debt, total collateral ratio, recovery mode, " +
      "borrowing and redemption rates, MCR/CCR, stability-pool USDL and its share of debt, " +
      "active versus default pools, and the lowest-ICR vault. " +
      "Uses the current PLS-collateral VaultManager, not the older PLSX TroveManager. " +
      "Does not open, adjust, redeem, or liquidate.",
    category: "analytics",
    inputSchema: {},
    handler: async (_args, cfg) => ok(await readLiquidLoansSystem(cfg)),
  });

  registerTool(server, config, {
    name: "liquid_loans_vault",
    description:
      "Read-only Liquid Loans vault for an address. collateralPls and debtUsdl are entire " +
      "amounts (recorded plus pending redistribution). debtUsdl includes the USDL gas reserve; " +
      "netDebtUsdl subtracts it. collateralRatio is ICR as a percent. nominalIcr is PLS per USDL, " +
      "not a percent. liquidation and debtInFront are advisory. Mainnet only. " +
      "Does not open, adjust, or liquidate a vault. " +
      "Not the older PLSX-collateral trove manager.",
    category: "analytics",
    inputSchema: {
      address: addressSchema.describe("Vault owner (borrower) address"),
    },
    handler: async (args, cfg) =>
      ok(
        await readLiquidLoansVault(
          cfg,
          assertAddress(args.address as string),
        ),
      ),
  });

  registerTool(server, config, {
    name: "liquid_loans_position",
    description:
      "Read-only Liquid Loans position for an address: vault summary, compounded " +
      "stability-pool USDL (not the raw deposit), PLS and LOAN gains, LOAN stake with " +
      "pending gains, claimable collateral surplus, and advisory debt in front. Mainnet only. " +
      "Does not deposit, withdraw, stake, or liquidate. " +
      "Not the older PLSX-collateral trove manager.",
    category: "analytics",
    inputSchema: {
      address: addressSchema.describe(
        "Account to read (vault owner, stability depositor, or LOAN staker)",
      ),
    },
    handler: async (args, cfg) =>
      ok(
        await readLiquidLoansPosition(
          cfg,
          assertAddress(args.address as string),
        ),
      ),
  });
}
