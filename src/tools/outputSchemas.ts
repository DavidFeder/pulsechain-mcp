/**
 * MCP `outputSchema` shapes for health + wallet tools (SDK v2 `registerTool`).
 *
 * Matches the existing ToolResult envelope already returned as
 * `structuredContent` by `toMcpToolResponse`. Analytics/chain tools leave
 * `outputSchema` unset.
 *
 * Wallet `data` is a conservative object passthrough — never advertise
 * privateKey / mnemonic / ciphertext fields.
 */
import { z } from "zod";

const pulseNetworkSchema = z.enum(["mainnet", "testnet"]);

const networkMismatchSchema = z.object({
  warning: z.string(),
  explorerApiIsMainnetDefault: z.boolean(),
  pulseXSubgraphV1IsMainnetDefault: z.boolean(),
  pulseXSubgraphV2IsMainnetDefault: z.boolean(),
});

const rpcHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "cool-down",
  "unreachable",
  "unknown",
]);

const rpcEndpointStatusSchema = z.object({
  url: z.string(),
  status: rpcHealthStatusSchema,
  healthy: z.boolean(),
  failures: z.number(),
  lastError: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  lastFailureAt: z.string().optional(),
  cooldownUntil: z.string().optional(),
  lastLatencyMs: z.number().optional(),
  avgLatencyMs: z.number().optional(),
  isActive: z.boolean().optional(),
});

const rpcStatusSnapshotSchema = z.object({
  network: pulseNetworkSchema,
  chainId: z.number(),
  rpcUrls: z.array(z.string()),
  primaryRpcUrl: z.string(),
  activeRpcUrl: z.string().nullable(),
  endpoints: z.array(rpcEndpointStatusSchema),
  summary: z.object({
    healthy: z.number(),
    degraded: z.number(),
    "cool-down": z.number(),
    unreachable: z.number(),
    unknown: z.number(),
  }),
  priorityNote: z.string(),
  checkedAt: z.string(),
});

/** HealthStatus plus optional pulsechain_status verbose extras. */
export const healthStatusDataSchema = z.object({
  server: z.string(),
  version: z.string(),
  chainId: z.number(),
  network: pulseNetworkSchema,
  rpcUrl: z.string(),
  rpcUrls: z.array(z.string()),
  activeRpcUrl: z.string().nullable(),
  explorerApi: z.string(),
  pulseXSubgraphV1Configured: z.boolean(),
  pulseXSubgraphV2Configured: z.boolean(),
  agentWalletEnabled: z.boolean(),
  httpTransportEnabled: z.boolean(),
  networkMismatch: networkMismatchSchema.optional(),
  subgraphHosts: z
    .object({
      v1: z.string().optional(),
      v2: z.string().optional(),
    })
    .optional(),
  rpc: rpcStatusSnapshotSchema.optional(),
});

/** RpcStatusSnapshot plus get_rpc_health probe fields. */
export const rpcHealthDataSchema = rpcStatusSnapshotSchema.extend({
  probed: z.boolean(),
  hint: z.string(),
  configuredChainId: z.number(),
  rpcChainId: z.number().nullable(),
  rpcChainMatch: z.boolean().nullable(),
  rpcChainError: z.string().optional(),
});

/**
 * Conservative wallet payload. Extra keys pass through; secret field names
 * are intentionally not declared on the schema.
 */
export const walletDataSchema = z.looseObject({});

/** Existing `{ ok, data?, error?, code?, warnings? }` ToolResult envelope. */
export function toolResultEnvelope<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.boolean(),
    data: dataSchema.optional(),
    error: z.string().optional(),
    code: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  });
}

export const healthToolOutputSchema = toolResultEnvelope(healthStatusDataSchema);
export const rpcHealthToolOutputSchema = toolResultEnvelope(rpcHealthDataSchema);
export const walletToolOutputSchema = toolResultEnvelope(walletDataSchema);
