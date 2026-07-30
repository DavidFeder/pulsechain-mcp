/**
 * High-value polish tests for v0.1.2: config fail-early, RPC error messaging,
 * version surface, wallet fail-closed when misconfigured.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SERVER_VERSION } from "../src/constants.js";
import { ConfigError, mapUnknownError, RpcError } from "../src/utils/errors.js";
import { evaluatePolicy } from "../src/wallet/policy.js";
import { DEFAULT_POLICY } from "../src/wallet/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("v0.1.2 polish", () => {
  it("SERVER_VERSION matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(pkg.version).toMatch(/^(0\.(1|2|3|4)\.\d+|1\.0\.\d+)$/);
  });

  it("loadConfig fails with ConfigError when wallets on without master key", () => {
    try {
      loadConfig({ AGENT_WALLET_ENABLED: "true" });
      expect.unreachable("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("CONFIG_ERROR");
      expect((err as Error).message).toMatch(/MASTER_KEY/);
      expect((err as Error).message).toMatch(/\.env\.example|false|research-only|by default/i);
    }
  });

  it("RpcError mentions multi-RPC env vars", () => {
    const e = new RpcError("connection refused");
    expect(e.message).toMatch(/PULSECHAIN_RPC_URLS/);
    expect(e.code).toBe("RPC_ERROR");
  });

  it("mapUnknownError maps all-endpoints-failed to NETWORK_ERROR", () => {
    const err = mapUnknownError(
      new Error(
        "All RPC endpoints failed (3 tried). Last error: ECONNREFUSED. Check PULSECHAIN_RPC_URLS.",
      ),
      "getBlockNumber",
    );
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.message).toMatch(/PULSECHAIN_RPC_URLS|connectivity|local/i);
  });

  it("operator-trust allows contract calldata; kill switch still blocks", () => {
    const open = evaluatePolicy({
      policy: DEFAULT_POLICY(1, 10),
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
      valuePls: 0,
      data: "0xa9059cbb",
      destinationIsContract: true,
    });
    expect(open.allowed).toBe(true);

    const killed = evaluatePolicy({
      policy: { ...DEFAULT_POLICY(1, 10), killed: true, enabled: false },
      dailySpend: { date: new Date().toISOString().slice(0, 10), spentPls: 0 },
      to: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
      valuePls: 0,
      data: "0xa9059cbb",
      destinationIsContract: true,
    });
    expect(killed.allowed).toBe(false);
    expect(killed.reasons.some((r) => /kill/i.test(r))).toBe(true);
  });

  it("default is wallets on with master key; research-only via false; multi RPC includes g4mm4", () => {
    const on = loadConfig({
      AGENT_WALLET_MASTER_KEY: "d".repeat(64),
    });
    expect(on.agentWalletEnabled).toBe(true);
    expect(on.rpcUrls.length).toBeGreaterThanOrEqual(2);
    expect(on.rpcUrls.some((u) => u.includes("g4mm4"))).toBe(true);

    const off = loadConfig({ AGENT_WALLET_ENABLED: "false" });
    expect(off.agentWalletEnabled).toBe(false);
  });
});
