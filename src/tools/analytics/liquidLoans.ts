/**
 * Read-only Liquid Loans tools. No vault open/adjust/redeem.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
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
      "Read-only Liquid Loans system snapshot on PulseChain mainnet: PLS price, " +
      "system collateral and USDL debt, total collateral ratio, recovery mode, " +
      "borrowing and redemption rates, MCR/CCR, and stability-pool USDL. " +
      "Uses the current PLS-collateral VaultManager, not the older PLSX TroveManager. " +
      "Does not open, adjust, or redeem vaults.",
    category: "analytics",
    inputSchema: {},
    handler: async (_args, cfg) => ok(await readLiquidLoansSystem(cfg)),
  });

  registerTool(server, config, {
    name: "liquid_loans_vault",
    description:
      "Read-only Liquid Loans vault for an address: status, PLS collateral, USDL debt, " +
      "and collateral ratio at the current price. Mainnet only. " +
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
}
