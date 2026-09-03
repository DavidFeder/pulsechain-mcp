import { McpServer } from "@modelcontextprotocol/server";
import {
  PROTOCOL_MODE,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.js";
import type { AppConfig } from "./types.js";
import { registerAllTools } from "./tools/registry.js";
import { registerResources } from "./resources/index.js";
import { getConfirmStateCodec } from "./utils/confirm.js";

/**
 * Mode-aware `McpServer` instructions.
 * Research-only: analytics + chain reads; writes refuse; prefer RO guidance.
 * Wallets on: operator-trust agent wallets (funding authorizes; confirm/MRTR is host UX).
 */
export function mcpServerInstructions(agentWalletEnabled: boolean): string {
  if (!agentWalletEnabled) {
    return (
      "PulseChain MCP: analytics and chain reads. " +
      "Write and signing tools refuse (AGENT_WALLET_ENABLED=false) and are not listed. " +
      "Prefer pulsechain://guidance/ro-research. " +
      `Protocol mode ${PROTOCOL_MODE}. This process does not sign or broadcast.`
    );
  }
  return (
    "PulseChain MCP: public analytics, chain reads, and optional operator-trust agent wallets " +
    "(funding authorizes when enabled; confirm=true / MRTR is host UX only). " +
    `Protocol mode ${PROTOCOL_MODE}. Wallet writes require AGENT_WALLET_ENABLED and confirm ` +
    `(confirm=true arg or modern MRTR InputRequiredResult elicitation).`
  );
}

/**
 * Build a fresh McpServer for the given config (SDK v2 factory pattern).
 *
 * Stateless / dual-era rules:
 * - Call once per stdio connection pin (`serveStdio(() => createServer(config))`)
 *   and once per HTTP request (`createMcpHandler(() => createServer(config))`).
 * - Do not cache a single McpServer across HTTP requests.
 * - Protocol identity comes from per-request `_meta` (modern) or initialize
 *   (legacy dual path) — never from Mcp-Session-Id application state.
 * - Server identity for 2026 responses is stamped by the SDK into result
 *   `_meta['io.modelcontextprotocol/serverInfo']` from `{ name, version }`.
 * - `server/discover` is answered automatically by the SDK when serving via
 *   serveStdio / createMcpHandler; capabilities reflect registered tools + resources.
 * - `requestState.verify` is the HMAC codec for wallet confirm MRTR (no secrets in state).
 */
export function createServer(config: AppConfig): McpServer {
  const confirmCodec = getConfirmStateCodec();
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: mcpServerInstructions(config.agentWalletEnabled),
      // Integrity-protect multi-round-trip requestState (wallet confirm flows).
      requestState: {
        verify: (state, ctx) => confirmCodec.verify(state, ctx),
      },
    },
  );

  registerAllTools(server, config);
  registerResources(server, config);

  return server;
}
