/**
 * Protocol bootstrap tests for dual-era MCP (2026-07-28 + 2025-11-25).
 * Drives createMcpHandler in-process (no live sockets).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";
import { PROTOCOL_MODE, SERVER_NAME, SERVER_VERSION } from "../src/constants.js";
import { resetToolRegistry } from "../src/tools/define.js";
import { readClientRequestMeta } from "../src/utils/requestMeta.js";
import type { AppConfig } from "../src/types.js";
import {
  REGISTERED_TOOL_COUNT_RESEARCH_ONLY,
  REGISTERED_TOOL_COUNT_WALLETS_ON,
  WALLET_READ_TOOL_NAMES,
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
  agentWalletDir: "./data/wallets-protocol-smoke",
  agentWalletMultiprocStrict: false,
  maxPlsPerTx: 100,
  maxPlsDaily: 1000,
  httpTransportPort: undefined,
  logLevel: "error",
  httpTimeoutMs: 5_000,
};

function modernEnvelope(): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    [CLIENT_INFO_META_KEY]: { name: "protocol-bootstrap-test", version: "0.0.0" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
}

async function mcpRpc(
  handler: { fetch: (req: Request) => Promise<Response> },
  method: string,
  params: Record<string, unknown> = {},
  opts: { modern?: boolean; id?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const modern = opts.modern !== false;
  const id = opts.id ?? 1;
  const rpcParams = modern
    ? { ...params, _meta: modernEnvelope() }
    : { ...params };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (modern) {
    headers["MCP-Protocol-Version"] = "2026-07-28";
    headers["Mcp-Method"] = method;
    headers["Mcp-Name"] = method.includes("/")
      ? method.split("/").pop()!
      : method;
  }

  const res = await handler.fetch(
    new Request("http://test.local/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: rpcParams,
      }),
    }),
  );

  const text = await res.text();
  // Legacy path may return SSE; modern createMcpHandler often returns JSON.
  let body: Record<string, unknown>;
  if (text.trimStart().startsWith("event:")) {
    const dataLine = text
      .split("\n")
      .find((l) => l.startsWith("data:"));
    body = dataLine
      ? (JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>)
      : { raw: text };
  } else {
    body = JSON.parse(text) as Record<string, unknown>;
  }
  return { status: res.status, body };
}

afterEach(() => {
  resetToolRegistry();
});

describe("protocol bootstrap: dual-era createMcpHandler", () => {
  it("documents achieved dual protocol mode", () => {
    expect(PROTOCOL_MODE).toBe("dual:2026-07-28+2025-11-25");
  });

  it("pins MCP TypeScript SDK to exact stable 2.0.0 (not beta)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = process.cwd();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@modelcontextprotocol/server"]).toBe("2.0.0");
    expect(pkg.dependencies["@modelcontextprotocol/node"]).toBe("2.0.0");
    expect(pkg.devDependencies["@modelcontextprotocol/codemod"]).toBe("2.0.0");
    expect(pkg.dependencies["@modelcontextprotocol/server"]).not.toMatch(/beta|alpha|rc/i);
    // Prove the installed package is loadable and exports dual-era handlers used by the app
    expect(typeof createMcpHandler).toBe("function");
    const lock = JSON.parse(
      readFileSync(join(root, "package-lock.json"), "utf8"),
    ) as { packages: Record<string, { version?: string }> };
    expect(lock.packages["node_modules/@modelcontextprotocol/server"]?.version).toBe(
      "2.0.0",
    );
    expect(lock.packages["node_modules/@modelcontextprotocol/node"]?.version).toBe(
      "2.0.0",
    );
    expect(lock.packages["node_modules/@modelcontextprotocol/core"]?.version).toBe(
      "2.0.0",
    );
  });

  it("answers server/discover with tools+resources capabilities and serverInfo _meta", async () => {
    const handler = createMcpHandler(() => createServer(smokeConfig), {
      legacy: "stateless",
    });

    const { status, body } = await mcpRpc(handler, "server/discover");
    expect(status).toBe(200);

    const result = body.result as Record<string, unknown>;
    expect(result).toBeTruthy();
    expect(result.supportedVersions).toEqual(
      expect.arrayContaining(["2026-07-28"]),
    );

    const capabilities = result.capabilities as {
      tools?: unknown;
      resources?: unknown;
    };
    expect(capabilities.tools).toBeTruthy();
    expect(capabilities.resources).toBeTruthy();

    const meta = result._meta as Record<string, unknown>;
    expect(meta[SERVER_INFO_META_KEY]).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
  });

  it("research-only tools/list omits writes and stamps serverInfo", async () => {
    const handler = createMcpHandler(() => createServer(smokeConfig), {
      legacy: "stateless",
    });

    const toolsRes = await mcpRpc(handler, "tools/list");
    expect(toolsRes.status).toBe(200);
    const toolsResult = toolsRes.body.result as {
      tools: Array<{ name: string; annotations?: Record<string, unknown> }>;
      _meta?: Record<string, unknown>;
    };
    expect(toolsResult.tools.length).toBe(REGISTERED_TOOL_COUNT_RESEARCH_ONLY);
    expect(toolsResult._meta?.[SERVER_INFO_META_KEY]).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });

    const names = new Set(toolsResult.tools.map((t) => t.name));
    expect(names.has("pulsechain_health")).toBe(true);
    expect(names.has("phiat_dashboard")).toBe(true);
    expect(names.has("get_token_price")).toBe(true);
    for (const n of WALLET_READ_TOOL_NAMES) {
      expect(names.has(n)).toBe(true);
    }
    for (const n of WALLET_WRITE_TOOL_NAMES) {
      expect(names.has(n)).toBe(false);
    }

    const byName = new Map(toolsResult.tools.map((t) => [t.name, t]));
    expect(byName.get("get_token_price")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get("prepare_swap")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get("transfer_pls")).toBeUndefined();

    const resourcesRes = await mcpRpc(handler, "resources/list");
    expect(resourcesRes.status).toBe(200);
    const resourcesResult = resourcesRes.body.result as {
      resources: Array<{ uri: string }>;
    };
    const uris = resourcesResult.resources.map((r) => r.uri).sort();
    expect(uris).toEqual(
      [
        "pulsechain://chain/config",
        "pulsechain://contracts/popular",
        "pulsechain://guidance/ro-research",
        "pulsechain://network",
        "pulsechain://rpc/status",
        "pulsechain://tokens/core",
      ].sort(),
    );
  });

  it("wallets-on tools/list is 96 and annotates writes vs unsigned prepare", async () => {
    const walletsOn: AppConfig = { ...smokeConfig, agentWalletEnabled: true };
    const handler = createMcpHandler(() => createServer(walletsOn), {
      legacy: "stateless",
    });

    const toolsRes = await mcpRpc(handler, "tools/list");
    expect(toolsRes.status).toBe(200);
    const toolsResult = toolsRes.body.result as {
      tools: Array<{ name: string; annotations?: Record<string, unknown> }>;
      _meta?: Record<string, unknown>;
    };
    expect(toolsResult.tools.length).toBe(REGISTERED_TOOL_COUNT_WALLETS_ON);
    expect(toolsResult._meta?.[SERVER_INFO_META_KEY]).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });

    const byName = new Map(toolsResult.tools.map((t) => [t.name, t]));
    expect(byName.get("get_token_price")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get("transfer_pls")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(byName.get("prepare_swap")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    for (const n of WALLET_WRITE_TOOL_NAMES) {
      expect(byName.has(n), n).toBe(true);
    }
  });

  it("serves legacy initialize (2025-11-25 dual path) without modern envelope", async () => {
    const handler = createMcpHandler(() => createServer(smokeConfig), {
      legacy: "stateless",
    });

    const { status, body } = await mcpRpc(
      handler,
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-client", version: "1.0.0" },
      },
      { modern: false },
    );

    expect(status).toBe(200);
    const result = body.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: { tools?: unknown; resources?: unknown };
    };
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.serverInfo).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });
    expect(result.capabilities.tools).toBeTruthy();
    expect(result.capabilities.resources).toBeTruthy();
  });

  it("readClientRequestMeta extracts protocolVersion/clientInfo/clientCapabilities", () => {
    const meta = readClientRequestMeta({
      mcpReq: {
        envelope: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: { name: "c", version: "2" },
          [CLIENT_CAPABILITIES_META_KEY]: { experimental: {} },
        },
      },
    });
    expect(meta.protocolVersion).toBe("2026-07-28");
    expect(meta.clientInfo).toEqual({ name: "c", version: "2" });
    expect(meta.clientCapabilities).toEqual({ experimental: {} });
    expect(readClientRequestMeta(undefined)).toEqual({});
  });

  it("createMcpHandler factory builds a fresh server per request (no sticky session)", async () => {
    let builds = 0;
    const handler = createMcpHandler(
      () => {
        builds += 1;
        return createServer(smokeConfig);
      },
      { legacy: "stateless" },
    );

    await mcpRpc(handler, "server/discover", {}, { id: 1 });
    await mcpRpc(handler, "tools/list", {}, { id: 2 });
    await mcpRpc(handler, "resources/list", {}, { id: 3 });

    // Stateless dual path: each modern request gets its own McpServer instance.
    expect(builds).toBeGreaterThanOrEqual(3);
    // No app-level Mcp-Session-Id required — discover works without session headers.
    const { status, body } = await mcpRpc(handler, "server/discover", {}, {
      id: 4,
    });
    expect(status).toBe(200);
    expect((body.result as { supportedVersions?: string[] }).supportedVersions)
      .toEqual(expect.arrayContaining(["2026-07-28"]));
  });
});
