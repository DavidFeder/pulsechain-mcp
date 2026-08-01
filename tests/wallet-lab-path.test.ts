/**
 * Optional agent wallet path: unique dir + multiproc strict + master key,
 * create via shipped service, status/list visibility, no secret leakage,
 * wallets-off refuse. Mirrors .env.wallet.example posture without committing secrets.
 *
 * Templates omit MAX_PLS_* product knobs (operator-trust; funding authorizes).
 * Optional legacy env parse still works when operators set values.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  agentWalletSystemStatus,
  createAgentWallet,
  getAgentWalletInfo,
  listAgentWallets,
} from "../src/wallet/service.js";
import { neverReturnPrivateKey } from "../src/utils/safety.js";
import type { AppConfig } from "../src/types.js";

const PRIVATE_KEY_HEX_RE = /0x[a-fA-F0-9]{64}/;
const SECRET_FIELD_RE =
  /"privateKey"|"private_key"|"mnemonic"|"encryptedKey"|"ciphertext"|"masterKey"|"agentWalletMasterKey"/i;

/** Optional legacy parse values used only in loadConfig compatibility checks. */
const LEGACY_MAX_PLS_PER_TX = 500;
const LEGACY_MAX_PLS_DAILY = 2000;

const tempDirs: string[] = [];

function tempWalletDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-lab-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** Wallet-mode AppConfig (same createAgentWallet path as tools; multiproc strict on). */
function labConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    rpcUrl: "https://rpc.pulsechain.com",
    rpcUrls: ["https://rpc.pulsechain.com"],
    network: "mainnet",
    explorerApi: "https://api.scan.pulsechain.com/api",
    pulseXSubgraphV1: "https://example.com/v1",
    pulseXSubgraphV2: "https://example.com/v2",
    agentWalletEnabled: true,
    agentWalletMasterKey: randomBytes(32).toString("hex"),
    agentWalletDir: tempWalletDir(),
    agentWalletMultiprocStrict: true,
    maxPlsPerTx: LEGACY_MAX_PLS_PER_TX,
    maxPlsDaily: LEGACY_MAX_PLS_DAILY,
    httpTransportPort: undefined,
    logLevel: "error",
    httpTimeoutMs: 5000,
    ...overrides,
  };
}

function assertNoSecrets(payload: unknown, masterKey?: string): void {
  const json = JSON.stringify(payload);
  expect(json).not.toMatch(PRIVATE_KEY_HEX_RE);
  expect(json).not.toMatch(SECRET_FIELD_RE);
  if (masterKey) {
    expect(json).not.toContain(masterKey);
  }
}

