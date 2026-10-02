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
  "transfer_token",
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

/**
 * Default slim surface when AGENT_WALLET_ENABLED=true.
 * 97 historical tools, minus 15 legacy chain aliases, plus allowance,
 * transfer_token, three Liquid Loans reads, hex_stake_summary, and pulsex_buy_and_burn.
 */
export const REGISTERED_TOOL_COUNT_WALLETS_ON = 89;

/** Research-only slim: wallets-on minus write tools. */
export const REGISTERED_TOOL_COUNT_RESEARCH_ONLY =
  REGISTERED_TOOL_COUNT_WALLETS_ON - WALLET_WRITE_TOOL_NAMES.length;

/** slim + the 15 deprecated pulsechain_* chain aliases. */
export const REGISTERED_TOOL_COUNT_WALLETS_ON_FULL =
  REGISTERED_TOOL_COUNT_WALLETS_ON + 15;

export const REGISTERED_TOOL_COUNT_RESEARCH_ONLY_FULL =
  REGISTERED_TOOL_COUNT_WALLETS_ON_FULL - WALLET_WRITE_TOOL_NAMES.length;
