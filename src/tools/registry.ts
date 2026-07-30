import type { McpServer } from "@modelcontextprotocol/server";
import type { AppConfig } from "../types.js";
import { logger } from "../logger.js";
import { getRegisteredTools, resetToolRegistry } from "./define.js";
import { registerAnalyticsTools } from "./analytics/index.js";
import { registerChainTools } from "./chain/index.js";
import { registerWalletTools } from "./wallet/index.js";
import { registerHealthTools } from "./health.js";

export {
  registerTool,
  getRegisteredTools,
  type RegisterToolOptions,
  type RegisteredToolMeta,
} from "./define.js";

/** Register all MCP tools on the server. */
export function registerAllTools(server: McpServer, config: AppConfig): void {
  resetToolRegistry();

  registerHealthTools(server, config);
  registerChainTools(server, config);
  registerAnalyticsTools(server, config);
  registerWalletTools(server, config);

  const tools = getRegisteredTools();
  logger.info("Registered MCP tools", {
    count: tools.length,
    tools: tools.map((t) => t.name),
  });
}