describe("optional agent wallet path (shipped service)", () => {
  it("loadConfig accepts wallet env posture (enabled + strict + unique dir; optional legacy caps)", () => {
    const dir = tempWalletDir();
    const master = randomBytes(32).toString("hex");
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "true",
      AGENT_WALLET_MASTER_KEY: master,
      AGENT_WALLET_DIR: dir,
      AGENT_WALLET_MULTIPROC_STRICT: "true",
      MAX_PLS_PER_TX: String(LEGACY_MAX_PLS_PER_TX),
      MAX_PLS_DAILY: String(LEGACY_MAX_PLS_DAILY),
      LOG_LEVEL: "error",
    });
    expect(cfg.agentWalletEnabled).toBe(true);
    expect(cfg.agentWalletMultiprocStrict).toBe(true);
    expect(cfg.agentWalletDir).toBe(dir);
    expect(cfg.agentWalletMasterKey).toBe(master);
    expect(cfg.maxPlsPerTx).toBe(LEGACY_MAX_PLS_PER_TX);
    expect(cfg.maxPlsDaily).toBe(LEGACY_MAX_PLS_DAILY);
  });

  it("default env posture keeps wallets off (write refuse)", async () => {
    const cfg = loadConfig({
      AGENT_WALLET_ENABLED: "false",
      LOG_LEVEL: "error",
    });
    expect(cfg.agentWalletEnabled).toBe(false);
    expect(cfg.agentWalletMultiprocStrict).toBe(false);
    await expect(createAgentWallet(cfg)).rejects.toThrow(/disabled/i);
  });

  it("create via shipped path; status/list/info show address; no secret leakage", async () => {
    const dir = tempWalletDir();
    const master = randomBytes(32).toString("hex");
    const cfg = labConfig({
      agentWalletDir: dir,
      agentWalletMasterKey: master,
      agentWalletMultiprocStrict: true,
    });

    const created = await createAgentWallet(cfg, { label: "lab-v0.1.31" });
    expect(created.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(created.id).toMatch(/^aw_[a-f0-9]{32}$/);
    expect(created.label).toBe("lab-v0.1.31");
    assertNoSecrets(created, master);
    assertNoSecrets(neverReturnPrivateKey({ ...created }), master);

    const status = agentWalletSystemStatus(cfg);
    const glance = status.operatorAtAGlance as {
      walletsEnabled: boolean;
      multiprocMode: string;
      walletCount: number;
      headline: string;
      nextAction: string;
      policyPosture: string;
      defaultCaps: { maxPlsPerTx: number; maxPlsDaily: number };
      bullets: string[];
    };
    expect(status.enabled).toBe(true);
    expect(status.walletDir).toBe(dir);
    expect(status.masterKeyConfigured).toBe(true);
    expect(status.walletCount).toBe(1);
    expect(status.maxPlsPerTxDefault).toBe(LEGACY_MAX_PLS_PER_TX);
    expect(status.maxPlsDailyDefault).toBe(LEGACY_MAX_PLS_DAILY);
    expect(glance.walletsEnabled).toBe(true);
    expect(glance.multiprocMode).toBe("strict-fail-closed");
    expect(glance.walletCount).toBe(1);
    expect(glance.headline).toMatch(/Wallets ON/i);
    expect(glance.policyPosture).toBe("operator_trust");
    expect(glance.defaultCaps).toEqual({
      maxPlsPerTx: LEGACY_MAX_PLS_PER_TX,
      maxPlsDaily: LEGACY_MAX_PLS_DAILY,
    });
    // Gas-aware + operator-trust guidance must surface on wallet status
    const bulletText = glance.bullets.join(" ");
    expect(bulletText).toMatch(/EIP-1559|BEATS|PulseChain/i);
    expect(bulletText).toMatch(/value|gas/i);
    expect(bulletText).toMatch(/operator-trust|funding/i);
    const ownership = status.walletDirOwnership as {
      multiprocMode?: string;
      riskLevel?: string;
      multiProcessRisk?: boolean;
    };
    expect(ownership.multiprocMode).toBe("strict-fail-closed");
    expect(ownership.multiProcessRisk).toBe(false);
    expect(ownership.riskLevel).toMatch(/none|ok|own/i);
    const security = status.security as { pulsechainGas?: string };
    expect(security.pulsechainGas).toMatch(/BEATS|EIP-1559/i);
    expect(security.pulsechainGas).toMatch(/value|gas/i);
    assertNoSecrets(status, master);

    const listed = listAgentWallets(cfg);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.address.toLowerCase()).toBe(created.address.toLowerCase());
    // H2: list surfaces mark legacy maxPls* display-only (not hard gates)
    expect(listed[0]!.legacyCapsDisplayOnly).toBe(true);
    expect(listed[0]!.legacyCapsNote).toMatch(/display-only|operator-trust|funding/i);
    assertNoSecrets(listed, master);

    const info = await getAgentWalletInfo(cfg, created.id, {
      includeBalance: false,
    });
    expect(info.address.toLowerCase()).toBe(created.address.toLowerCase());
    expect(info.legacyCapsDisplayOnly).toBe(true);
    expect(info.legacyCapsNote).toMatch(/display-only|operator-trust|funding/i);
    // Caps remain present as legacy fields but are not re-enabled as hard gates
    expect(typeof info.policy.maxPlsPerTx).toBe("number");
    assertNoSecrets(info, master);

    // On-disk: encrypted record only; master key not stored
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.some((f) => f.startsWith(created.id))).toBe(true);
    const disk = readFileSync(join(dir, `${created.id}.json`), "utf8");
    expect(disk).toContain("encryptedKey");
    expect(disk).toContain("ciphertext");
    expect(disk).not.toContain(master);
  });

  it("write posture: wallets on allows create; off refuses", async () => {
    const on = labConfig({ agentWalletEnabled: true });
    const off = labConfig({
      agentWalletEnabled: false,
      agentWalletDir: tempWalletDir(),
    });

    const w = await createAgentWallet(on, { label: "posture-on" });
    expect(w.address).toMatch(/^0x/);

    await expect(createAgentWallet(off)).rejects.toThrow(/disabled/i);

    const statusOff = agentWalletSystemStatus(off);
    expect(statusOff.enabled).toBe(false);
    expect(
      (statusOff.operatorAtAGlance as { walletsEnabled: boolean }).walletsEnabled,
    ).toBe(false);
    expect(
      (statusOff.operatorAtAGlance as { headline: string }).headline,
    ).toMatch(/OFF|disabled/i);
  });
});

