import { describe, expect, it } from "vitest";
import {
  loadConfig,
  parseRpcUrlList,
  formatEnvValidationError,
  assertMasterKeyConfigured,
} from "../src/config.js";
import {
  DEFAULT_EXPLORER_API,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_PULSEX_SUBGRAPH_V1,
  DEFAULT_PULSEX_SUBGRAPH_V2,
  DEFAULT_RPC_URL,
  DEFAULT_RPC_URLS,
} from "../src/constants.js";
import { ConfigError } from "../src/utils/errors.js";
import { z } from "zod";

/** Valid 64-char hex master key for tests that need wallets on. */
const TEST_MASTER_KEY = "a".repeat(64);

describe("loadConfig", () => {
  it("defaults wallets on and fails without master key (product default)", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/MASTER_KEY|by default|research-only|false/i);
  });

  it("missing-key ConfigError steers to write-only path; never console.log randomBytes recipe", () => {
    let msg = "";
    try {
      loadConfig({ AGENT_WALLET_ENABLED: "true" });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg.length).toBeGreaterThan(20);
    expect(msg).toMatch(/generate-wallet-env|install-for-host/i);
    expect(msg).toMatch(/write-only|never prints|\.env\.wallet|launcher/i);
    // Must not re-teach print-then-paste key generation (review R1)
    expect(msg).not.toMatch(/console\.log/);
    expect(msg).not.toMatch(/randomBytes/);
    expect(msg).not.toMatch(/require\(['"]crypto['"]\)/);
  });

  it("short passphrase ConfigError steers to write-only path; never console.log recipe", () => {
    let msg = "";
    try {
      assertMasterKeyConfigured("short");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/too short|passphrase/i);
    expect(msg).toMatch(/generate-wallet-env|install-for-host/i);
    expect(msg).not.toMatch(/console\.log/);
    expect(msg).not.toMatch(/randomBytes/);
  });

  it("enables wallets when unset and master key is present", () => {
    const cfg = loadConfig({
      AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
    });
    expect(cfg.agentWalletEnabled).toBe(true);
    expect(cfg.agentWalletMasterKey).toBe(TEST_MASTER_KEY);
    expect(cfg.rpcUrls).toEqual([...DEFAULT_RPC_URLS]);
    expect(cfg.rpcUrl).toBe(DEFAULT_RPC_URL);
    expect(cfg.network).toBe("mainnet");
    expect(cfg.explorerApi).toBe(DEFAULT_EXPLORER_API);
    expect(cfg.agentWalletDir).toBe("./data/wallets");
    expect(cfg.maxPlsPerTx).toBe(100);
    expect(cfg.maxPlsDaily).toBe(1000);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.pulseXSubgraphV1).toBe(DEFAULT_PULSEX_SUBGRAPH_V1);
    expect(cfg.pulseXSubgraphV2).toBe(DEFAULT_PULSEX_SUBGRAPH_V2);
    expect(cfg.httpTimeoutMs).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    expect(cfg.httpTransportPort).toBeUndefined();
    expect(cfg.agentWalletMultiprocStrict).toBe(true);
  });

  it("disables wallets without master key when AGENT_WALLET_ENABLED=false", () => {
    const cfg = loadConfig({ AGENT_WALLET_ENABLED: "false" });
    expect(cfg.agentWalletEnabled).toBe(false);
    expect(cfg.agentWalletMasterKey).toBeUndefined();
  });

  it("parses agent wallet and optional legacy MAX_PLS display fields when master key present", () => {
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "true",
      AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
      MAX_PLS_PER_TX: "50",
      MAX_PLS_DAILY: "200",
      LOG_LEVEL: "debug",
    });
    expect(cfg.agentWalletEnabled).toBe(true);
    expect(cfg.maxPlsPerTx).toBe(50);
    expect(cfg.maxPlsDaily).toBe(200);
    expect(cfg.logLevel).toBe("debug");
  });

  it("fails early when wallets enabled without master key", () => {
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
      }),
    ).toThrow(/AGENT_WALLET_MASTER_KEY|MASTER_KEY|CONFIG/i);
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
      }),
    ).toThrow(ConfigError);
  });

  it("treats AGENT_WALLET_ENABLED 1/0 and empty as bool", () => {
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "1",
        AGENT_WALLET_MASTER_KEY: "b".repeat(64),
      }).agentWalletEnabled,
    ).toBe(true);
    expect(loadConfig({ AGENT_WALLET_ENABLED: "0" }).agentWalletEnabled).toBe(
      false,
    );
    // Empty string is explicit non-true → wallets off (no master key needed)
    expect(loadConfig({ AGENT_WALLET_ENABLED: "" }).agentWalletEnabled).toBe(
      false,
    );
    expect(loadConfig({ AGENT_WALLET_ENABLED: "false" }).agentWalletEnabled).toBe(
      false,
    );
  });

  it("overrides RPC, explorer, wallet dir, master key, timeout", () => {
    const cfg = loadConfig({
      PULSECHAIN_RPC_URL: "https://custom-rpc.example/pls",
      PULSECHAIN_EXPLORER_API: "https://custom-scan.example/api",
      AGENT_WALLET_DIR: "/tmp/agent-wallets",
      AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
      HTTP_TIMEOUT_MS: "12000",
    });
    expect(cfg.rpcUrl).toBe("https://custom-rpc.example/pls");
    expect(cfg.rpcUrls).toEqual(["https://custom-rpc.example/pls"]);
    expect(cfg.explorerApi).toBe("https://custom-scan.example/api");
    expect(cfg.agentWalletDir).toBe("/tmp/agent-wallets");
    expect(cfg.agentWalletMasterKey).toBe(TEST_MASTER_KEY);
    expect(cfg.httpTimeoutMs).toBe(12_000);
    expect(cfg.agentWalletEnabled).toBe(true);
  });

  it("treats empty subgraph env as default public endpoints", () => {
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      PULSEX_SUBGRAPH_V1: "",
      PULSEX_SUBGRAPH_V2: "",
    });
    expect(cfg.pulseXSubgraphV1).toBe(DEFAULT_PULSEX_SUBGRAPH_V1);
    expect(cfg.pulseXSubgraphV2).toBe(DEFAULT_PULSEX_SUBGRAPH_V2);
  });

  it("accepts custom subgraph URLs", () => {
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      PULSEX_SUBGRAPH_V1: "https://example.com/v1",
      PULSEX_SUBGRAPH_V2: "https://example.com/v2",
    });
    expect(cfg.pulseXSubgraphV1).toBe("https://example.com/v1");
    expect(cfg.pulseXSubgraphV2).toBe("https://example.com/v2");
  });

  it("rejects invalid HTTP port", () => {
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "false",
        HTTP_TRANSPORT_PORT: "99999",
      }),
    ).toThrow(/HTTP_TRANSPORT_PORT/);
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "false",
        HTTP_TRANSPORT_PORT: "0",
      }),
    ).toThrow(/HTTP_TRANSPORT_PORT/);
  });

  it("parses HTTP transport port", () => {
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      HTTP_TRANSPORT_PORT: "3100",
    });
    expect(cfg.httpTransportPort).toBe(3100);
  });

  it("rejects non-numeric legacy MAX_PLS / timeout env strings with clear ConfigError", () => {
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "false",
        MAX_PLS_PER_TX: "not-a-number",
      }),
    ).toThrow(/MAX_PLS_PER_TX|finite/i);
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "false",
        HTTP_TIMEOUT_MS: "abc",
      }),
    ).toThrow(/HTTP_TIMEOUT_MS/);
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      MAX_PLS_DAILY: "",
    });
    expect(cfg.maxPlsDaily).toBe(1000);
  });

  it("rejects legacy MAX_PLS_PER_TX greater than MAX_PLS_DAILY (display-field validation)", () => {
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "false",
        MAX_PLS_PER_TX: "500",
        MAX_PLS_DAILY: "100",
      }),
    ).toThrow(/cannot exceed|MAX_PLS/i);
  });

  it("rejects negative legacy MAX_PLS display fields", () => {
    expect(() =>
      loadConfig({ AGENT_WALLET_ENABLED: "false", MAX_PLS_PER_TX: "-1" }),
    ).toThrow(/>= 0/);
  });

  it("rejects short MRTR secret when set", () => {
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "false",
        AGENT_WALLET_MRTR_SECRET: "too-short",
      }),
    ).toThrow(/MRTR_SECRET|32 bytes/i);
  });

  it("rejects invalid LOG_LEVEL enum", () => {
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "false",
        LOG_LEVEL: "verbose" as "info",
      }),
    ).toThrow(/Invalid environment|LOG_LEVEL/i);
  });

  it("rejects invalid RPC URL schemes with actionable message", () => {
    expect(() => parseRpcUrlList("ftp://bad.example")).toThrow(/http/i);
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "false",
        PULSECHAIN_RPC_URL: "not-a-url",
      }),
    ).toThrow(/Invalid|RPC/i);
  });

  it("rejects short passphrase master key when wallets enabled", () => {
    expect(() =>
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: "short",
      }),
    ).toThrow(/too short|MASTER_KEY|16/i);
    expect(() => assertMasterKeyConfigured("tiny")).toThrow(/too short|16/i);
    expect(() => assertMasterKeyConfigured("ab".repeat(32))).not.toThrow();
    expect(() =>
      assertMasterKeyConfigured("this-is-a-long-enough-passphrase"),
    ).not.toThrow();
  });

  it("rejects scientific notation / hex-looking MAX_PLS env values", () => {
    expect(() =>
      loadConfig({ AGENT_WALLET_ENABLED: "false", MAX_PLS_PER_TX: "1e2" }),
    ).toThrow(/plain decimal|scientific|MAX_PLS_PER_TX/i);
    expect(() =>
      loadConfig({ AGENT_WALLET_ENABLED: "false", MAX_PLS_DAILY: "0x10" }),
    ).toThrow(/plain decimal|hex|MAX_PLS_DAILY/i);
  });

  it("trims empty AGENT_WALLET_DIR to default", () => {
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      AGENT_WALLET_DIR: "   ",
    });
    expect(cfg.agentWalletDir).toBe("./data/wallets");
  });

  it("AGENT_WALLET_ENFORCE_LEGACY_CAPS: unset/false/0/empty → false; true/1 → true", () => {
    expect(
      loadConfig({ AGENT_WALLET_ENABLED: "false" })
        .agentWalletEnforceLegacyCaps,
    ).toBe(false);
    expect(
      loadConfig({
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
      }).agentWalletEnforceLegacyCaps,
    ).toBe(false);
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        AGENT_WALLET_ENFORCE_LEGACY_CAPS: "",
      }).agentWalletEnforceLegacyCaps,
    ).toBe(false);
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        AGENT_WALLET_ENFORCE_LEGACY_CAPS: "false",
      }).agentWalletEnforceLegacyCaps,
    ).toBe(false);
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        AGENT_WALLET_ENFORCE_LEGACY_CAPS: "0",
      }).agentWalletEnforceLegacyCaps,
    ).toBe(false);
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        AGENT_WALLET_ENFORCE_LEGACY_CAPS: "true",
      }).agentWalletEnforceLegacyCaps,
    ).toBe(true);
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        AGENT_WALLET_ENFORCE_LEGACY_CAPS: "1",
      }).agentWalletEnforceLegacyCaps,
    ).toBe(true);
  });

  it("AGENT_WALLET_MULTIPROC_STRICT: wallets-on unset/empty → true; explicit false/0 → false; research-only unset → false", () => {
    expect(
      loadConfig({ AGENT_WALLET_ENABLED: "false" }).agentWalletMultiprocStrict,
    ).toBe(false);
    expect(
      loadConfig({
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
      }).agentWalletMultiprocStrict,
    ).toBe(true);
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        AGENT_WALLET_MULTIPROC_STRICT: "",
      }).agentWalletMultiprocStrict,
    ).toBe(true);
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        AGENT_WALLET_MULTIPROC_STRICT: "false",
      }).agentWalletMultiprocStrict,
    ).toBe(false);
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        AGENT_WALLET_MULTIPROC_STRICT: "0",
      }).agentWalletMultiprocStrict,
    ).toBe(false);
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        AGENT_WALLET_MULTIPROC_STRICT: "true",
      }).agentWalletMultiprocStrict,
    ).toBe(true);
    expect(
      loadConfig({
        AGENT_WALLET_ENABLED: "false",
        AGENT_WALLET_MULTIPROC_STRICT: "1",
      }).agentWalletMultiprocStrict,
    ).toBe(true);
  });

  it("wallets + HTTP require AGENT_WALLET_MRTR_SECRET; stdio and research-only HTTP do not", () => {
    const secret = "m".repeat(32);
    let httpMsg = "";
    try {
      loadConfig({
        AGENT_WALLET_ENABLED: "true",
        AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
        HTTP_TRANSPORT_PORT: "3100",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      httpMsg = e instanceof Error ? e.message : String(e);
    }
    expect(httpMsg).toMatch(/AGENT_WALLET_MRTR_SECRET/);
    expect(httpMsg).toMatch(/HTTP_TRANSPORT_PORT|HTTP/);
    expect(httpMsg).toMatch(/32 bytes|≥32|at least 32/i);
    expect(httpMsg).toMatch(/Do not reuse AGENT_WALLET_MASTER_KEY/i);

    const walletsHttp = loadConfig({
      AGENT_WALLET_ENABLED: "true",
      AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
      HTTP_TRANSPORT_PORT: "3100",
      AGENT_WALLET_MRTR_SECRET: secret,
    });
    expect(walletsHttp.httpTransportPort).toBe(3100);
    expect(walletsHttp.agentWalletEnabled).toBe(true);

    const walletsStdio = loadConfig({
      AGENT_WALLET_ENABLED: "true",
      AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
    });
    expect(walletsStdio.httpTransportPort).toBeUndefined();
    expect(walletsStdio.agentWalletEnabled).toBe(true);

    const walletsEmptyHttp = loadConfig({
      AGENT_WALLET_ENABLED: "true",
      AGENT_WALLET_MASTER_KEY: TEST_MASTER_KEY,
      HTTP_TRANSPORT_PORT: "",
    });
    expect(walletsEmptyHttp.httpTransportPort).toBeUndefined();

    const researchHttp = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      HTTP_TRANSPORT_PORT: "3100",
    });
    expect(researchHttp.httpTransportPort).toBe(3100);
    expect(researchHttp.agentWalletEnabled).toBe(false);
  });
});

describe("formatEnvValidationError", () => {
  it("lists issue paths", () => {
    const schema = z.object({ LOG_LEVEL: z.enum(["info"]) });
    const r = schema.safeParse({ LOG_LEVEL: "nope" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = formatEnvValidationError(r.error);
      expect(msg).toMatch(/LOG_LEVEL/);
      expect(msg).toMatch(/\.env\.example/);
    }
  });
});
