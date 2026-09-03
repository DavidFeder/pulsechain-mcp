/**
 * Smoke tests: server boots and registers tools without live network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  getRegisteredTools,
  resetToolRegistry,
} from "../src/tools/define.js";
import { registerAllTools } from "../src/tools/registry.js";
import { registerResources } from "../src/resources/index.js";
import {
  DEFAULT_EXPLORER_API,
  DEFAULT_PULSEX_SUBGRAPH_V1,
  DEFAULT_PULSEX_SUBGRAPH_V2,
  DEFAULT_RPC_URL,
  DEFAULT_RPC_URLS,
} from "../src/constants.js";
import type { AppConfig } from "../src/types.js";
import {
  REGISTERED_TOOL_COUNT_RESEARCH_ONLY,
  REGISTERED_TOOL_COUNT_WALLETS_ON,
  WALLET_READ_TOOL_NAMES,
  WALLET_TOOL_NAMES,
  WALLET_WRITE_TOOL_NAMES,
} from "./helpers/toolInventory.js";

const smokeConfig: AppConfig = {
  rpcUrl: "https://rpc.pulsechain.com",
  rpcUrls: ["https://rpc.pulsechain.com"],
  network: "mainnet",
  explorerApi: "https://api.scan.pulsechain.com/api",
  pulseXSubgraphV1: "https://example.com/subgraph/v1",
  pulseXSubgraphV2: "https://example.com/subgraph/v2",
  agentWalletEnabled: false,
  agentWalletMasterKey: undefined,
  agentWalletDir: "./data/wallets-smoke",
  agentWalletMultiprocStrict: false,
  agentWalletEnforceLegacyCaps: false,
  maxPlsPerTx: 100,
  maxPlsDaily: 1000,
  httpTransportPort: undefined,
  logLevel: "error",
  httpTimeoutMs: 5_000,
};

/** Verification inventory — free analytics (11) */
const FREE_ANALYTICS = [
  "get_token_price",
  "get_token_info",
  "get_token_history",
  "get_top_tokens",
  "get_top_pairs",
  "get_market_overview",
  "get_token_safety",
  "get_token_liquidity",
  "get_honeypots",
  "get_bridge_stats",
  "get_holder_leagues",
] as const;

/** Verification inventory — advanced analytics (9) */
const ADVANCED_ANALYTICS = [
  "check_address_risk",
  "get_deployer_reputation",
  "get_scam_alerts",
  "get_smart_money_feed",
  "get_recent_swaps",
  "get_wallet_balances",
  "get_wallet_swaps",
  "get_funding_tree",
  "get_holder_rank",
] as const;

/** Verification inventory — canonical chain tools (12) */
const CHAIN_CANONICAL = [
  "get_balance",
  "get_token_balance",
  "get_portfolio",
  "get_transaction",
  "get_transaction_history",
  "get_gas_price",
  "estimate_gas",
  "get_block",
  "read_contract",
  "prepare_transaction",
  "pulsex_quote",
  "prepare_swap",
] as const;

const walletsOnConfig: AppConfig = { ...smokeConfig, agentWalletEnabled: true };

/** Required MCP resource URIs */
const REQUIRED_RESOURCES = [
  "pulsechain://tokens/core",
  "pulsechain://contracts/popular",
  "pulsechain://chain/config",
  "pulsechain://rpc/status",
  "pulsechain://guidance/ro-research",
] as const;

/** Minimal MCP server stub — captures tool names only (no transport). */
function mockServer() {
  const names: string[] = [];
  return {
    names,
    server: {
      registerTool: (name: string) => {
        names.push(name);
      },
    },
  };
}

