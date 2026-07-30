import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  PULSECHAIN_CHAIN_ID,
  PULSECHAIN_TESTNET_CHAIN_ID,
  SERVER_NAME,
  SERVER_VERSION,
} from "../constants.js";
import {
  getActiveRpcUrl,
  getRpcStatusSnapshot,
  probeRpcEndpoints,
} from "../data/rpc.js";
import type { AppConfig, HealthStatus } from "../types.js";
import { ok } from "../utils/result.js";
import { registerTool } from "./define.js";

function chainIdFor(cfg: AppConfig): number {
  return cfg.network === "testnet"
    ? PULSECHAIN_TESTNET_CHAIN_ID
    : PULSECHAIN_CHAIN_ID;
}

function buildHealth(cfg: AppConfig): HealthStatus {
  return {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    chainId: chainIdFor(cfg),
    network: cfg.network,
    rpcUrl: cfg.rpcUrl,
    rpcUrls: [...cfg.rpcUrls],
    activeRpcUrl: getActiveRpcUrl(),
    explorerApi: cfg.explorerApi,
    pulseXSubgraphV1Configured: Boolean(cfg.pulseXSubgraphV1),
    pulseXSubgraphV2Configured: Boolean(cfg.pulseXSubgraphV2),
    agentWalletEnabled: cfg.agentWalletEnabled,
    httpTransportEnabled: cfg.httpTransportPort !== undefined,
  };
}

/**
 * Health / status tools — no secrets in output.
 * Multi-RPC list + active endpoint are included; no private keys.
 */
export function registerHealthTools(
  server: McpServer,
  config: AppConfig,
): void {
  registerTool(server, config, {
    name: "pulsechain_health",
    description:
      "Report PulseChain MCP health: chain id, multi-RPC list and active endpoint, explorer/subgraph flags, agent wallet enabled. Never returns secrets.",
    category: "health",
    inputSchema: {},
    handler: async (_args, cfg) => {
      return ok(buildHealth(cfg));
    },
  });

  registerTool(server, config, {
    name: "pulsechain_status",
    description:
      "Alias of pulsechain_health with optional verbose subgraph hosts and full RPC endpoint health (no secrets). Prefer get_rpc_health for dedicated RPC monitoring.",
    category: "health",
    inputSchema: {
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include subgraph hosts and per-RPC health details"),
    },
    handler: async (args, cfg) => {
      const verbose = Boolean(args.verbose);
      const base: HealthStatus & {
        subgraphHosts?: { v1?: string; v2?: string };
        rpc?: ReturnType<typeof getRpcStatusSnapshot>;
      } = buildHealth(cfg);
      if (verbose) {
        base.subgraphHosts = {
          v1: safeHost(cfg.pulseXSubgraphV1),
          v2: safeHost(cfg.pulseXSubgraphV2),
        };
        base.rpc = getRpcStatusSnapshot({
          urls: cfg.rpcUrls,
          network: cfg.network,
          primaryRpcUrl: cfg.rpcUrl,
        });
      }
      return ok(base);
    },
  });

  /**
   * Dedicated multi-RPC health monitor (passive + optional light probe).
   * Does not change failover order; only observes / lightly probes.
   */
  registerTool(server, config, {
    name: "get_rpc_health",
    description:
      "Report health of all configured PulseChain RPC endpoints: status " +
      "(healthy | degraded | cool-down | unreachable | unknown), failure counts, " +
      "last success/failure times, latency when known. " +
      "primaryRpcUrl = configured first-priority URL (list order). " +
      "activeRpcUrl = last successful request or probe — not sticky and not a permanent primary " +
      "(probe may set active to the last probed endpoint). Failover still follows list order. " +
      "Default passive (no extra RPC load). Set probe=true for one sequential eth_blockNumber " +
      "per endpoint (max 8) — do not spam. No secrets returned.",
    category: "health",
    inputSchema: {
      probe: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, run one lightweight eth_blockNumber per endpoint (max 8, sequential) then return snapshot",
        ),
    },
    handler: async (args, cfg) => {
      const probe = Boolean(args.probe);
      if (probe) {
        await probeRpcEndpoints({
          urls: cfg.rpcUrls,
          timeoutMs: Math.min(cfg.httpTimeoutMs, 10_000),
          maxProbes: 8,
        });
      }
      const snapshot = getRpcStatusSnapshot({
        urls: cfg.rpcUrls,
        network: cfg.network,
        primaryRpcUrl: cfg.rpcUrl,
      });
      return ok({
        ...snapshot,
        probed: probe,
        hint: probe
          ? "Probe completed (sequential eth_blockNumber). activeRpcUrl may now be the last probed success — primaryRpcUrl remains the configured first priority. Prefer probe=false for routine checks."
          : "Passive snapshot only — status is unknown until endpoints see traffic or you set probe=true. primaryRpcUrl = configured priority; activeRpcUrl = last success.",
      });
    },
  });
}

function safeHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
