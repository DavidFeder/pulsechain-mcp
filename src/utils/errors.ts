/** Application error types mapped to actionable MCP messages */

export class AppError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code = "APP_ERROR", status?: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}

export class RpcError extends AppError {
  constructor(message: string, status?: number) {
    super(
      `RPC error: ${message}. Check PULSECHAIN_RPC_URLS (or PULSECHAIN_RPC_URL), ` +
        `network connectivity, and pulsechain_status / pulsechain://rpc/status for active endpoint.`,
      "RPC_ERROR",
      status,
    );
    this.name = "RpcError";
  }
}

export class ExplorerError extends AppError {
  constructor(message: string, status?: number) {
    super(
      `Explorer API error: ${message}. Base: api.scan.pulsechain.com (BlockScout).`,
      "EXPLORER_ERROR",
      status,
    );
    this.name = "ExplorerError";
  }
}

export class SubgraphError extends AppError {
  constructor(message: string, status?: number) {
    super(
      `Subgraph error: ${message}. Verify PULSEX_SUBGRAPH_V1/V2 endpoints.`,
      "SUBGRAPH_ERROR",
      status,
    );
    this.name = "SubgraphError";
  }
}

export class PolicyError extends AppError {
  constructor(message: string) {
    super(message, "POLICY_ERROR");
    this.name = "PolicyError";
  }
}

export class TimeoutError extends AppError {
  constructor(resource: string, timeoutMs?: number) {
    const timing =
      timeoutMs !== undefined && timeoutMs > 0
        ? ` after ${timeoutMs}ms`
        : "";
    super(
      `Request to ${resource} timed out${timing}. Retry, check RPC health, or raise HTTP_TIMEOUT_MS.`,
      "TIMEOUT",
    );
    this.name = "TimeoutError";
  }
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function toErrorCode(err: unknown, fallback = "ERROR"): string {
  if (err instanceof AppError) return err.code;
  return fallback;
}

/**
 * Map low-level fetch / RPC / GraphQL failures into AppError subclasses.
 */
export function mapUnknownError(err: unknown, context: string): AppError {
  if (err instanceof AppError) return err;

  const msg = toErrorMessage(err);
  const lower = msg.toLowerCase();

  if (
    lower.includes("abort") ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return new TimeoutError(context);
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("all rpc endpoints failed")
  ) {
    return new AppError(
      `${context}: network failure (${msg}). ` +
        `Check connectivity, PULSECHAIN_RPC_URLS order, and whether local nodes are running.`,
      "NETWORK_ERROR",
    );
  }
  if (lower.includes("graphql") || lower.includes("subgraph")) {
    return new SubgraphError(msg);
  }
  if (lower.includes("rpc") || lower.includes("json-rpc") || lower.includes("http 429") || lower.includes("http 5")) {
    return new RpcError(msg);
  }
  if (lower.includes("policy") || lower.includes("confirm=true") || lower.includes("kill switch")) {
    return new PolicyError(msg);
  }

  return new AppError(`${context}: ${msg}`, "APP_ERROR");
}