/** Captures tools + resources for independence/registration checks. */
function mockServerWithResources() {
  const toolNames: string[] = [];
  const resourceUris: string[] = [];
  const resourceHandlers = new Map<
    string,
    (uri: URL) => Promise<{ contents: Array<{ text: string }> }>
  >();
  return {
    toolNames,
    resourceUris,
    resourceHandlers,
    server: {
      registerTool: (name: string) => {
        toolNames.push(name);
      },
      registerResource: (
        _name: string,
        uri: string,
        _meta: unknown,
        handler: (uri: URL) => Promise<{ contents: Array<{ text: string }> }>,
      ) => {
        resourceUris.push(uri);
        resourceHandlers.set(uri, handler);
      },
    },
  };
}

afterEach(() => {
  resetToolRegistry();
  vi.restoreAllMocks();
});

describe("smoke: tool registration (no live network)", () => {
  it("research-only omits write tools from tools/list and keeps wallet reads", () => {
    const { names, server } = mockServer();
    resetToolRegistry();
    registerAllTools(server as never, smokeConfig);

    const meta = getRegisteredTools();
    expect(meta.length).toBe(REGISTERED_TOOL_COUNT_RESEARCH_ONLY);
    expect(REGISTERED_TOOL_COUNT_RESEARCH_ONLY).toBe(87);
    expect(names.length).toBe(REGISTERED_TOOL_COUNT_RESEARCH_ONLY);
    expect(names.length).toBe(meta.length);

    const byName = new Set(meta.map((t) => t.name));

    expect(byName.has("pulsechain_health")).toBe(true);
    expect(byName.has("pulsechain_status")).toBe(true);
    expect(byName.has("get_rpc_health")).toBe(true);
    expect(byName.has("get_token_price")).toBe(true);
    expect(byName.has("phiat_dashboard")).toBe(true);
    expect(byName.has("piteas_accumulation_plan")).toBe(true);

    for (const n of WALLET_READ_TOOL_NAMES) expect(byName.has(n)).toBe(true);
    for (const n of WALLET_WRITE_TOOL_NAMES) expect(byName.has(n)).toBe(false);

    const byCat = (c: string) => meta.filter((t) => t.category === c);
    expect(byCat("health").length).toBe(3);
    expect(byCat("chain").length).toBe(27);
    expect(byCat("wallet").length).toBe(WALLET_READ_TOOL_NAMES.length);
    expect(meta.filter((t) => t.write)).toEqual([]);
    expect(new Set(meta.map((t) => t.name)).size).toBe(meta.length);
  });

  it("registerAllTools registers full verification inventory when wallets are on", () => {
    const { names, server } = mockServer();
    resetToolRegistry();
    registerAllTools(server as never, walletsOnConfig);

    const meta = getRegisteredTools();
    expect(meta.length).toBe(REGISTERED_TOOL_COUNT_WALLETS_ON);
    expect(names.length).toBe(REGISTERED_TOOL_COUNT_WALLETS_ON);
    expect(names.length).toBe(meta.length);

    const byName = new Set(meta.map((t) => t.name));

    // Health
    expect(byName.has("pulsechain_health")).toBe(true);
    expect(byName.has("pulsechain_status")).toBe(true);
    expect(byName.has("get_rpc_health")).toBe(true);

    for (const n of FREE_ANALYTICS) expect(byName.has(n)).toBe(true);
    for (const n of ADVANCED_ANALYTICS) expect(byName.has(n)).toBe(true);
    expect(byName.has("phiat_dashboard")).toBe(true);
    expect(byName.has("piteas_accumulation_plan")).toBe(true);
    for (const n of CHAIN_CANONICAL) expect(byName.has(n)).toBe(true);
    for (const n of WALLET_TOOL_NAMES) expect(byName.has(n)).toBe(true);

    // DexScreener (v0.1.25)
    for (const n of [
      "dexscreener_search",
      "dexscreener_pair",
      "dexscreener_token_pairs",
      "dexscreener_tokens",
      "dexscreener_boosts_latest",
      "dexscreener_profiles_latest",
    ]) {
      expect(byName.has(n)).toBe(true);
    }

    // Tier A (v0.1.32 + Piteas v0.1.40 + Switch v0.1.42)
    for (const n of [
      "blockscout_token_overview",
      "blockscout_contract_abi",
      "blockscout_address_activity",
      "blockscout_event_logs",
      "defillama_pulsechain_tvl",
      "defillama_pulsechain_protocols",
      "pulseswap_quote",
      "piteas_quote",
      "piteas_prepare_swap",
      "switch_quote",
      "switch_prepare_swap",
    ]) {
      expect(byName.has(n)).toBe(true);
    }

    // Tier B (v0.1.33)
    for (const n of [
      "pulsex_factory",
      "pulsex_dex_day_data",
      "pulsex_lp_events",
      "hex_global_state",
      "hex_stakes_for_address",
    ]) {
      expect(byName.has(n)).toBe(true);
    }

    // Exact family counts: 3 health + 27 chain + 52 analytics + 14 wallet = 96
    const byCat = (c: string) => meta.filter((t) => t.category === c);
    expect(byCat("health").length).toBe(3);
    expect(byCat("chain").length).toBe(27);
    expect(byCat("wallet").length).toBe(WALLET_TOOL_NAMES.length);
    const analytics = byCat("analytics");
    // free + advanced + PulseX + DexScreener + Tier A (11) + Tier B
    // PulseX: 8 low-level + 3 Tier B factory/day/lp = 11 starting with pulsex_
    // + 2 hex_* Tier B; Tier A: 7 prior + 2 Piteas + 2 Switch
    expect(analytics.length).toBe(11 + 9 + 8 + 6 + 2 + 11 + 5);
    expect(FREE_ANALYTICS).toHaveLength(11);
    expect(ADVANCED_ANALYTICS).toHaveLength(9);
    expect(WALLET_TOOL_NAMES).toHaveLength(14);
    expect(WALLET_WRITE_TOOL_NAMES).toHaveLength(9);
    const pulsexSubgraph = analytics.filter((t) =>
      t.name.startsWith("pulsex_"),
    );
    expect(pulsexSubgraph.length).toBe(11);
    const dexscreenerTools = analytics.filter((t) =>
      t.name.startsWith("dexscreener_"),
    );
    expect(dexscreenerTools.length).toBe(6);
    expect(meta.find((t) => t.name === "phiat_dashboard")?.write).toBe(false);
    expect(meta.find((t) => t.name === "piteas_accumulation_plan")?.write).toBe(false);

    // Categories present
    const categories = new Set(meta.map((t) => t.category));
    expect(categories.has("health")).toBe(true);
    expect(categories.has("chain")).toBe(true);
    expect(categories.has("analytics")).toBe(true);
    expect(categories.has("wallet")).toBe(true);

    // Canonical chain tools carry category=chain
    for (const n of CHAIN_CANONICAL) {
      const t = meta.find((m) => m.name === n);
      expect(t?.category).toBe("chain");
    }

    // Write tools flagged + gated
    const writeTools = meta.filter((t) => t.write);
    expect(writeTools.length).toBe(WALLET_WRITE_TOOL_NAMES.length);
    for (const n of WALLET_WRITE_TOOL_NAMES) {
      expect(writeTools.some((t) => t.name === n)).toBe(true);
    }

    // No duplicate names
    expect(new Set(meta.map((t) => t.name)).size).toBe(meta.length);
  });

  it("createServer constructs McpServer and registers tools offline", async () => {
    const { createServer } = await import("../src/server.js");
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      LOG_LEVEL: "error",
    });

    const server = createServer(cfg);
    expect(server).toBeTruthy();

    const tools = getRegisteredTools();
    expect(tools.length).toBe(REGISTERED_TOOL_COUNT_RESEARCH_ONLY);
    expect(tools.some((t) => t.name === "get_rpc_health")).toBe(true);
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("pulsechain_health");
    expect(names).toContain("get_token_price");
    expect(names).toContain("pulsex_quote");
    expect(names).toContain("agent_wallet_status");
    expect(names).toContain("check_address_risk");
    expect(names).toContain("dexscreener_search");
    expect(names).toContain("dexscreener_token_pairs");
    expect(names).toContain("phiat_dashboard");
    expect(names).toContain("piteas_accumulation_plan");
    for (const n of WALLET_WRITE_TOOL_NAMES) {
      expect(names).not.toContain(n);
    }
    // No duplicate names
    expect(new Set(names).size).toBe(names.length);
  });

  it("registerTool passes SDK annotations from the write flag", async () => {
    const configs = new Map<string, { annotations?: Record<string, unknown> }>();
    const server = {
      registerTool: (
        name: string,
        config: { annotations?: Record<string, unknown> },
      ) => {
        configs.set(name, config);
      },
    };

    const { registerTool } = await import("../src/tools/define.js");
    resetToolRegistry();

    registerTool(server as never, walletsOnConfig, {
      name: "get_token_price",
      description: "read",
      category: "analytics",
      inputSchema: {},
      handler: async () => ({}),
    });
    registerTool(server as never, walletsOnConfig, {
      name: "transfer_pls",
      description: "write",
      category: "wallet",
      write: true,
      inputSchema: {},
      handler: async () => ({}),
    });
    registerTool(server as never, walletsOnConfig, {
      name: "prepare_swap",
      description: "unsigned prepare",
      category: "chain",
      write: false,
      inputSchema: {},
      handler: async () => ({}),
    });

    const readOnly = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    };
    const writeAnns = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };
    expect(configs.get("get_token_price")?.annotations).toEqual(readOnly);
    expect(configs.get("transfer_pls")?.annotations).toEqual(writeAnns);
    expect(configs.get("prepare_swap")?.annotations).toEqual(readOnly);
  });

  it("registerAllTools annotates unsigned prepare as read-only vs wallet writes", () => {
    const configs = new Map<string, { annotations?: Record<string, unknown> }>();
    const server = {
      registerTool: (
        name: string,
        config: { annotations?: Record<string, unknown> },
      ) => {
        configs.set(name, config);
      },
    };
    resetToolRegistry();
    registerAllTools(server as never, walletsOnConfig);
    expect(getRegisteredTools().length).toBe(REGISTERED_TOOL_COUNT_WALLETS_ON);

    const readOnly = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    };
    const writeAnns = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };

    for (const name of [
      "prepare_transaction",
      "prepare_swap",
      "piteas_prepare_swap",
      "switch_prepare_swap",
      "get_token_price",
      "agent_wallet_status",
    ] as const) {
      expect(configs.get(name)?.annotations, name).toEqual(readOnly);
    }
    for (const name of WALLET_WRITE_TOOL_NAMES) {
      expect(configs.get(name)?.annotations, name).toEqual(writeAnns);
    }
  });

  it("createServer instructions branch on agentWalletEnabled", async () => {
    const { createServer, mcpServerInstructions } = await import(
      "../src/server.js"
    );
    const { createMcpHandler } = await import("@modelcontextprotocol/server");

    const researchCfg: AppConfig = { ...smokeConfig, agentWalletEnabled: false };
    const walletCfg: AppConfig = { ...smokeConfig, agentWalletEnabled: true };

    const researchServer = createServer(researchCfg);
    const walletServer = createServer(walletCfg);
    expect(researchServer).toBeTruthy();
    expect(walletServer).toBeTruthy();
    expect(mcpServerInstructions(false)).not.toBe(mcpServerInstructions(true));
    expect(mcpServerInstructions(false)).toMatch(
      /pulsechain:\/\/guidance\/ro-research/,
    );
    expect(mcpServerInstructions(true)).toMatch(/funding authorizes/i);

    async function instructionsFromInitialize(
      cfg: AppConfig,
    ): Promise<string> {
      const handler = createMcpHandler(() => createServer(cfg), {
        legacy: "stateless",
      });
      const res = await handler.fetch(
        new Request("http://test.local/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "smoke-instructions", version: "0.0.0" },
            },
          }),
        }),
      );
      const text = await res.text();
      let body: { result?: { instructions?: string } };
      if (text.trimStart().startsWith("event:")) {
        const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
        body = dataLine
          ? (JSON.parse(dataLine.slice(5).trim()) as {
              result?: { instructions?: string };
            })
          : {};
      } else {
        body = JSON.parse(text) as { result?: { instructions?: string } };
      }
      return body.result?.instructions ?? "";
    }

    const ro = await instructionsFromInitialize(researchCfg);
    const wallets = await instructionsFromInitialize(walletCfg);
    expect(ro).toMatch(/analytics and chain reads/i);
    expect(ro).toMatch(/Write and signing tools refuse/i);
    expect(ro).toMatch(/are not listed/i);
    expect(ro).toMatch(/pulsechain:\/\/guidance\/ro-research/);
    expect(ro).toMatch(/does not sign or broadcast/i);
    expect(wallets).toMatch(/operator-trust agent wallets/i);
    expect(wallets).toMatch(/funding authorizes/i);
    expect(wallets).toMatch(/confirm=true \/ MRTR is host UX only/i);
  });

  it("lists tool names via registry export (import-only smoke)", async () => {
    const { getRegisteredTools: getTools, resetToolRegistry: reset } =
      await import("../src/tools/define.js");
    const { registerAllTools: register } = await import(
      "../src/tools/registry.js"
    );
    reset();
    const { names, server } = mockServer();
    register(server as never, smokeConfig);
    const listed = getTools().map((t) => t.name);
    expect(listed.length).toBe(names.length);
    expect(listed.every((n) => typeof n === "string" && n.length > 0)).toBe(
      true,
    );
  });

  it("write tools reject when AGENT_WALLET_ENABLED=false (registerTool gate)", async () => {
    type Handler = (args?: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;

    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1];
        if (typeof cb === "function") {
          handlers.set(name, cb as Handler);
        }
      },
    };

    resetToolRegistry();
    registerAllTools(server as never, {
      ...smokeConfig,
      agentWalletEnabled: false,
    });

    const listed = getRegisteredTools().map((t) => t.name);
    expect(listed).toHaveLength(REGISTERED_TOOL_COUNT_RESEARCH_ONLY);
    for (const writeName of WALLET_WRITE_TOOL_NAMES) {
      expect(listed, writeName).not.toContain(writeName);
      expect(handlers.has(writeName), writeName).toBe(false);
    }
    for (const readName of WALLET_READ_TOOL_NAMES) {
      expect(listed).toContain(readName);
    }
    expect(listed).toContain("pulsechain_health");
    expect(listed).toContain("get_token_price");
    expect(listed).toContain("phiat_dashboard");

    const { registerTool } = await import("../src/tools/define.js");
    registerTool(server as never, {
      ...smokeConfig,
      agentWalletEnabled: false,
    }, {
      name: "dummy_write_skipped",
      description: "should not advertise",
      category: "wallet",
      write: true,
      inputSchema: {},
      handler: async () => {
        throw new Error("should not register");
      },
    });
    expect(handlers.has("dummy_write_skipped")).toBe(false);
    expect(getRegisteredTools().map((t) => t.name)).not.toContain(
      "dummy_write_skipped",
    );

    // Defense in depth: if a write tool is registered anyway, invoke still
    // returns POLICY_ERROR. Register while enabled, then flip the shared config.
    const cfg: AppConfig = { ...smokeConfig, agentWalletEnabled: true };
    registerTool(server as never, cfg, {
      name: "dummy_write_tool",
      description: "test write",
      category: "wallet",
      write: true,
      inputSchema: {},
      handler: async () => {
        throw new Error("should not reach handler");
      },
    });
    cfg.agentWalletEnabled = false;
    const execute = handlers.get("dummy_write_tool");
    expect(execute).toBeTypeOf("function");
    const res = await execute!({});
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text) as {
      ok: boolean;
      error?: string;
      code?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("POLICY_ERROR");
    expect(body.error).toMatch(/AGENT_WALLET_ENABLED=false|disabled/i);
    expect(res.content[0]!.text).not.toMatch(/0x[a-fA-F0-9]{64}/);
    expect(res.content[0]!.text).not.toMatch(/"privateKey"\s*:/i);
  });

  it("registerTool strips secrets from handler success and error payloads", async () => {
    type Handler = (args?: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>;
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1];
        if (typeof cb === "function") handlers.set(name, cb as Handler);
      },
    };

    const { registerTool } = await import("../src/tools/define.js");
    const { ok } = await import("../src/utils/result.js");
    resetToolRegistry();

    registerTool(server as never, smokeConfig, {
      name: "test_leaky_success",
      description: "test",
      category: "health",
      inputSchema: {},
      handler: async () =>
        ok({
          address: "0x0000000000000000000000000000000000000001",
          privateKey: "0x" + "ab".repeat(32),
          nested: { ciphertext: "deadbeef", ok: true },
        }),
    });

    registerTool(server as never, smokeConfig, {
      name: "test_leaky_error",
      description: "test",
      category: "health",
      inputSchema: {},
      handler: async () => {
        throw new Error('privateKey=0x' + "cd".repeat(32) + " boom");
      },
    });

    const success = await handlers.get("test_leaky_success")!();
    const successBody = JSON.parse(success.content[0]!.text) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(successBody.ok).toBe(true);
    expect(successBody.data.privateKey).toBe("[REDACTED]");
    expect(
      (successBody.data.nested as { ciphertext: string }).ciphertext,
    ).toBe("[REDACTED]");
    expect(success.content[0]!.text).not.toContain("abababab");

    const errRes = await handlers.get("test_leaky_error")!();
    expect(errRes.isError).toBe(true);
    expect(errRes.content[0]!.text).toMatch(/\[REDACTED\]/);
    expect(errRes.content[0]!.text).not.toMatch(/0xcdcdcdcd/i);
  });
});

