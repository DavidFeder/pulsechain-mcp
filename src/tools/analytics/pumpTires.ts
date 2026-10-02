/**
 * Read-only Pump.tires coin status. Not a wallet action and not a swap.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  PUMP_TIRES_TOOL_DESCRIPTION,
  readPumpTiresCoin,
} from "../../data/pumpTires.js";
import type { AppConfig } from "../../types.js";
import { ok } from "../../utils/result.js";
import { registerTool } from "../define.js";

export function registerPumpTiresCoinTool(
  server: McpServer,
  config: AppConfig,
): void {
  registerTool(server, config, {
    name: "pump_tires_coin",
    description: PUMP_TIRES_TOOL_DESCRIPTION,
    category: "analytics",
    inputSchema: {
      token: z
        .string()
        .regex(/^0x[a-fA-F0-9]{40}$/)
        .describe(
          "Token address. Address is identity. Required. This does not accept a ticker.",
        ),
    },
    handler: async (args, cfg) => {
      const data = await readPumpTiresCoin(cfg, args.token as string);
      return ok(data, data.warnings);
    },
  });
}
