/**
 * Multi-RPC config merge + failover via real shipped modules.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadConfig,
  parseRpcUrlList,
  resolveRpcUrls,
} from "../src/config.js";
import {
  DEFAULT_RPC_URL,
  DEFAULT_RPC_URLS,
  DEFAULT_TESTNET_RPC_URLS,
} from "../src/constants.js";
import {
  getActiveRpcUrl,
  getBlockNumber,
  getMultiRpcState,
  getPublicClient,
  getRpcStatusSnapshot,
  resetRpcClient,
  setMultiRpcFetch,
} from "../src/data/rpc.js";
import {
  orderUrlsForAttempt,
  withRpcFailover,
  initMultiRpcState,
  resetMultiRpcState,
  markRpcFailure,
  isTransportFailure,
} from "../src/data/multiRpc.js";
import { testAppConfig } from "./helpers/appConfig.js";

afterEach(() => {
  resetRpcClient();
  resetMultiRpcState();
  setMultiRpcFetch(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseRpcUrlList / resolveRpcUrls", () => {
  it("parses comma and newline separated lists", () => {
    const urls = parseRpcUrlList(
      "http://127.0.0.1:8545, https://rpc-pulsechain.g4mm4.io\nhttps://rpc.pulsechain.com",
    );
    expect(urls).toEqual([
      "http://127.0.0.1:8545",
      "https://rpc-pulsechain.g4mm4.io",
      "https://rpc.pulsechain.com",
    ]);
  });

  it("rejects non-http schemes", () => {
    expect(() => parseRpcUrlList("ws://localhost:8545")).toThrow(/http/);
  });

  it("uses mainnet defaults when nothing set", () => {
    const urls = resolveRpcUrls({});
    expect(urls).toEqual([...DEFAULT_RPC_URLS]);
    expect(urls[0]).toBe(DEFAULT_RPC_URL);
    expect(urls).toContain("https://rpc-pulsechain.g4mm4.io");
    expect(urls).toContain("https://rpc.pulsechain.com");
    expect(urls).toContain("https://pulsechain.publicnode.com");
    expect(urls).toContain("https://rpc.pulsechainstats.com");
  });

  it("orders PulseChainStats after preferred public nodes in defaults", () => {
    const urls = [...DEFAULT_RPC_URLS];
    const g4 = urls.indexOf("https://rpc-pulsechain.g4mm4.io");
    const official = urls.indexOf("https://rpc.pulsechain.com");
    const publicnode = urls.indexOf("https://pulsechain.publicnode.com");
    const pcs = urls.indexOf("https://rpc.pulsechainstats.com");
    expect(g4).toBe(0);
    expect(official).toBeGreaterThan(g4);
    expect(publicnode).toBeGreaterThan(official);
    expect(pcs).toBeGreaterThan(publicnode);
    expect(pcs).toBe(urls.length - 1);
  });

  it("legacy PULSECHAIN_RPC_URL alone becomes sole entry", () => {
    const urls = resolveRpcUrls({
      rpcUrlSingle: "https://custom-rpc.example/pls",
    });
    expect(urls).toEqual(["https://custom-rpc.example/pls"]);
  });

  it("prepends legacy single URL ahead of PULSECHAIN_RPC_URLS", () => {
    const urls = resolveRpcUrls({
      rpcUrlSingle: "http://127.0.0.1:8545",
      rpcUrlsRaw:
        "https://rpc-pulsechain.g4mm4.io,https://rpc.pulsechain.com",
    });
    expect(urls[0]).toBe("http://127.0.0.1:8545");
    expect(urls).toContain("https://rpc-pulsechain.g4mm4.io");
    expect(urls).toHaveLength(3);
  });

  it("does not duplicate when single URL already first in list", () => {
    const urls = resolveRpcUrls({
      rpcUrlSingle: "http://127.0.0.1:8545",
      rpcUrlsRaw: "http://127.0.0.1:8545,https://rpc.pulsechain.com",
    });
    expect(urls).toEqual([
      "http://127.0.0.1:8545",
      "https://rpc.pulsechain.com",
    ]);
  });

  it("testnet defaults to g4mm4 testnet when unset", () => {
    const urls = resolveRpcUrls({ network: "testnet" });
    expect(urls).toEqual([...DEFAULT_TESTNET_RPC_URLS]);
  });
});

describe("loadConfig multi-RPC", () => {
  it("empty env yields multi default list with rpcUrl = first", () => {
    const cfg = loadConfig({ AGENT_WALLET_ENABLED: "false" });
    expect(cfg.rpcUrls).toEqual([...DEFAULT_RPC_URLS]);
    expect(cfg.rpcUrl).toBe(cfg.rpcUrls[0]);
    expect(cfg.network).toBe("mainnet");
  });

  it("legacy PULSECHAIN_RPC_URL still works alone", () => {
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      PULSECHAIN_RPC_URL: "https://custom-rpc.example/pls",
    });
    expect(cfg.rpcUrls).toEqual(["https://custom-rpc.example/pls"]);
    expect(cfg.rpcUrl).toBe("https://custom-rpc.example/pls");
  });

  it("PULSECHAIN_RPC_URLS ordered list", () => {
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      PULSECHAIN_RPC_URLS:
        "http://127.0.0.1:8545,http://192.168.1.50:8545,https://rpc-pulsechain.g4mm4.io",
    });
    expect(cfg.rpcUrls[0]).toBe("http://127.0.0.1:8545");
    expect(cfg.rpcUrls[1]).toBe("http://192.168.1.50:8545");
    expect(cfg.rpcUrls[2]).toBe("https://rpc-pulsechain.g4mm4.io");
    expect(cfg.rpcUrl).toBe("http://127.0.0.1:8545");
  });

  it("merges single + list with single first", () => {
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      PULSECHAIN_RPC_URL: "http://192.168.1.10:8545",
      PULSECHAIN_RPC_URLS: "https://rpc-pulsechain.g4mm4.io,https://rpc.pulsechain.com",
    });
    expect(cfg.rpcUrls).toEqual([
      "http://192.168.1.10:8545",
      "https://rpc-pulsechain.g4mm4.io",
      "https://rpc.pulsechain.com",
    ]);
  });
});

describe("orderUrlsForAttempt / withRpcFailover", () => {
  it("skips cool-down endpoints when others are ready", () => {
    const urls = ["http://a", "http://b", "http://c"];
    initMultiRpcState({ urls, timeoutMs: 1000, cooldownMs: 60_000 });
    markRpcFailure("http://a", new Error("down"));
    const ordered = orderUrlsForAttempt(
      urls,
      // re-read state health via mark
      new Map([
        [
          "http://a",
          {
            failures: 1,
            cooldownUntil: Date.now() + 60_000,
          },
        ],
        ["http://b", { failures: 0 }],
        ["http://c", { failures: 0 }],
      ]),
    );
    expect(ordered[0]).toBe("http://b");
    expect(ordered).not.toContain("http://a");
  });

  it("fails over to second URL when first attempt throws", async () => {
    const urls = [
      "https://fail.example/rpc",
      "https://ok.example/rpc",
    ];
    initMultiRpcState({ urls, timeoutMs: 5_000, cooldownMs: 1_000 });
    let calls = 0;
    const result = await withRpcFailover(urls, async (url) => {
      calls += 1;
      if (url.includes("fail.example")) {
        throw new Error("ECONNREFUSED");
      }
      return { blockNumber: 42n, via: url };
    });
    expect(result.blockNumber).toBe(42n);
    expect(result.via).toBe("https://ok.example/rpc");
    expect(calls).toBe(2);
    expect(getActiveRpcUrl()).toBe("https://ok.example/rpc");
  });
});

describe("getPublicClient multi-RPC failover (shipped transport)", () => {
  it("uses second endpoint when first fetch fails", async () => {
    const failUrl = "https://fail-rpc.example";
    const okUrl = "https://ok-rpc.example";
    const cfg = testAppConfig({
      rpcUrl: failUrl,
      rpcUrls: [failUrl, okUrl],
      httpTimeoutMs: 3_000,
    });

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("fail-rpc.example")) {
          throw new Error("connect ECONNREFUSED");
        }
        // Minimal eth_blockNumber success body
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2a" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);

    resetRpcClient();
    // Re-apply fetch after reset (reset clears state)
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);

    const client = getPublicClient(cfg);
    const n = await client.getBlockNumber();
    expect(n).toBe(42n);
    expect(getActiveRpcUrl()).toBe(okUrl);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("getBlockNumber helper succeeds after failover", async () => {
    const failUrl = "https://down.example";
    const okUrl = "https://up.example";
    const cfg = testAppConfig({
      rpcUrls: [failUrl, okUrl],
      rpcUrl: failUrl,
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("down.example")) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x64" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);
    resetRpcClient();
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);

    const n = await getBlockNumber(cfg);
    expect(n).toBe(100n);
    expect(getActiveRpcUrl()).toBe(okUrl);
  });

  it("status snapshot lists all URLs and primary", () => {
    const cfg = testAppConfig({
      rpcUrls: [
        "http://127.0.0.1:8545",
        "https://rpc-pulsechain.g4mm4.io",
      ],
      rpcUrl: "http://127.0.0.1:8545",
    });
    initMultiRpcState({
      urls: cfg.rpcUrls,
      timeoutMs: 1000,
    });
    const snap = getRpcStatusSnapshot({
      urls: cfg.rpcUrls,
      network: cfg.network,
      primaryRpcUrl: cfg.rpcUrl,
    });
    expect(snap.rpcUrls).toHaveLength(2);
    expect(snap.primaryRpcUrl).toBe("http://127.0.0.1:8545");
    expect(snap.endpoints.map((e) => e.url)).toEqual(cfg.rpcUrls);
    expect(snap.priorityNote.toLowerCase()).toMatch(/order|failover|local|cooldown/);
    expect(snap.priorityNote.toLowerCase()).toMatch(
      /primaryrpcurl|first-priority|last.*success|not a sticky primary/,
    );
    expect(snap.summary).toBeDefined();
    expect(snap.endpoints.every((e) => e.status !== undefined)).toBe(true);
  });

  it("second request skips cool-down first URL (dead local not retried every call)", async () => {
    const local = "http://127.0.0.1:18545";
    const okUrl = "https://ok-rpc-cooldown.example";
    const cfg = testAppConfig({
      rpcUrl: local,
      rpcUrls: [local, okUrl],
      httpTimeoutMs: 3_000,
    });

    const attempted: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        attempted.push(url);
        if (url.includes("127.0.0.1")) {
          throw new Error("connect ECONNREFUSED");
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);
    resetRpcClient();
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);

    const client = getPublicClient(cfg);
    await client.getBlockNumber();
    const afterFirst = attempted.length;
    expect(afterFirst).toBeGreaterThanOrEqual(2);
    expect(attempted.some((u) => u.includes("127.0.0.1"))).toBe(true);
    expect(getActiveRpcUrl()).toBe(okUrl);

    // Health should show local failures=1 (not double-counted)
    const st = getMultiRpcState();
    expect(st?.health.get(local)?.failures).toBe(1);

    attempted.length = 0;
    await client.getBlockNumber();
    // Second request must NOT hit cool-down local again
    expect(attempted.some((u) => u.includes("127.0.0.1"))).toBe(false);
    expect(attempted.every((u) => u.includes("ok-rpc-cooldown"))).toBe(true);
    expect(getActiveRpcUrl()).toBe(okUrl);
  });

  it("HTTP 429 marks failure only once (no double increment)", async () => {
    const bad = "https://rate-limit.example";
    const okUrl = "https://ok-after-429.example";
    const cfg = testAppConfig({
      rpcUrls: [bad, okUrl],
      rpcUrl: bad,
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("rate-limit")) {
        return new Response("too many", { status: 429 });
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);
    resetRpcClient();
    setMultiRpcFetch(fetchMock as unknown as typeof fetch);

    await getBlockNumber(cfg);
    const failures = getMultiRpcState()?.health.get(bad)?.failures;
    expect(failures).toBe(1);
    expect(getActiveRpcUrl()).toBe(okUrl);
  });

  it("HTTP 401/403/404 fail over like other non-2xx (transport)", async () => {
    for (const status of [401, 403, 404]) {
      resetRpcClient();
      resetMultiRpcState();
      const bad = `https://http-${status}.example`;
      const okUrl = `https://ok-after-${status}.example`;
      const cfg = testAppConfig({
        rpcUrls: [bad, okUrl],
        rpcUrl: bad,
      });
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`http-${status}`)) {
          return new Response("nope", { status });
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x5" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      setMultiRpcFetch(fetchMock as unknown as typeof fetch);
      resetRpcClient();
      setMultiRpcFetch(fetchMock as unknown as typeof fetch);

      const n = await getBlockNumber(cfg);
      expect(n).toBe(5n);
      expect(getActiveRpcUrl()).toBe(okUrl);
      expect(getMultiRpcState()?.health.get(bad)?.failures).toBe(1);
    }
  });
});

describe("formatAllEndpointsFailed (shipped helper)", () => {
  it("includes try count, last error, and operator hint", async () => {
    const { formatAllEndpointsFailed } = await import("../src/data/multiRpc.js");
    const err = formatAllEndpointsFailed(3, new Error("ECONNREFUSED"));
    expect(err.message).toMatch(/All RPC endpoints failed \(3 tried\)/);
    expect(err.message).toMatch(/ECONNREFUSED/);
    expect(err.message).toMatch(/get_rpc_health|PULSECHAIN_RPC_URLS/i);
  });

  it("withRpcFailover surfaces aggregated failure when all URLs die", async () => {
    const urls = ["https://dead-a.example/rpc", "https://dead-b.example/rpc"];
    initMultiRpcState({ urls, timeoutMs: 5_000, cooldownMs: 1_000 });
    await expect(
      withRpcFailover(urls, async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    ).rejects.toThrow(/All RPC endpoints failed \(2 tried\).*ECONNREFUSED/i);
  });
});

describe("isTransportFailure + withRpcFailover alignment", () => {
  it("classifies HTTP and network errors as transport", () => {
    expect(isTransportFailure(new Error("HTTP 401 from https://x"))).toBe(true);
    expect(isTransportFailure(new Error("HTTP 404 from https://x"))).toBe(true);
    expect(isTransportFailure(new Error("HTTP 503 from https://x"))).toBe(true);
    expect(isTransportFailure(new Error("connect ECONNREFUSED"))).toBe(true);
    expect(isTransportFailure(new Error("Invalid JSON response from https://x"))).toBe(
      true,
    );
  });

  it("classifies app-level JSON-RPC errors as non-transport", () => {
    const appErr = new Error("execution reverted: insufficient") as Error & {
      code?: number;
    };
    appErr.code = 3;
    expect(isTransportFailure(appErr)).toBe(false);

    const invalidArg = new Error("invalid argument 0: hex string") as Error & {
      code?: number;
    };
    invalidArg.code = -32602;
    expect(isTransportFailure(invalidArg)).toBe(false);
  });

  it("withRpcFailover does not cool down on app-level errors", async () => {
    const urls = ["https://live.example/rpc", "https://backup.example/rpc"];
    initMultiRpcState({ urls, timeoutMs: 5_000, cooldownMs: 60_000 });
    let calls = 0;
    await expect(
      withRpcFailover(urls, async (_url) => {
        calls += 1;
        const err = new Error("execution reverted") as Error & { code?: number };
        err.code = 3;
        throw err;
      }),
    ).rejects.toThrow(/execution reverted/);
    // Only first URL tried — no failover for app error
    expect(calls).toBe(1);
    const h = getMultiRpcState()?.health.get(urls[0]!);
    // App error marks success (node live), not failure cooldown
    expect(h?.failures ?? 0).toBe(0);
    expect(h?.cooldownUntil).toBeUndefined();
    expect(getActiveRpcUrl()).toBe(urls[0]);
  });

  it("withRpcFailover fails over on transport errors (same as transport path)", async () => {
    const urls = ["https://dead.example/rpc", "https://alive.example/rpc"];
    initMultiRpcState({ urls, timeoutMs: 5_000, cooldownMs: 60_000 });
    const result = await withRpcFailover(urls, async (url) => {
      if (url.includes("dead")) {
        throw new Error("HTTP 403 from " + url);
      }
      return { ok: true, via: url };
    });
    expect(result.via).toBe("https://alive.example/rpc");
    expect(getMultiRpcState()?.health.get(urls[0]!)?.failures).toBe(1);
    expect(getActiveRpcUrl()).toBe(urls[1]);
  });
});
