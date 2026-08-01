/**
 * RPC health status mapping + snapshot (shipped multiRpc module).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyEndpointStatus,
  getRpcStatusSnapshot,
  initMultiRpcState,
  markRpcFailure,
  markRpcSuccess,
  probeRpcEndpoints,
  resetMultiRpcState,
  setMultiRpcFetch,
  type EndpointHealth,
} from "../src/data/multiRpc.js";
import { getPublicClient, resetRpcClient } from "../src/data/rpc.js";
import { testAppConfig } from "./helpers/appConfig.js";
import { registerHealthTools } from "../src/tools/health.js";
import { getRegisteredTools, resetToolRegistry } from "../src/tools/define.js";
import { loadConfig } from "../src/config.js";
import { SERVER_VERSION } from "../src/constants.js";

afterEach(() => {
  resetMultiRpcState();
  resetRpcClient();
  setMultiRpcFetch(undefined);
  resetToolRegistry();
  vi.restoreAllMocks();
});

describe("classifyEndpointStatus", () => {
  const t = Date.now();

  it("unknown when no health data", () => {
    expect(classifyEndpointStatus(undefined, t)).toBe("unknown");
    expect(classifyEndpointStatus({ failures: 0 }, t)).toBe("unknown");
  });

  it("unreachable when failed and never succeeded", () => {
    const h: EndpointHealth = {
      failures: 2,
      lastFailureAt: t - 1000,
      cooldownUntil: t - 1, // cooled down
    };
    expect(classifyEndpointStatus(h, t)).toBe("unreachable");
  });

  it("cool-down when cooling after prior success", () => {
    const h: EndpointHealth = {
      failures: 1,
      lastSuccessAt: t - 60_000,
      lastFailureAt: t - 100,
      cooldownUntil: t + 30_000,
    };
    expect(classifyEndpointStatus(h, t)).toBe("cool-down");
  });

  it("unreachable while cooling with no prior success", () => {
    const h: EndpointHealth = {
      failures: 1,
      lastFailureAt: t - 100,
      cooldownUntil: t + 30_000,
    };
    expect(classifyEndpointStatus(h, t)).toBe("unreachable");
  });

  it("healthy after success", () => {
    const h: EndpointHealth = {
      failures: 0,
      lastSuccessAt: t - 500,
      lastLatencyMs: 40,
      avgLatencyMs: 45,
    };
    expect(classifyEndpointStatus(h, t)).toBe("healthy");
  });

  it("degraded when latency high", () => {
    const h: EndpointHealth = {
      failures: 0,
      lastSuccessAt: t - 100,
      lastLatencyMs: 5000,
      avgLatencyMs: 4000,
    };
    expect(classifyEndpointStatus(h, t)).toBe("degraded");
  });
});

describe("getRpcStatusSnapshot (shipped)", () => {
  it("lists endpoints with status after failure then success", () => {
    const urls = [
      "https://fail-health.example",
      "https://ok-health.example",
    ];
    initMultiRpcState({ urls, timeoutMs: 5_000, cooldownMs: 60_000 });
    markRpcFailure(urls[0]!, new Error("ECONNREFUSED"));
    markRpcSuccess(urls[1]!, 42);

    const snap = getRpcStatusSnapshot({
      urls,
      network: "mainnet",
      primaryRpcUrl: urls[0]!,
    });

    expect(snap.endpoints).toHaveLength(2);
    expect(snap.activeRpcUrl).toBe(urls[1]);
    expect(snap.summary.healthy).toBeGreaterThanOrEqual(1);
    expect(snap.summary.unreachable + snap.summary["cool-down"]).toBeGreaterThanOrEqual(
      1,
    );

    const bad = snap.endpoints.find((e) => e.url === urls[0]);
    const good = snap.endpoints.find((e) => e.url === urls[1]);
    expect(bad?.failures).toBe(1);
    expect(bad?.status === "cool-down" || bad?.status === "unreachable").toBe(
      true,
    );
    expect(good?.status).toBe("healthy");
    expect(good?.lastLatencyMs).toBe(42);
    expect(good?.isActive).toBe(true);
    expect(snap.checkedAt).toBeTruthy();
  });

  it("probe updates health via real post path (mocked fetch)", async () => {
    const urls = ["https://probe-a.example", "https://probe-b.example"];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("probe-a")) {
        throw new Error("connect ECONNREFUSED");
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);
    initMultiRpcState({
      urls,
      timeoutMs: 3_000,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    await probeRpcEndpoints({ urls, timeoutMs: 3_000 });
    const snap = getRpcStatusSnapshot({
      urls,
      network: "mainnet",
      primaryRpcUrl: urls[0]!,
    });
    expect(snap.endpoints[0]!.failures).toBeGreaterThanOrEqual(1);
    expect(snap.endpoints[1]!.status).toBe("healthy");
    expect(snap.activeRpcUrl).toBe(urls[1]);
  });
});

describe("get_rpc_health tool registration", () => {
  it("registers get_rpc_health and returns snapshot without probe", async () => {
    const handlers = new Map<
      string,
      (args?: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>
    >();
    const server = {
      registerTool: (name: string, ...rest: unknown[]) => {
        const cb = rest[rest.length - 1];
        if (typeof cb === "function") {
          handlers.set(name, cb as (args?: Record<string, unknown>) => Promise<{
            content: Array<{ type: string; text: string }>;
          }>);
        }
      },
    };
    const cfg = testAppConfig({
      rpcUrls: [
        "https://rpc-pulsechain.g4mm4.io",
        "https://rpc.pulsechain.com",
      ],
      rpcUrl: "https://rpc-pulsechain.g4mm4.io",
    });
    resetToolRegistry();
    registerHealthTools(server as never, cfg);
    const names = getRegisteredTools().map((t) => t.name);
    expect(names).toContain("get_rpc_health");

    const fn = handlers.get("get_rpc_health");
    expect(fn).toBeTypeOf("function");
    const res = await fn!({ probe: false });
    const body = JSON.parse(res.content[0]!.text) as {
      ok: boolean;
      data: {
        rpcUrls: string[];
        endpoints: Array<{ status: string; url: string }>;
        summary: Record<string, number>;
        probed: boolean;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.probed).toBe(false);
    expect(body.data.rpcUrls.length).toBe(2);
    expect(body.data.endpoints.length).toBe(2);
    expect(body.data.endpoints[0]!.status).toBeDefined();
    expect(body.data.summary).toBeDefined();
  });
});

describe("version 1.0.2", () => {
  it("matches package and SERVER_VERSION", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      version: string;
    };
    expect(pkg.version).toBe("1.0.2");
    expect(SERVER_VERSION).toBe("1.0.2");
    const cfg = loadConfig({ AGENT_WALLET_ENABLED: "false" });
    expect(cfg.rpcUrls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("passive latency via getPublicClient", () => {
  it("records latency on successful failover path", async () => {
    const failUrl = "https://lat-fail.example";
    const okUrl = "https://lat-ok.example";
    const cfg = testAppConfig({
      rpcUrls: [failUrl, okUrl],
      rpcUrl: failUrl,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("lat-fail")) {
        throw new Error("ECONNREFUSED");
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);
    resetRpcClient();
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);

    await getPublicClient(cfg).getBlockNumber();
    const snap = getRpcStatusSnapshot({
      urls: cfg.rpcUrls,
      network: cfg.network,
      primaryRpcUrl: cfg.rpcUrl,
    });
    const okEp = snap.endpoints.find((e) => e.url === okUrl);
    expect(okEp?.status).toBe("healthy");
    expect(okEp?.lastLatencyMs).toBeTypeOf("number");
  });
});

