import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

/**
 * Minimal view of client identity carried on modern (2026-07-28) requests.
 * On legacy connections the SDK may leave envelope undefined; callers must not
 * treat missing fields as errors when dual-serving.
 */
export interface ClientRequestMeta {
  /** Protocol revision claimed on the request envelope (e.g. "2026-07-28"). */
  protocolVersion?: string;
  clientInfo?: { name?: string; version?: string; [k: string]: unknown };
  clientCapabilities?: Record<string, unknown>;
}

/**
 * Read protocol version / clientInfo / clientCapabilities from the per-request
 * `_meta` envelope the SDK lifts onto `ctx.mcpReq.envelope`.
 *
 * Preferred over initialize-scoped `getClientVersion()` / `getClientCapabilities()`
 * (deprecated for modern era). Safe when ctx or envelope is absent.
 */
export function readClientRequestMeta(
  ctx: { mcpReq?: { envelope?: Record<string, unknown> } } | undefined,
): ClientRequestMeta {
  const envelope = ctx?.mcpReq?.envelope;
  if (!envelope || typeof envelope !== "object") {
    return {};
  }

  const protocolVersion = envelope[PROTOCOL_VERSION_META_KEY];
  const clientInfo = envelope[CLIENT_INFO_META_KEY];
  const clientCapabilities = envelope[CLIENT_CAPABILITIES_META_KEY];

  return {
    protocolVersion:
      typeof protocolVersion === "string" ? protocolVersion : undefined,
    clientInfo:
      clientInfo && typeof clientInfo === "object"
        ? (clientInfo as ClientRequestMeta["clientInfo"])
        : undefined,
    clientCapabilities:
      clientCapabilities && typeof clientCapabilities === "object"
        ? (clientCapabilities as Record<string, unknown>)
        : undefined,
  };
}
