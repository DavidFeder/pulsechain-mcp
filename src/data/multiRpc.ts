/**
 * Multi-RPC failover for PulseChain.
 *
 * Tries endpoints in configured order (local → LAN → g4mm4 → public).
 * On each request, cool-down endpoints are skipped (then tried last only if
 * every endpoint is cooling down). Tracks active URL and health for status tools.
 */

import { custom, type Transport } from "viem";
import {
  PULSECHAIN_CHAIN_ID,
  PULSECHAIN_TESTNET_CHAIN_ID,
  RPC_UNHEALTHY_COOLDOWN_MS,
} from "../constants.js";
import { logger } from "../logger.js";
import type {
  PulseNetwork,
  RpcEndpointStatus,
  RpcHealthStatus,
  RpcStatusSnapshot,
} from "../types.js";

/** Latency threshold (ms) above which a successful node is "degraded". */
export const RPC_DEGRADED_LATENCY_MS = 2_500;

/** Consecutive failures before labeling unreachable even after cooldown ends (until success). */
export const RPC_UNREACHABLE_FAILURES = 1;

export interface EndpointHealth {
  failures: number;
  lastError?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  cooldownUntil?: number;
  /** Last success RTT in ms */
  lastLatencyMs?: number;
  /** Exponential moving average of success latency */
  avgLatencyMs?: number;
  successCount?: number;
}

export interface MultiRpcState {
  urls: string[];
  activeUrl: string | null;
  health: Map<string, EndpointHealth>;
  /** Optional injected fetch for tests */
  fetchFn?: typeof fetch;
  cooldownMs: number;
  timeoutMs: number;
}

let state: MultiRpcState | null = null;

export function getMultiRpcState(): MultiRpcState | null {
  return state;
}

export function resetMultiRpcState(): void {
  state = null;
}

/**
 * Initialize or replace multi-RPC tracking state for the given URL list.
 */
export function initMultiRpcState(options: {
  urls: string[];
  timeoutMs: number;
  cooldownMs?: number;
  fetchFn?: typeof fetch;
}): MultiRpcState {
  const prev = state;
  const health = new Map<string, EndpointHealth>();
  for (const url of options.urls) {
    health.set(url, prev?.health.get(url) ?? { failures: 0 });
  }
  state = {
    urls: [...options.urls],
    activeUrl:
      prev?.activeUrl && options.urls.includes(prev.activeUrl)
        ? prev.activeUrl
        : null,
    health,
    fetchFn: options.fetchFn ?? prev?.fetchFn,
    cooldownMs: options.cooldownMs ?? RPC_UNHEALTHY_COOLDOWN_MS,
    timeoutMs: options.timeoutMs,
  };
  return state;
}

/** Test hook: inject fetch implementation used by multi-RPC transport. */
export function setMultiRpcFetch(fetchFn: typeof fetch | undefined): void {
  if (state) {
    state.fetchFn = fetchFn;
  } else {
    state = {
      urls: [],
      activeUrl: null,
      health: new Map(),
      fetchFn,
      cooldownMs: RPC_UNHEALTHY_COOLDOWN_MS,
      timeoutMs: 30_000,
    };
  }
}

function now(): number {
  return Date.now();
}

function isInCooldown(h: EndpointHealth | undefined, t: number): boolean {
  if (!h?.cooldownUntil) return false;
  return h.cooldownUntil > t;
}

/**
 * Order URLs for the next attempt: prefer non-cooldown endpoints first
 * while preserving relative priority. If all cooling down, use full list.
 */
export function orderUrlsForAttempt(
  urls: string[],
  health: Map<string, EndpointHealth>,
  t: number = now(),
): string[] {
  const ready = urls.filter((u) => !isInCooldown(health.get(u), t));
  return ready.length > 0 ? ready : [...urls];
}

/**
 * Record a successful request against `url`.
 * @param latencyMs optional round-trip time from the transport/probe
 */
export function markRpcSuccess(url: string, latencyMs?: number): void {
  if (!state) return;
  const prev = state.activeUrl;
  state.activeUrl = url;
  const h = state.health.get(url) ?? { failures: 0 };
  h.failures = 0;
  h.lastSuccessAt = now();
  h.lastError = undefined;
  h.cooldownUntil = undefined;
  h.successCount = (h.successCount ?? 0) + 1;
  if (latencyMs !== undefined && Number.isFinite(latencyMs) && latencyMs >= 0) {
    h.lastLatencyMs = Math.round(latencyMs);
    // EWMA: first sample = value; then 0.3 new + 0.7 old
    h.avgLatencyMs =
      h.avgLatencyMs === undefined
        ? h.lastLatencyMs
        : Math.round(0.3 * h.lastLatencyMs + 0.7 * h.avgLatencyMs);
  }
  state.health.set(url, h);
  if (prev !== url) {
    logger.info("Using RPC", {
      url,
      latencyMs: h.lastLatencyMs,
    });
  } else {
    logger.debug("RPC ok", { url, latencyMs: h.lastLatencyMs });
  }
}

