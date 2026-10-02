/**
 * Read-only PulseX buy-and-burn status. Not a wallet action.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import {
  PULSEX_BUY_AND_BURN_TOOL_DESCRIPTION,
  readPulsexBuyAndBurn,
} from "../../data/pulsexBuyAndBurn.js";
import type { AppConfig } from "../../types.js";
import { ok } from "../../utils/result.js";
import { registerTool } from "../define.js";

export function registerPulsexBuyAndBurnTool(
  server: McpServer,
  config: AppConfig,
): void {
  registerTool(server, config, {
    name: "pulsex_buy_and_burn",
    description: PULSEX_BUY_AND_BURN_TOOL_DESCRIPTION,
    category: "analytics",
    inputSchema: {},
    handler: async (_args, cfg) => {
      const data = await readPulsexBuyAndBurn(cfg);
      const warnings = data.lastBurn.softFail
        ? [
            "Buy-and-burn explorer transfer query failed. On-chain balances are still included.",
          ]
        : undefined;
      return ok(data, warnings);
    },
  });
}
