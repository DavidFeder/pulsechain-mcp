import type { ToolResult } from "../types.js";
import { toErrorCode, toErrorMessage } from "./errors.js";
import { stripSecrets } from "./safety.js";

export function ok<T>(data: T, warnings?: string[]): ToolResult<T> {
  const result: ToolResult<T> = { ok: true, data };
  if (warnings && warnings.length > 0) {
    result.warnings = warnings;
  }
  return result;
}

/**
 * Fail-closed tool result. Error strings are scrubbed so accidental secret
 * material in exception messages never reaches MCP clients.
 */
export function fail(error: unknown, code?: string): ToolResult<never> {
  return {
    ok: false,
    error: stripSecrets(toErrorMessage(error)),
    code: code ?? toErrorCode(error),
  };
}

/** Serialize tool result as MCP text content payload. */
export function toTextContent(result: ToolResult): string {
  return JSON.stringify(result, null, 2);
}

/** Build standard MCP tool response from a ToolResult. */
export function toMcpToolResponse(result: ToolResult): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const response: {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  } = {
    content: [{ type: "text" as const, text: toTextContent(result) }],
  };
  if (!result.ok) {
    response.isError = true;
  }
  return response;
}