describe("smoke: resources independence (no live network)", () => {
  it("registers required pulsechain:// resources with public-only endpoints", async () => {
    const { resourceUris, resourceHandlers, server } = mockServerWithResources();
    registerResources(server as never, smokeConfig);

    for (const uri of REQUIRED_RESOURCES) {
      expect(resourceUris).toContain(uri);
    }

    // chain/config must expose public hosts only — never openpulsechain backends
    const chainHandler = resourceHandlers.get("pulsechain://chain/config");
    expect(chainHandler).toBeTypeOf("function");
    const chainRes = await chainHandler!(new URL("pulsechain://chain/config"));
    const chainJson = JSON.parse(chainRes.contents[0]!.text) as {
      defaults: {
        rpcUrl: string;
        explorerApi: string;
        subgraphs: { pulsexV1: string; pulsexV2: string };
      };
      active: { agentWalletEnabled: boolean };
    };
    expect(chainJson.defaults.rpcUrl).toBe(DEFAULT_RPC_URL);
    expect(chainJson.defaults.explorerApi).toBe(DEFAULT_EXPLORER_API);
    expect(chainJson.defaults.subgraphs.pulsexV1).toBe(
      DEFAULT_PULSEX_SUBGRAPH_V1,
    );
    expect(chainJson.defaults.subgraphs.pulsexV2).toBe(
      DEFAULT_PULSEX_SUBGRAPH_V2,
    );
    expect(chainJson.active.agentWalletEnabled).toBe(false);
    const blob = JSON.stringify(chainJson).toLowerCase();
    expect(blob).not.toContain("openpulsechain");
    expect(blob).not.toContain("masterkey");
    expect(blob).not.toContain("privatekey");

    const tokensHandler = resourceHandlers.get("pulsechain://tokens/core");
    const tokensRes = await tokensHandler!(new URL("pulsechain://tokens/core"));
    const tokens = JSON.parse(tokensRes.contents[0]!.text) as Record<
      string,
      { address: string }
    >;
    expect(tokens.WPLS?.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

    const contractsHandler = resourceHandlers.get(
      "pulsechain://contracts/popular",
    );
    const contractsRes = await contractsHandler!(
      new URL("pulsechain://contracts/popular"),
    );
    const contracts = JSON.parse(contractsRes.contents[0]!.text) as {
      multicall3: string;
    };
    expect(contracts.multicall3).toMatch(/^0x[a-fA-F0-9]{40}$/);

    const roHandler = resourceHandlers.get("pulsechain://guidance/ro-research");
    expect(roHandler).toBeTruthy();
    const roRes = await roHandler!(new URL("pulsechain://guidance/ro-research"));
    const ro = JSON.parse(roRes.contents[0]!.text) as {
      principles: string[];
      toolPreference: Record<string, string>;
      epNamingRules: string[];
    };
    expect(ro.toolPreference.discovery).toMatch(/discovery-only|dexscreener_search/i);
    expect(ro.epNamingRules.join(" ")).toMatch(/pHEX/);
    expect(JSON.stringify(ro)).toMatch(/Address identity always beats ticker/i);
  });

  it("defaults point only at public PulseChain infrastructure hosts", () => {
    expect(DEFAULT_RPC_URL).toBe("https://rpc-pulsechain.g4mm4.io");
    expect(DEFAULT_RPC_URLS).toContain("https://rpc-pulsechain.g4mm4.io");
    expect(DEFAULT_RPC_URLS).toContain("https://rpc.pulsechain.com");
    expect(DEFAULT_RPC_URLS).toContain("https://pulsechain.publicnode.com");
    expect(DEFAULT_RPC_URLS).toContain("https://rpc.pulsechainstats.com");
    expect(DEFAULT_RPC_URLS.indexOf("https://rpc.pulsechainstats.com")).toBeGreaterThan(
      DEFAULT_RPC_URLS.indexOf("https://pulsechain.publicnode.com"),
    );
    expect(DEFAULT_EXPLORER_API).toContain("api.scan.pulsechain.com");
    expect(DEFAULT_PULSEX_SUBGRAPH_V1).toContain("graph.pulsechain.com");
    expect(DEFAULT_PULSEX_SUBGRAPH_V2).toContain("graph.pulsechain.com");
    for (const u of [
      ...DEFAULT_RPC_URLS,
      DEFAULT_EXPLORER_API,
      DEFAULT_PULSEX_SUBGRAPH_V1,
      DEFAULT_PULSEX_SUBGRAPH_V2,
    ]) {
      expect(u.toLowerCase()).not.toContain("openpulsechain");
    }
  });

  it("rpc/status resource lists configured multi-RPC endpoints", async () => {
    const { resourceHandlers, server } = mockServerWithResources();
    const multi: AppConfig = {
      ...smokeConfig,
      rpcUrl: "http://127.0.0.1:8545",
      rpcUrls: [
        "http://127.0.0.1:8545",
        "https://rpc-pulsechain.g4mm4.io",
        "https://rpc.pulsechain.com",
      ],
    };
    registerResources(server as never, multi);
    const handler = resourceHandlers.get("pulsechain://rpc/status");
    expect(handler).toBeTypeOf("function");
    const res = await handler!(new URL("pulsechain://rpc/status"));
    const body = JSON.parse(res.contents[0]!.text) as {
      rpcUrls: string[];
      primaryRpcUrl: string;
      activeRpcUrl: string | null;
    };
    expect(body.primaryRpcUrl).toBe("http://127.0.0.1:8545");
    expect(body.rpcUrls).toContain("https://rpc-pulsechain.g4mm4.io");
    expect(body.rpcUrls[0]).toBe("http://127.0.0.1:8545");
  });
});