export function markRpcFailure(url: string, error: unknown): void {
  if (!state) return;
  const h = state.health.get(url) ?? { failures: 0 };
  h.failures += 1;
  h.lastFailureAt = now();
  h.lastError =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  h.cooldownUntil = now() + state.cooldownMs;
  state.health.set(url, h);
  logger.warn("RPC endpoint failed", {
    url,
    error: h.lastError,
    failures: h.failures,
  });
}

/**
 * Pure classifier: map internal health counters → public status vocabulary.
 * Used by snapshots and unit tests (no I/O).
 */
export function classifyEndpointStatus(
  h: EndpointHealth | undefined,
  t: number = now(),
  options?: { degradedLatencyMs?: number },
): RpcHealthStatus {
  const degradedMs = options?.degradedLatencyMs ?? RPC_DEGRADED_LATENCY_MS;
  if (!h) return "unknown";
  const cooling = isInCooldown(h, t);
  const everSucceeded = Boolean(h.lastSuccessAt);
  const everFailed = Boolean(h.lastFailureAt) || h.failures > 0;

  if (cooling) {
    // Still cooling: unreachable if never succeeded, else cool-down
    return everSucceeded ? "cool-down" : "unreachable";
  }

  if (!everSucceeded && !everFailed) return "unknown";
  if (!everSucceeded && everFailed) return "unreachable";

  // Succeeded at least once and not cooling
  const latency = h.avgLatencyMs ?? h.lastLatencyMs;
  if (latency !== undefined && latency >= degradedMs) return "degraded";
  // Recent failures that recovered (success after failure) are healthy;
  // if failures > 0 without cooldown but last success is older than last failure, degraded
  if (
    h.failures > 0 &&
    h.lastFailureAt !== undefined &&
    h.lastSuccessAt !== undefined &&
    h.lastFailureAt > h.lastSuccessAt
  ) {
    return "degraded";
  }
  return "healthy";
}

function emptySummary(): Record<RpcHealthStatus, number> {
  return {
    healthy: 0,
    degraded: 0,
    "cool-down": 0,
    unreachable: 0,
    unknown: 0,
  };
}

export function getActiveRpcUrl(): string | null {
  return state?.activeUrl ?? null;
}

export function getRpcStatusSnapshot(options: {
  urls: string[];
  network: PulseNetwork;
  primaryRpcUrl: string;
}): RpcStatusSnapshot {
  const healthMap = state?.health ?? new Map<string, EndpointHealth>();
  const t = now();
  const active = state?.activeUrl ?? null;
  const summary = emptySummary();
  const endpoints: RpcEndpointStatus[] = options.urls.map((url) => {
    const h = healthMap.get(url);
    const status = classifyEndpointStatus(h, t);
    summary[status] += 1;
    return {
      url,
      status,
      healthy: status === "healthy",
      failures: h?.failures ?? 0,
      lastError: h?.lastError,
      lastSuccessAt: h?.lastSuccessAt
        ? new Date(h.lastSuccessAt).toISOString()
        : undefined,
      lastFailureAt: h?.lastFailureAt
        ? new Date(h.lastFailureAt).toISOString()
        : undefined,
      cooldownUntil:
        h?.cooldownUntil && h.cooldownUntil > t
          ? new Date(h.cooldownUntil).toISOString()
          : undefined,
      lastLatencyMs: h?.lastLatencyMs,
      avgLatencyMs: h?.avgLatencyMs,
      isActive: active !== null && active === url,
    };
  });

  return {
    network: options.network,
    chainId:
      options.network === "testnet"
        ? PULSECHAIN_TESTNET_CHAIN_ID
        : PULSECHAIN_CHAIN_ID,
    rpcUrls: [...options.urls],
    primaryRpcUrl: options.primaryRpcUrl,
    activeRpcUrl: active,
    endpoints,
    summary,
    checkedAt: new Date(t).toISOString(),
    priorityNote:
      "primaryRpcUrl = configured first-priority endpoint (list order only; not auto-selected by latency). activeRpcUrl = last endpoint that successfully answered a request or probe — not sticky and not a permanent primary; probe=true can leave active on the last probed URL even when traffic would prefer an earlier healthy node. Requests always try RPCs in configured list order (put local/LAN first), skipping cooldown endpoints. Failed endpoints cool down briefly then return to the pool. Defaults: g4mm4 → official → publicnode → PulseChainStats.",
  };
}

