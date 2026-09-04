import { afterEach, describe, expect, it } from "vitest";
import {
  getRegisteredTools,
  resetToolRegistry,
} from "../src/tools/define.js";
import { registerAllTools } from "../src/tools/registry.js";
import { testAppConfig } from "./helpers/appConfig.js";
import {
  REGISTERED_TOOL_COUNT_RESEARCH_ONLY,
  REGISTERED_TOOL_COUNT_WALLETS_ON,
} from "./helpers/toolInventory.js";

/** Legacy chain scaffold names → canonical replacement (item 6). */
const LEGACY_CHAIN_ALIASES: Record<string, string> = {
  pulsechain_chain_id: "pulsechain_health",
  pulsechain_block_number: "get_block",
  pulsechain_get_block: "get_block",
  pulsechain_get_balance: "get_balance",
  pulsechain_get_transaction: "get_transaction",
  pulsechain_get_receipt: "get_transaction",
  pulsechain_estimate_gas: "estimate_gas",
  pulsechain_eth_call: "read_contract",
  pulsechain_gas_price: "get_gas_price",
  pulsechain_erc20_metadata: "get_token_balance",
  pulsechain_erc20_balances: "get_token_balance",
  pulsechain_account_txlist: "get_transaction_history",
  pulsechain_token_transfers: "get_token_transfers",
  pulsechain_token_info: "get_token_info",
  pulsechain_get_logs: "blockscout_event_logs",
};

const CANONICAL_REPLACEMENTS = [
  "pulsechain_health",
  "get_block",
  "get_balance",
  "get_transaction",
  "estimate_gas",
  "read_contract",
  "get_gas_price",
  "get_token_balance",
  "get_transaction_history",
  "get_token_transfers",
  "get_token_info",
  "blockscout_event_logs",
] as const;

function mockServer() {
  return {
    registerTool: () => {
      /* names captured via getRegisteredTools */
    },
  };
}

afterEach(() => {
  resetToolRegistry();
});

describe("legacy pulsechain_* chain aliases (deprecated descriptions)", () => {
  it("keeps all 15 aliases registered with DEPRECATED descriptions naming replacements", () => {
    resetToolRegistry();
    registerAllTools(mockServer() as never, testAppConfig());

    const meta = getRegisteredTools();
    const byName = new Map(meta.map((t) => [t.name, t]));

    expect(Object.keys(LEGACY_CHAIN_ALIASES)).toHaveLength(15);

    for (const [name, replacement] of Object.entries(LEGACY_CHAIN_ALIASES)) {
      const tool = byName.get(name);
      expect(tool, name).toBeDefined();
      expect(tool!.description).toMatch(/DEPRECATED/i);
      expect(tool!.description).toContain(replacement);
    }

    for (const name of CANONICAL_REPLACEMENTS) {
      expect(byName.has(name), name).toBe(true);
    }

    for (const health of ["pulsechain_health", "pulsechain_status"] as const) {
      const desc = byName.get(health)?.description ?? "";
      expect(desc, health).not.toMatch(/DEPRECATED/i);
    }

    for (const keep of [
      "defillama_pulsechain_tvl",
      "defillama_pulsechain_protocols",
      "pulsex_quote",
      "pulsex_factory",
    ] as const) {
      const desc = byName.get(keep)?.description ?? "";
      expect(desc, keep).not.toMatch(/DEPRECATED/i);
    }
  });

  it("does not change registered tool counts", () => {
    expect(REGISTERED_TOOL_COUNT_WALLETS_ON).toBe(97);
    expect(REGISTERED_TOOL_COUNT_RESEARCH_ONLY).toBe(88);

    resetToolRegistry();
    registerAllTools(
      mockServer() as never,
      testAppConfig({ agentWalletEnabled: false }),
    );
    expect(getRegisteredTools().length).toBe(REGISTERED_TOOL_COUNT_RESEARCH_ONLY);

    resetToolRegistry();
    registerAllTools(
      mockServer() as never,
      testAppConfig({ agentWalletEnabled: true }),
    );
    expect(getRegisteredTools().length).toBe(REGISTERED_TOOL_COUNT_WALLETS_ON);
  });
});