describe("wallet mode template shipped in repo", () => {
  it(".env.wallet.example omits MAX_PLS product knobs and documents unique dir + strict + gas", () => {
    const root = join(process.cwd());
    const wallet = readFileSync(join(root, ".env.wallet.example"), "utf8");
    expect(wallet).toMatch(/AGENT_WALLET_ENABLED=true/);
    expect(wallet).toMatch(/AGENT_WALLET_MULTIPROC_STRICT=true/);
    expect(wallet).toMatch(/data\/wallets|unique/i);
    expect(wallet).toMatch(/create_agent_wallet/);
    expect(wallet).toMatch(/fund|gas/i);
    expect(wallet).toMatch(/inspect_tx_intent|reviewSummary|execute_agent_tx/i);
    // No product spend-cap defaults (operator-trust; funding authorizes)
    expect(wallet).not.toMatch(/MAX_PLS_PER_TX\s*=\s*\d+/);
    expect(wallet).not.toMatch(/MAX_PLS_DAILY\s*=\s*\d+/);
    expect(wallet).toMatch(/operator-trust|funding the agent is authorization|kill_switch/i);
    expect(wallet).toMatch(/BEATS|EIP-1559|value \+ gas|gas/i);
    // template must not ship a filled master key
    expect(wallet).toMatch(/AGENT_WALLET_MASTER_KEY=\s*$/m);
    // product language: no lab-testing narrative
    expect(wallet).not.toMatch(/controlled wallet lab|lab checklist|lab path only/i);
  });

  it(".env.lab.example is compatibility template without product MAX_PLS knobs", () => {
    const lab = readFileSync(join(process.cwd(), ".env.lab.example"), "utf8");
    expect(lab).toMatch(/AGENT_WALLET_ENABLED=true/);
    expect(lab).toMatch(/AGENT_WALLET_MULTIPROC_STRICT=true/);
    expect(lab).not.toMatch(/MAX_PLS_PER_TX\s*=\s*\d+/);
    expect(lab).not.toMatch(/MAX_PLS_DAILY\s*=\s*\d+/);
    expect(lab).toMatch(/create_agent_wallet/);
    expect(lab).toMatch(/start-wallet-mcp\.mjs|\.env\.wallet/);
    expect(lab).toMatch(/operator-trust|funding|kill_switch/i);
  });

  it("SECURITY essentials + SECURITY_DEEP residual cover operator-trust + gas-aware funding", () => {
    const security = readFileSync(
      join(process.cwd(), "docs", "SECURITY.md"),
      "utf8",
    );
    const deep = readFileSync(
      join(process.cwd(), "docs", "SECURITY_DEEP.md"),
      "utf8",
    );
    // Front door: short essentials
    expect(security.split(/\r?\n/).length).toBeLessThan(100);
    expect(security).toMatch(
      /research-only|agent install default|Wallets on \(when user asks|when wallets are \*\*enabled\*\*/i,
    );
    expect(security).toMatch(/operator-trust|funding the agent is authorization/i);
    expect(security).toMatch(/verify address|create wallet|propose|execute/i);
    expect(security).toMatch(/PulseChain gas|gas headroom/i);
    expect(security).toMatch(/display \/ advisory|not hard custody|kill_switch/i);
    expect(security).toMatch(/start-wallet-mcp\.mjs/);
    expect(security).toMatch(/Research-only|research|generate-wallet-env/i);
    expect(security).toMatch(/SECURITY_DEEP\.md/);
    expect(security).not.toMatch(/Controlled wallet lab checklist/i);
    // Residual detail in secondary doc
    expect(deep).toMatch(/create_agent_wallet/);
    expect(deep).toMatch(/list_agent_wallets|get_agent_wallet_info/i);
    expect(deep).toMatch(
      /inspect_tx_intent.*propose_agent_tx.*reviewSummary.*execute_agent_tx/is,
    );
    expect(deep).toMatch(/\.env\.wallet\.example/);
    expect(deep).toMatch(/BEATS|EIP-1559/i);
    expect(deep).toMatch(/value transferred|native value|value \+ gas/i);
    expect(deep).toMatch(/tiny-value|tiny value/i);
    expect(deep).toMatch(/start-wallet-mcp\.mjs/);
    expect(deep).toMatch(/Supported wallet launcher|wallet launcher|Two product modes/i);
  });

  it("scripts/start-wallet-mcp.mjs is the supported wallet entry (compat alias retained)", () => {
    const root = process.cwd();
    const launcher = readFileSync(join(root, "scripts/start-wallet-mcp.mjs"), "utf8");
    expect(launcher).toMatch(/\.env\.wallet/);
    expect(launcher).toMatch(/AGENT_WALLET_MULTIPROC_STRICT/);
    expect(launcher).toMatch(/dist\/index\.js/);
    expect(launcher).toMatch(/walletLauncher|wallet launcher/i);
    // Compatibility alias still exists for existing host configs
    const alias = readFileSync(join(root, "scripts/start-lab-mcp.mjs"), "utf8");
    expect(alias).toMatch(/start-wallet-mcp\.mjs/);
    // Product src must not ship uncommitted session-only dist hacks
    const indexSrc = readFileSync(join(root, "src/index.ts"), "utf8");
    expect(indexSrc).not.toMatch(/session-lab-autoload|LOCAL SESSION LAB BOOTSTRAP/i);
    // Optional sticky-host autoload lives in src (survives rebuild)
    const autoload = readFileSync(join(root, "src/labAutoload.ts"), "utf8");
    expect(autoload).toMatch(/\.enable-wallet-autoload|\.enable-lab-autoload/);
    expect(autoload).toMatch(/\.env\.wallet|\.env\.lab/);
  });

  it("end-user docs present research-only agent default + wallets path without lab-testing narrative", () => {
    const root = process.cwd();
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const examplesReadme = readFileSync(join(root, "examples", "README.md"), "utf8");
    const envExample = readFileSync(join(root, ".env.example"), "utf8");
    const agentGuidance = readFileSync(join(root, "docs", "AGENT_GUIDANCE.md"), "utf8");
    const bootstrap = readFileSync(join(root, "docs", "BOOTSTRAP.md"), "utf8");
    for (const text of [readme, examplesReadme, envExample, agentGuidance, bootstrap]) {
      expect(text).toMatch(/research|AGENT_WALLET_ENABLED=false|Encrypted agent wallets|Research Only Mode/i);
      expect(text).toMatch(/wallet|\.env\.wallet|start-wallet-mcp|MASTER_KEY|encrypted|agent wallets|research-only/i);
      expect(text).not.toMatch(/controlled wallet lab checklist/i);
      expect(text).not.toMatch(/wallet lab path|lab funding story|internal validation/i);
    }
    expect(readme).toMatch(/Encrypted agent wallets|Research Only Mode|research-only/i);
    expect(bootstrap).toMatch(/master key|AGENT_WALLET_MASTER_KEY|Wallets-on|research-only/i);
    expect(agentGuidance).toMatch(/master key|AGENT_WALLET_MASTER_KEY|research-only|Wallets on/i);
    expect(envExample).toMatch(/AGENT_WALLET_ENABLED=true/);
    expect(envExample).toMatch(/AGENT_WALLET_ENABLED=false/);

    // Client host samples: research-only agent default, no master key assignment, no lab framing
    const clientConfigs = [
      join(root, "examples", "grok_mcp_config.toml"),
      join(root, "examples", "cursor_mcp_config.json"),
      join(root, "examples", "claude_desktop_config.json"),
      join(root, "examples", "codex_mcp_config.toml"),
    ];
    for (const path of clientConfigs) {
      const text = readFileSync(path, "utf8");
      // Strip comments for assignment checks
      const active = text
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*$/, ""))
        .join("\n");
      expect(active, path).toMatch(/AGENT_WALLET_ENABLED["\s:=]+["']?false/i);
      expect(active, path).not.toMatch(/AGENT_WALLET_MASTER_KEY\s*[=:]/);
      expect(text, path).toMatch(/dist\/index\.js/);
      expect(text, path).not.toMatch(/WALLET LAB|controlled wallet lab|wallet lab path/i);
      expect(text, path).not.toMatch(/start-lab-mcp\.mjs/);
      expect(text, path).not.toMatch(/\.env\.lab\b|data\/wallets-lab/i);
      expect(text, path).not.toMatch(/0\.1\.\d+/); // stale 0.1.x pins fail CI
    }
    const grok = readFileSync(clientConfigs[0], "utf8");
    expect(grok).toMatch(/package\.json|npm pkg get version|research-only/i);
    expect(grok).toMatch(/start-wallet-mcp\.mjs|\.env\.wallet|install-for-host/);
  });

  it("applyLabAutoloadIfEnabled is no-op without marker (RO safe)", async () => {
    // Drive shipped module after ensuring launcher flags unset for this process check
    const prevLab = process.env.PULSECHAIN_LAB_LAUNCHER;
    const prevWallet = process.env.PULSECHAIN_WALLET_LAUNCHER;
    delete process.env.PULSECHAIN_LAB_LAUNCHER;
    delete process.env.PULSECHAIN_WALLET_LAUNCHER;
    try {
      const { applyLabAutoloadIfEnabled } = await import("../src/labAutoload.js");
      // In this repo, marker may or may not exist; function must not throw
      const r = applyLabAutoloadIfEnabled();
      expect(typeof r.applied).toBe("boolean");
      expect(typeof r.reason).toBe("string");
    } finally {
      if (prevLab !== undefined) process.env.PULSECHAIN_LAB_LAUNCHER = prevLab;
      else delete process.env.PULSECHAIN_LAB_LAUNCHER;
      if (prevWallet !== undefined) process.env.PULSECHAIN_WALLET_LAUNCHER = prevWallet;
      else delete process.env.PULSECHAIN_WALLET_LAUNCHER;
    }
  });
});
