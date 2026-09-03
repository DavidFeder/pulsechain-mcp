#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { logger, setLogLevel } from "./logger.js";
import {
  PROTOCOL_MODE,
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.js";
import {
  describeTransportMode,
  formatFatalStartupHint,
} from "./clientCompat.js";
import {
  chainIdForConfig,
  getActiveRpcUrl,
  getRpcHealthSummary,
} from "./data/rpc.js";
import type { AppConfig } from "./types.js";

/**
 * Primary production path (Claude Desktop / Cursor): dual-era stdio.
 *
 * Uses `serveStdio` from `@modelcontextprotocol/server/stdio` (v2), which
 * owns a process-stdio `StdioServerTransport` and pins era on the opening
 * exchange (2026-07-28 modern or 2025-11-25 legacy). Factory builds one
 * fresh McpServer for that pin.
 *
 * Do **not** hand-wire `server.connect(new StdioServerTransport())` — that
 * is 2025-only even on v2 packages. Refuse legacy only with `{ legacy: 'reject' }`.
 */
function startStdio(config: AppConfig): void {
  serveStdio(() => createServer(config), {
    // Explicit dual: serve 2025-era openings (initialize) on the same process.
    legacy: "serve",
    onerror: (error) => {
      logger.error("stdio transport error", { error: error.message });
    },
  });
  logger.info("MCP server connected (stdio, dual-era)", {
    protocolMode: PROTOCOL_MODE,
    clients: "Cursor / Grok Build / Claude Desktop",
    walletsEnabled: config.agentWalletEnabled,
  });
}

/**
 * Optional Streamable HTTP transport for local testing only.
 * Enabled when HTTP_TRANSPORT_PORT is set. Not for production exposure.
 *
 * Paths: GET /health, POST|GET /mcp (dual-era `createMcpHandler` + `toNodeHandler`).
 * Stateless: no app-level Mcp-Session-Id sticky sessions; each request builds
 * a fresh server instance via the factory.
 *
 * Routable headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, optional
 * `Mcp-Param-*`) are validated/routed by the SDK on the modern path — we do
 * not invent header parsing here.
 */
async function startHttp(config: AppConfig, port: number): Promise<void> {
  const mcpHandler = createMcpHandler(() => createServer(config), {
    // Dual by default; named explicitly for clarity / dual:2026-07-28+2025-11-25.
    legacy: "stateless",
    onerror: (error) => {
      logger.error("HTTP MCP transport error", { error: error.message });
    },
  });
  // Node http adapter; SDK owns Streamable HTTP framing + header routing.
  const nodeHandler = toNodeHandler(mcpHandler);

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      const rpc = getRpcHealthSummary(config.rpcUrls);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          server: SERVER_NAME,
          version: SERVER_VERSION,
          network: config.network,
          chainId: chainIdForConfig(config),
          rpcUrl: config.rpcUrl,
          activeRpcUrl: getActiveRpcUrl() ?? rpc.activeRpcUrl,
          rpcCount: config.rpcUrls.length,
          rpcSummary: rpc.summary,
          agentWalletEnabled: config.agentWalletEnabled,
          protocolMode: PROTOCOL_MODE,
        }),
      );
      return;
    }

    if (url.pathname === "/mcp") {
      await nodeHandler(req, res);
      return;
    }

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => resolve());
  });
  logger.warn(
    `HTTP transport listening on http://127.0.0.1:${port} (local testing only)`,
    { paths: ["/health", "/mcp"], protocolMode: PROTOCOL_MODE },
  );
}

async function main(): Promise<void> {
  // Optional wallet-mode path for sticky hosts that spawn bare dist/index.js:
  // only when a gitignored autoload marker + wallet env file exist.
  // Preferred entry: scripts/start-wallet-mcp.mjs (see docs/SECURITY.md).
  const { applyLabAutoloadIfEnabled } = await import("./labAutoload.js");
  const walletBoot = applyLabAutoloadIfEnabled();
  if (walletBoot.applied) {
    // stderr via console before logger config — never log secrets
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: "wallet autoload applied (marker + env); prefer scripts/start-wallet-mcp.mjs when host allows",
        walletLauncher: true,
        walletDir: walletBoot.walletDir,
      }),
    );
  }

  const config = loadConfig();
  setLogLevel(config.logLevel);

  const transport = describeTransportMode(config.httpTransportPort);
  logger.info(`Starting ${SERVER_NAME} v${SERVER_VERSION}`, {
    network: config.network,
    rpcUrl: config.rpcUrl,
    rpcUrls: config.rpcUrls,
    rpcCount: config.rpcUrls.length,
    agentWalletEnabled: config.agentWalletEnabled,
    httpTransportPort: config.httpTransportPort,
    protocolMode: PROTOCOL_MODE,
    transportMode: transport.mode,
    clientNote: transport.clientNote,
    walletLauncher:
      process.env.PULSECHAIN_WALLET_LAUNCHER === "true" ||
      process.env.PULSECHAIN_LAB_LAUNCHER === "true",
    walletAutoload: walletBoot.applied,
  });

  // When wallets are enabled, claim AGENT_WALLET_DIR ownership marker early so
  // multi-process sharing is warned at startup (not a distributed lock).
  if (config.agentWalletEnabled) {
    const { ensureWalletDirClaimed } = await import("./wallet/owner.js");
    const ownership = ensureWalletDirClaimed(config.agentWalletDir, {
      forceRecheck: true,
    });
    if (ownership.multiProcessRisk) {
      logger.error(
        "AGENT_WALLET_DIR multi-process risk detected — NOT a distributed lock; " +
          "recommended model: one process → one unique AGENT_WALLET_DIR. " +
          (config.agentWalletMultiprocStrict
            ? "AGENT_WALLET_MULTIPROC_STRICT=true: wallet writes will be refused until conflict clears."
            : "Writes still allowed (warn-only). Set AGENT_WALLET_MULTIPROC_STRICT=true to fail closed."),
        {
          walletDir: config.agentWalletDir,
          foreignPid: ownership.owner.pid,
          foreignHost: ownership.owner.hostname,
          status: ownership.status,
          multiprocStrict: config.agentWalletMultiprocStrict,
          multiprocMode: config.agentWalletMultiprocStrict
            ? "strict-fail-closed"
            : "warn-only",
          riskLevel: config.agentWalletMultiprocStrict ? "blocked" : "warn",
          multiProcessRisk: true,
          thisProcessPid: process.pid,
        },
      );
    } else {
      logger.info("Agent wallet directory ownership claimed (process-local locks only)", {
        walletDir: config.agentWalletDir,
        ownershipStatus: ownership.status,
        pid: process.pid,
        multiprocStrict: config.agentWalletMultiprocStrict,
        multiprocMode: config.agentWalletMultiprocStrict
          ? "strict-fail-closed"
          : "warn-only",
        riskLevel: "none",
        recommendedModel: "one process → one unique AGENT_WALLET_DIR",
      });
    }
  }

  if (config.httpTransportPort !== undefined) {
    // Local testing: HTTP only (do not also bind stdio in the same process)
    await startHttp(config, config.httpTransportPort);
    return;
  }

  startStdio(config);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "FATAL";
  // fatal must not use stdout (MCP stdio reserves it) — Cursor/Grok/Claude parse host logs from stderr
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "fatal: server failed to start",
      code,
      error: message,
      hint: formatFatalStartupHint(),
    }),
  );
  process.exit(1);
});
