import type { LogLevel } from "./types.js";
import { stripSecrets } from "./utils/safety.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

/**
 * Structured logs go to stderr only.
 * MCP stdio uses stdout for the JSON-RPC protocol — never write logs there.
 * Meta payloads are scrubbed so private keys / ciphertext never hit stderr.
 */
function write(level: LogLevel, message: string, meta?: unknown): void {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const payload: Record<string, unknown> = {
    ts,
    level,
    msg: message,
  };
  if (meta !== undefined) {
    payload.meta = stripSecrets(meta);
  }
  // Always stderr (including info/debug) so MCP stdout stays clean.
  console.error(JSON.stringify(payload));
}

export const logger = {
  debug: (msg: string, meta?: unknown) => write("debug", msg, meta),
  info: (msg: string, meta?: unknown) => write("info", msg, meta),
  warn: (msg: string, meta?: unknown) => write("warn", msg, meta),
  error: (msg: string, meta?: unknown) => write("error", msg, meta),
};
