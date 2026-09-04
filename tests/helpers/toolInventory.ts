/**
 * Tool-list inventory used by registration / protocol tests.
 *
 * Write names match `write: true` in `src/tools/wallet/index.ts` (9 tools).
 * Wallets-on advertises the full surface; research-only omits those writes.
 */

export const HEALTH_TOOL_NAMES = [
  "pulsechain_health",
  "pulsechain_status",
  "get_rpc_health",
] as const;

export const WALLET_READ_TOOL_NAMES = [
  "agent_wallet_status",
  "agent_wallet_check_policy",
  "inspect_tx_intent",
  "get_agent_wallet_info",
  "list_agent_wallets",
] as const;

export const WALLET_WRITE_TOOL_NAMES = [
  "create_agent_wallet",
  "set_agent_policy",
  "propose_agent_tx",
  "execute_agent_tx",
  "sign_and_send",
  "settle_interrupted_broadcast",
  "transfer_pls",
  "kill_switch",
  "revoke",
] as const;

export const WALLET_TOOL_NAMES = [
  ...WALLET_READ_TOOL_NAMES,
  ...WALLET_WRITE_TOOL_NAMES,
] as const;

/** Health + wallet tools that declare MCP `outputSchema`. */
export const OUTPUT_SCHEMA_TOOL_NAMES = [
  ...HEALTH_TOOL_NAMES,
  ...WALLET_TOOL_NAMES,
] as const;

/** Full surface when AGENT_WALLET_ENABLED=true. */
export const REGISTERED_TOOL_COUNT_WALLETS_ON = 97;

/** Research-only: 97 minus the 9 write tools. */
export const REGISTERED_TOOL_COUNT_RESEARCH_ONLY =
  REGISTERED_TOOL_COUNT_WALLETS_ON - WALLET_WRITE_TOOL_NAMES.length;