/**
 * Lightweight on-demand probe: one eth_blockNumber per URL that is not optional-skip.
 * Not a background loop — only when get_rpc_health(probe=true) is called.
 * Uses shared fetch / health marks so failover state stays consistent.
 */
export async function probeRpcEndpoints(options: {
  urls: string[];
  timeoutMs?: number;
  /** Max endpoints to probe this call (default: all configured, cap 8) */
  maxProbes?: number;
}): Promise<void> {
  const urls = options.urls;
  if (urls.length === 0) return;
  if (!state) {
    initMultiRpcState({
      urls,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
  } else if (state.urls.join("\0") !== urls.join("\0")) {
    initMultiRpcState({
      urls,
      timeoutMs: options.timeoutMs ?? state.timeoutMs,
      fetchFn: state.fetchFn,
    });
  }

  const timeoutMs = options.timeoutMs ?? state?.timeoutMs ?? 10_000;
  const fetchImpl = state?.fetchFn ?? globalThis.fetch.bind(globalThis);
  const cap = Math.min(options.maxProbes ?? urls.length, 8, urls.length);

  // Probe in priority order, but do not storm: sequential single method
  for (let i = 0; i < cap; i++) {
    const url = urls[i]!;
    const started = now();
    try {
      await postJsonRpc(url, "eth_blockNumber", [], timeoutMs, fetchImpl);
      markRpcSuccess(url, now() - started);
    } catch (err) {
      markRpcFailure(url, err);
    }
  }
}

/** Compact summary for HTTP /health (no secrets). */
export function getRpcHealthSummary(urls: string[]): {
  activeRpcUrl: string | null;
  rpcCount: number;
  summary: Record<RpcHealthStatus, number>;
} {
  const snap = getRpcStatusSnapshot({
    urls,
    network: "mainnet",
    primaryRpcUrl: urls[0] ?? "",
  });
  return {
    activeRpcUrl: snap.activeRpcUrl,
    rpcCount: urls.length,
    summary: snap.summary,
  };
}

type JsonRpcResponse = {
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

/**
 * POST one JSON-RPC call to a single URL. Does not mark health — caller owns that.
 */
async function postJsonRpc(
  url: string,
  method: string,
  params: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ result: unknown; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: params ?? [],
      }),
      signal: controller.signal,
    });

    // Any non-2xx is a transport/node issue for JSON-RPC POSTs (401/403/404/408/429/5xx, …).
    // Fail over rather than attempting to parse HTML/error bodies as JSON-RPC.
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }

    let json: JsonRpcResponse;
    try {
      json = (await res.json()) as JsonRpcResponse;
    } catch {
      throw new Error(`Invalid JSON response from ${url}`);
    }
    const latencyMs = now() - started;
    if (json.error) {
      const code = json.error.code ?? 0;
      const msg = json.error.message ?? "RPC error";
      // Transport / node health issues → throw so we can failover
      if (
        code === -32000 ||
        code === -32603 ||
        /rate.?limit|timeout|econnrefused|enotfound|503|502|429/i.test(msg)
      ) {
        throw new Error(msg);
      }
      // Application-level JSON-RPC error: node is fine; surface to caller
      // (still count as transport success with latency)
      const err = new Error(msg) as Error & {
        code?: number;
        latencyMs?: number;
      };
      err.code = code;
      err.latencyMs = latencyMs;
      throw err;
    }
    return { result: json.result, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when the error is a transport/node failure (failover), not an app-level
 * eth_call revert / invalid params that should not burn the next endpoint.
 * Exported so `withRpcFailover` and the viem transport share one classifier.
 */
export function isTransportFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message;
  const code = (err as Error & { code?: number }).code;
  if (code === -32000 || code === -32603) return true;
  // HTTP status failures (any code), network, timeouts, rate limits
  if (
    /HTTP \d+|ECONNREFUSED|ENOTFOUND|timeout|aborted|fetch failed|rate.?limit|Invalid JSON response/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (/429|502|503|504/i.test(msg) && /rate|limit|unavailable|gateway|http/i.test(msg)) {
    return true;
  }
  // eth_call reverts etc. often have no code or -32015-ish; treat as app errors
  if (/execution reverted|invalid argument|method not found/i.test(msg)) {
    return false;
  }
  // Structured JSON-RPC app error without transport markers → no failover
  if (code !== undefined && code !== -32000 && code !== -32603) {
    return false;
  }
  return true;
}

/**
 * Create a viem Transport that fails over across `urls` in priority order.
 * **Re-orders on every request** so cool-down endpoints are skipped until ready.
 */
export function createMultiRpcTransport(options: {
  urls: string[];
  timeoutMs: number;
  cooldownMs?: number;
  fetchFn?: typeof fetch;
}): Transport {
  if (options.urls.length === 0) {
    throw new Error(
      "createMultiRpcTransport requires at least one RPC URL. " +
        "Set PULSECHAIN_RPC_URLS (comma-separated http(s) URLs) or PULSECHAIN_RPC_URL.",
    );
  }

  initMultiRpcState({
    urls: options.urls,
    timeoutMs: options.timeoutMs,
    cooldownMs: options.cooldownMs,
    fetchFn: options.fetchFn,
  });

  const configuredUrls = [...options.urls];
  const timeoutMs = options.timeoutMs;

  // EIP-1193-style provider so viem `custom` can bind `.request`
  const provider = {
    async request({
      method,
      params,
    }: {
      method: string;
      params?: unknown;
    }): Promise<unknown> {
      const st = state;
      const urls = st?.urls?.length ? st.urls : configuredUrls;
      const health = st?.health ?? new Map<string, EndpointHealth>();
      // Fresh order every request — respect cooldown
      const ordered = orderUrlsForAttempt(urls, health);
      const fetchImpl = st?.fetchFn ?? globalThis.fetch.bind(globalThis);
      const to = st?.timeoutMs ?? timeoutMs;

      let lastError: unknown;
      for (const url of ordered) {
        try {
          const { result, latencyMs } = await postJsonRpc(
            url,
            method,
            params,
            to,
            fetchImpl,
          );
          markRpcSuccess(url, latencyMs);
          return result;
        } catch (err) {
          lastError = err;
          if (isTransportFailure(err)) {
            // Single mark only (no double-count)
            markRpcFailure(url, err);
            continue;
          }
          // App-level JSON-RPC error on a live node: do not failover
          const lat =
            err && typeof err === "object" && "latencyMs" in err
              ? Number((err as { latencyMs?: number }).latencyMs)
              : undefined;
          markRpcSuccess(url, Number.isFinite(lat) ? lat : undefined);
          throw err;
        }
      }

      throw formatAllEndpointsFailed(configuredUrls.length, lastError);
    },
  };

  return custom(provider, {
    key: "pulsechain-multi-rpc",
    name: "PulseChain Multi-RPC",
    retryCount: 0,
    retryDelay: 0,
  });
}

/** Clear multi-endpoint failure message (includes last error for operators). */
export function formatAllEndpointsFailed(
  tried: number,
  lastError: unknown,
): Error {
  const detail =
    lastError instanceof Error
      ? lastError.message
      : lastError !== undefined && lastError !== null
        ? String(lastError)
        : "no detail";
  return new Error(
    `All RPC endpoints failed (${tried} tried). Last error: ${detail}. ` +
      `Check PULSECHAIN_RPC_URLS order/local node, then get_rpc_health or pulsechain://rpc/status.`,
  );
}

/**
 * Execute a callback against URLs in order with the same health accounting.
 * Re-orders by cooldown on each call.
 *
 * Uses the same `isTransportFailure` classifier as `createMultiRpcTransport`:
 * transport/node failures mark cooldown and try the next URL; application-level
 * JSON-RPC errors mark success (node is live) and rethrow without failover.
 */
export async function withRpcFailover<T>(
  urls: string[],
  attempt: (url: string) => Promise<T>,
): Promise<T> {
  if (!state || state.urls.join("\0") !== urls.join("\0")) {
    initMultiRpcState({
      urls,
      timeoutMs: state?.timeoutMs ?? 30_000,
      fetchFn: state?.fetchFn,
    });
  }
  const health = state!.health;
  const ordered = orderUrlsForAttempt(urls, health);
  let lastError: unknown;
  for (const url of ordered) {
    try {
      const result = await attempt(url);
      markRpcSuccess(url);
      return result;
    } catch (err) {
      lastError = err;
      if (isTransportFailure(err)) {
        markRpcFailure(url, err);
        continue;
      }
      // App-level error on a live node: do not cool down / failover
      const lat =
        err && typeof err === "object" && "latencyMs" in err
          ? Number((err as { latencyMs?: number }).latencyMs)
          : undefined;
      markRpcSuccess(url, Number.isFinite(lat) ? lat : undefined);
      throw err;
    }
  }
  throw formatAllEndpointsFailed(urls.length, lastError);
}
