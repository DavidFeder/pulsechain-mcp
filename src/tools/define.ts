import { z } from "zod";
import type {
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { isInputRequiredResult } from "@modelcontextprotocol/server";
import type { AppConfig, ToolCategory, ToolResult } from "../types.js";
import { logger } from "../logger.js";
import { fail, toMcpToolResponse } from "../utils/result.js";
import { stripSecrets, WRITE_TOOL_WARNING } from "../utils/safety.js";
import {
  readClientRequestMeta,
  type ClientRequestMeta,
} from "../utils/requestMeta.js";

/** Loose schema shape compatible with MCP SDK ZodRawShapeCompat */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolInputSchema = Record<string, any>;

/**
 * Optional tool output schema (Zod / Standard Schema) passed through to
 * SDK v2 `registerTool` as `outputSchema`. When set, the SDK advertises the
 * derived JSON Schema on `tools/list` and validates `structuredContent`
 * before the result leaves the server.
 *
 * SDK `validateToolOutput` already skips `InputRequiredResult` elicitation
 * and `isError: true` results — do not invent a second envelope.
 */
export type ToolOutputSchema = StandardSchemaWithJSON;

/**
 * Per-request MCP context for tool handlers (2026-07-28 envelope + MRTR fields).
 * Prefer `client` (from request `_meta`) over initialize-scoped client getters.
 */
export interface ToolHandlerContext {
  /** SDK request context when available (modern HTTP / stdio dual path). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpCtx?: any;
  /** Lifted per-request client identity from `_meta` (may be empty on legacy). */
  client: ClientRequestMeta;
}

export interface RegisterToolOptions {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /**
   * Optional Zod / Standard Schema for `structuredContent`. Unset for
   * analytics/chain tools. Health + wallet pass the ToolResult envelope.
   */
  outputSchema?: ToolOutputSchema;
  handler: (
    args: Record<string, unknown>,
    config: AppConfig,
    /** Optional; present when the SDK supplies a tool callback context. */
    ctx?: ToolHandlerContext,
  ) => Promise<ToolResult | unknown>;
  category: ToolCategory;
  /** When true, tool mutates chain/wallet state — gated by AGENT_WALLET_ENABLED. */
  write?: boolean;
}

export interface RegisteredToolMeta {
  name: string;
  description: string;
  category: ToolCategory;
  write: boolean;
}

const registry: RegisteredToolMeta[] = [];

/**
 * MCP tool annotations from the SDK `ToolAnnotations` shape
 * (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
 * Derived from the existing `write` flag — not a per-tool API.
 *
 * Reads / quotes / unsigned prepare (`write !== true`): read-only, non-destructive,
 * idempotent. Writes (wallet create/policy/propose/execute/transfer/kill/etc.):
 * not read-only, destructive, not idempotent. All tools talk to the network
 * (`openWorldHint: true`).
 */
function toolAnnotationsFromWrite(write: boolean): ToolAnnotations {
  if (write) {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };
  }
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

export function resetToolRegistry(): void {
  registry.length = 0;
}

export function getRegisteredTools(): readonly RegisteredToolMeta[] {
  return registry;
}

/**
 * Unified tool registration for PulseChain MCP.
 * Appends write-tool warnings to descriptions and centralizes error envelopes.
 *
 * Hardening: every success and failure payload is run through stripSecrets so
 * private keys / ciphertext / master-key fields never reach MCP clients even if
 * a handler forgets neverReturnPrivateKey.
 *
 * Uses SDK v2 `server.registerTool` with Zod object schemas (Standard Schema).
 * Local helper name stays `registerTool` (app wrapper) calling the SDK API.
 */
export function registerTool(
  server: McpServer,
  config: AppConfig,
  options: RegisterToolOptions,
): void {
  const { name, inputSchema, handler, category, outputSchema } = options;
  const write = options.write === true;

  // Research-only: do not advertise write/signing tools in tools/list (or the
  // local registry used by tests). The invoke-time POLICY_ERROR below remains
  // defense in depth if a write tool is somehow registered anyway.
  if (write && !config.agentWalletEnabled) {
    return;
  }

  let description = options.description;
  if (write) {
    description = `${description}\n\n⚠️ ${WRITE_TOOL_WARNING}`;
  }

  registry.push({ name, description, category, write });

  const schema =
    Object.keys(inputSchema).length === 0
      ? z.object({})
      : z.object(inputSchema);

  // SDK tool callbacks are (args, ctx). We lift per-request _meta envelope so
  // handlers never need initialize-scoped getClientVersion/getClientCapabilities.
  // Cast keeps us compatible across MCP SDK overload / ctx variants.
  const callback = async (
    args: Record<string, unknown> = {},
    mcpCtx?: unknown,
  ) => {
    try {
      if (write && !config.agentWalletEnabled) {
        return toMcpToolResponse(
          stripSecrets(
            fail(
              `Write tool "${name}" is disabled (AGENT_WALLET_ENABLED=false).`,
              "POLICY_ERROR",
            ),
          ),
        );
      }
      const toolCtx: ToolHandlerContext = {
        mcpCtx,
        client: readClientRequestMeta(
          mcpCtx as { mcpReq?: { envelope?: Record<string, unknown> } },
        ),
      };
      const result = await handler(args, config, toolCtx);
      // Pass through MRTR InputRequiredResult without JSON-wrapping.
      if (isInputRequiredResult(result)) {
        return result;
      }
      return toMcpToolResponse(stripSecrets(result as ToolResult));
    } catch (err) {
      const safeMsg =
        err instanceof Error ? stripSecrets(err.message) : stripSecrets(String(err));
      logger.error(`Tool ${name} failed`, { error: safeMsg });
      return toMcpToolResponse(stripSecrets(fail(err)));
    }
  };

  server.registerTool(
    name,
    {
      description,
      inputSchema: schema,
      annotations: toolAnnotationsFromWrite(write),
      ...(outputSchema ? { outputSchema } : {}),
    },
    callback as never,
  );
}
