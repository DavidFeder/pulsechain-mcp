/**
 * MCP outputSchema for health + wallet tools (ToolResult envelope).
 * Analytics/chain tools stay unset. MRTR InputRequired is not schema-validated.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  createMcpHandler,
  isInputRequiredResult,
} from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";
import { registerAllTools } from "../src/tools/registry.js";
import { registerTool, resetToolRegistry } from "../src/tools/define.js";
import { registerHealthTools } from "../src/tools/health.js";
import { registerWalletTools } from "../src/tools/wallet/index.js";
import {
  healthToolOutputSchema,
  rpcHealthToolOutputSchema,
  walletToolOutputSchema,
} from "../src/tools/outputSchemas.js";
import { fail, ok } from "../src/utils/result.js";
import type { AppConfig, ToolResult } from "../src/types.js";
import { testAppConfig } from "./helpers/appConfig.js";
import {
  OUTPUT_SCHEMA_TOOL_NAMES,
  REGISTERED_TOOL_COUNT_RESEARCH_ONLY,
  REGISTERED_TOOL_COUNT_WALLETS_ON,
  WALLET_WRITE_TOOL_NAMES,
} from "./helpers/toolInventory.js";
import {
  createAgentWallet,
  proposeAgentTx,
} from "../src/wallet/service.js";
import * as rpc from "../src/data/rpc.js";
import { resetWalletLocksForTests } from "../src/wallet/lock.js";
import { resetWalletDirOwnershipForTests } from "../src/wallet/owner.js";

const researchConfig = testAppConfig({ agentWalletEnabled: false });
const walletsOnConfig = testAppConfig({ agentWalletEnabled: true });

const tempDirs: string[] = [];

afterEach(() => {
  resetToolRegistry();
  resetWalletLocksForTests();
  resetWalletDirOwnershipForTests();
  vi.restoreAllMocks();
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function modernEnvelope(
  capabilities: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    [CLIENT_INFO_META_KEY]: { name: "output-schema-test", version: "0.0.0" },
    [CLIENT_CAPABILITIES_META_KEY]: capabilities,
  };
}

async function mcpRpc(
  handler: { fetch: (req: Request) => Promise<Response> },
  method: string,
  params: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await handler.fetch(
    new Request("http://test.local/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        "Mcp-Name":
          method === "tools/call" && typeof params.name === "string"
            ? params.name
            : method.includes("/")
              ? method.split("/").pop()!
              : method,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { ...params, _meta: modernEnvelope(capabilities) },
      }),
    }),
  );
  const text = await res.text();
  let body: Record<string, unknown>;
  if (text.trimStart().startsWith("event:")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    body = dataLine
      ? (JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>)
      : { raw: text };
  } else {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
  }
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

type CapturedConfig = {
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

function captureRegisterConfigs(cfg: AppConfig): Map<string, CapturedConfig> {
  const configs = new Map<string, CapturedConfig>();
  const server = {
    registerTool: (name: string, config: CapturedConfig) => {
      configs.set(name, config);
    },
  };
  resetToolRegistry();
  registerAllTools(server as never, cfg);
  return configs;
}

function jsonSchemaText(schema: unknown): string {
  return JSON.stringify(schema ?? {}).toLowerCase();
}

describe("outputSchema registration", () => {
  it("health + wallet tools pass outputSchema; analytics example does not", () => {
    const configs = captureRegisterConfigs(walletsOnConfig);
    expect(configs.size).toBe(REGISTERED_TOOL_COUNT_WALLETS_ON);

    for (const name of OUTPUT_SCHEMA_TOOL_NAMES) {
      expect(configs.get(name)?.outputSchema, name).toBeDefined();
    }
    expect(configs.get("get_token_price")?.outputSchema).toBeUndefined();
    expect(configs.get("prepare_swap")?.outputSchema).toBeUndefined();
    expect(configs.get("pulsechain_get_balance")?.outputSchema).toBeUndefined();

    const walletJson = jsonSchemaText(
      configs.get("create_agent_wallet")?.outputSchema,
    );
    expect(walletJson).not.toContain("privatekey");
    expect(walletJson).not.toContain("mnemonic");
    expect(walletJson).not.toContain("ciphertext");
  });

  it("research-only still lists 87 tools with health/wallet-read schemas", () => {
    const configs = captureRegisterConfigs(researchConfig);
    expect(configs.size).toBe(REGISTERED_TOOL_COUNT_RESEARCH_ONLY);
    expect(configs.get("pulsechain_health")?.outputSchema).toBeDefined();
    expect(configs.get("agent_wallet_status")?.outputSchema).toBeDefined();
    for (const name of WALLET_WRITE_TOOL_NAMES) {
      expect(configs.has(name), name).toBe(false);
    }
    expect(configs.get("get_token_price")?.outputSchema).toBeUndefined();
  });

  it("tools/list advertises JSON outputSchema only on health + wallet", async () => {
    const handler = createMcpHandler(() => createServer(walletsOnConfig), {
      legacy: "stateless",
    });
    const body = await mcpRpc(handler, "tools/list");
    const tools = (body.result as { tools: Array<Record<string, unknown>> })
      .tools;
    expect(tools.length).toBe(REGISTERED_TOOL_COUNT_WALLETS_ON);
    const byName = new Map(tools.map((t) => [t.name as string, t]));

    for (const name of OUTPUT_SCHEMA_TOOL_NAMES) {
      const schema = byName.get(name)?.outputSchema as
        | { type?: string; properties?: Record<string, unknown> }
        | undefined;
      expect(schema, name).toBeDefined();
      expect(schema?.properties?.ok, name).toBeDefined();
    }

    const health = byName.get("pulsechain_health")?.outputSchema as {
      properties?: { data?: { properties?: Record<string, unknown> } };
    };
    expect(health?.properties?.data?.properties?.chainId).toBeDefined();
    expect(health?.properties?.data?.properties?.network).toBeDefined();
    expect(health?.properties?.data?.properties?.networkMismatch).toBeDefined();

    expect(byName.get("get_token_price")?.outputSchema).toBeUndefined();
    expect(byName.get("phiat_dashboard")?.outputSchema).toBeUndefined();

    const listedWallet = jsonSchemaText(
      byName.get("execute_agent_tx")?.outputSchema,
    );
    expect(listedWallet).not.toContain("privatekey");
    expect(listedWallet).not.toContain("mnemonic");
    expect(listedWallet).not.toContain("ciphertext");
  });
});

describe("structuredContent matches outputSchema", () => {
  it("pulsechain_health success envelope has ok/data.chainId/data.network", async () => {
    type Handler = () => Promise<{
      structuredContent?: ToolResult;
      isError?: boolean;
      content: Array<{ text: string }>;
    }>;
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1];
        if (typeof cb === "function") handlers.set(name, cb as Handler);
      },
    };
    registerHealthTools(server as never, researchConfig);
    const res = await handlers.get("pulsechain_health")!();
    expect(res.isError).toBeFalsy();
    const parsed = healthToolOutputSchema.safeParse(res.structuredContent);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.data).toMatchObject({
      chainId: 369,
      network: "mainnet",
    });
  });

  it("SDK tools/call pulsechain_health validates structuredContent (no output error)", async () => {
    const handler = createMcpHandler(() => createServer(researchConfig), {
      legacy: "stateless",
    });
    const body = await mcpRpc(handler, "tools/call", {
      name: "pulsechain_health",
      arguments: {},
    });
    const result = body.result as {
      isError?: boolean;
      structuredContent?: ToolResult<{ chainId?: number; network?: string }>;
      content?: Array<{ text?: string }>;
    };
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/Output validation error/i);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.ok).toBe(true);
    expect(result.structuredContent?.data?.chainId).toBe(369);
    expect(result.structuredContent?.data?.network).toBe("mainnet");
    expect(healthToolOutputSchema.safeParse(result.structuredContent).success).toBe(
      true,
    );
  });

  it("get_rpc_health success matches rpc output schema", async () => {
    type Handler = (args?: Record<string, unknown>) => Promise<{
      structuredContent?: ToolResult;
    }>;
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1];
        if (typeof cb === "function") handlers.set(name, cb as Handler);
      },
    };
    registerHealthTools(server as never, researchConfig);
    const res = await handlers.get("get_rpc_health")!({ probe: false });
    expect(rpcHealthToolOutputSchema.safeParse(res.structuredContent).success).toBe(
      true,
    );
    expect(res.structuredContent?.ok).toBe(true);
  });

  it("fail() envelope still satisfies health and wallet schemas", () => {
    const failed = fail("disabled", "POLICY_ERROR");
    expect(failed.ok).toBe(false);
    expect(healthToolOutputSchema.safeParse(failed).success).toBe(true);
    expect(walletToolOutputSchema.safeParse(failed).success).toBe(true);
    expect(walletToolOutputSchema.safeParse(ok({ address: "0x1" })).success).toBe(
      true,
    );
  });
});

describe("wallet writes vs outputSchema (no InputRequired gate)", () => {
  it("create_agent_wallet succeeds immediately and matches wallet outputSchema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aw-os-"));
    tempDirs.push(dir);
    const cfg = testAppConfig({
      agentWalletEnabled: true,
      agentWalletMasterKey: randomBytes(32).toString("hex"),
      agentWalletDir: dir,
    });
    const handler = createMcpHandler(() => createServer(cfg), {
      legacy: "stateless",
    });
    const body = await mcpRpc(
      handler,
      "tools/call",
      {
        name: "create_agent_wallet",
        arguments: {},
      },
      { elicitation: { form: {} } },
    );
    const result = body.result as Record<string, unknown>;
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/Output validation error/i);
    expect(result.isError).toBeFalsy();
    expect(isInputRequiredResult(result)).toBe(false);
    const parsed = walletToolOutputSchema.safeParse(result.structuredContent);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("execute_agent_tx runs immediately and is not wrapped as InputRequired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aw-os-ex-"));
    tempDirs.push(dir);
    const cfg = testAppConfig({
      agentWalletEnabled: true,
      agentWalletMasterKey: randomBytes(32).toString("hex"),
      agentWalletDir: dir,
    });
    vi.spyOn(rpc, "getPublicClient").mockReturnValue({
      getBytecode: async () => undefined,
    } as never);
    vi.spyOn(rpc, "estimateGas").mockResolvedValue({ gasEstimate: "21000" });
    vi.spyOn(rpc, "ethCall").mockResolvedValue({ data: "0x" });
    vi.spyOn(rpc, "getFeeData").mockResolvedValue({
      gasPriceWei: "100000000000000",
      maxFeePerGas: "100000000000000",
      maxPriorityFeePerGas: "1000000000",
    });
    const { setTestBroadcast } = await import("../src/wallet/service.js");
    setTestBroadcast(async () => ("0x" + "ab".repeat(32)) as `0x${string}`);

    const wallet = await createAgentWallet(cfg);
    const proposal = await proposeAgentTx(cfg, {
      walletId: wallet.id,
      to: "0x0000000000000000000000000000000000000001",
      valuePls: 1,
      data: "0x",
    });

    const handlers = new Map<
      string,
      (args?: Record<string, unknown>, mcpCtx?: unknown) => Promise<unknown>
    >();
    const server = {
      registerTool: (name: string, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1];
        if (typeof cb === "function") {
          handlers.set(
            name,
            cb as (
              args?: Record<string, unknown>,
              mcpCtx?: unknown,
            ) => Promise<unknown>,
          );
        }
      },
    };
    resetToolRegistry();
    registerWalletTools(server as never, cfg);

    const first = await handlers.get("execute_agent_tx")!(
      { proposalId: proposal.id },
      { mcpReq: { envelope: {} } },
    );
    expect(isInputRequiredResult(first)).toBe(false);
    expect(JSON.stringify(first)).not.toMatch(/Output validation error/i);
    const res = first as {
      structuredContent?: { ok?: boolean; data?: { txHash?: string } };
    };
    expect(res.structuredContent?.ok).toBe(true);
    expect(res.structuredContent?.data?.txHash).toMatch(/^0x/);
    setTestBroadcast(null);
  });
});

describe("disabled write fail envelope still matches outputSchema", () => {
  it("dummy write with wallets flipped off returns ok:false POLICY_ERROR", async () => {
    type Handler = (args?: Record<string, unknown>) => Promise<{
      isError?: boolean;
      structuredContent?: ToolResult;
      content: Array<{ text: string }>;
    }>;
    const handlers = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1];
        if (typeof cb === "function") handlers.set(name, cb as Handler);
      },
    };
    const cfg: AppConfig = { ...researchConfig, agentWalletEnabled: true };
    registerTool(server as never, cfg, {
      name: "dummy_write_tool",
      description: "test write",
      category: "wallet",
      write: true,
      inputSchema: {},
      outputSchema: walletToolOutputSchema,
      handler: async () => {
        throw new Error("should not reach handler");
      },
    });
    cfg.agentWalletEnabled = false;
    const res = await handlers.get("dummy_write_tool")!({});
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.ok).toBe(false);
    expect(res.structuredContent?.code).toBe("POLICY_ERROR");
    expect(walletToolOutputSchema.safeParse(res.structuredContent).success).toBe(
      true,
    );
  });
});
