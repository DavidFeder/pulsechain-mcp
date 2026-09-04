/**
 * Structural docs tests: ask-agent human README, single bootstrap path,
 * slim SECURITY front + SECURITY_DEEP residual, public doc set, 1.0.6 pins.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SERVER_VERSION } from "../src/constants.js";

const root = process.cwd();

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

describe("human README front door (docs product)", () => {
  it("is short, ask-your-agent first, and points only to bootstrap for agents", () => {
    const readme = read("README.md");
    const lines = readme.split(/\r?\n/).length;
    expect(lines).toBeLessThan(55);
    expect(readme).toMatch(/## Features/i);
    expect(readme).toMatch(/## Setup \(humans\)|ask your AI agent/i);
    expect(readme).toMatch(/Ask your AI agent to finish setup|ask your AI agent to finish/i);
    expect(readme).toMatch(/docs\/BOOTSTRAP\.md/);
    expect(readme).toMatch(/If you are an AI agent/i);
    // Client samples live under examples/; human README may omit the path and
    // point agents only at BOOTSTRAP (which lists the samples).
    expect(readme).toMatch(/Encrypted agent wallets|Research Only Mode|research-only/i);
    // Deep setup / multi-doc catalog must not live in human README
    expect(readme).not.toMatch(/## First-run wallet setup/i);
    expect(readme).not.toMatch(/## Using with Cursor/i);
    expect(readme).not.toMatch(/## Multi-RPC/i);
    expect(readme).not.toMatch(/## Feature matrix/);
    expect(readme).not.toMatch(/docs\/AGENT_GUIDANCE\.md/);
    expect(readme).not.toMatch(/docs\/SECURITY\.md/);
    expect(readme).not.toMatch(/controlled wallet lab checklist/i);
    expect(readme).not.toMatch(/internal validation|lab funding story/i);
    expect(readme).not.toMatch(/@openpulsechain\/mcp-server/i);
    expect(readme).not.toMatch(/openpulsechain/i);
  });

  it("public product docs/examples have no openpulsechain product framing", () => {
    const publicFiles = [
      "README.md",
      "docs/README.md",
      "docs/BOOTSTRAP.md",
      "docs/AGENT_GUIDANCE.md",
      "docs/TOKEN_IDENTITY.md",
      "docs/AGGREGATORS.md",
      "docs/SECURITY.md",
      "docs/SECURITY_DEEP.md",
      "docs/OPERATOR.md",
      "examples/README.md",
      "examples/cursor_mcp_config.json",
      "examples/claude_desktop_config.json",
      "examples/grok_mcp_config.toml",
      "examples/codex_mcp_config.toml",
      "MIGRATION_NOTES.md",
      "RELEASE_NOTES.md",
    ];
    for (const rel of publicFiles) {
      const text = read(rel);
      expect(text, rel).not.toMatch(/@openpulsechain\/mcp-server/i);
      expect(text, rel).not.toMatch(
        /independent of.*openpulsechain|parity with.*openpulsechain|clone of.*openpulsechain/i,
      );
    }
  });

  it("version pin matches package and SERVER_VERSION", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version).toBe(SERVER_VERSION);
    expect(pkg.version).toBe("1.0.6");
    expect(read("README.md")).toMatch(new RegExp(SERVER_VERSION.replace(/\./g, "\\.")));
  });

  it("env templates + config.ts prefer write-only key path (no recommended console.log recipe)", () => {
    for (const rel of [".env.example", ".env.lab.example", "src/config.ts"]) {
      const text = read(rel);
      // Must not recommend print-then-paste generation (review R1/R2)
      expect(text, rel).not.toMatch(
        /node -e ["']console\.log\(require\(['"]crypto['"]\)\.randomBytes/,
      );
      expect(text, rel).toMatch(/generate-wallet-env/);
    }
    const envEx = read(".env.example");
    expect(envEx).toMatch(/write-only|Discouraged|research-only needs no master key/i);
    expect(read("docs/SECURITY.md")).toMatch(/Product vs agent|agent first-install/i);
    expect(read("docs/BOOTSTRAP.md")).toMatch(/Product vs agent|agent first-install/i);
  });

  it("package.json files ship docs and examples that README/BOOTSTRAP require", () => {
    const pkg = JSON.parse(read("package.json")) as {
      files: string[];
      bin: Record<string, string>;
    };
    expect(pkg.files).toEqual(
      expect.arrayContaining(["dist", "README.md", "LICENSE", "docs", "examples", "scripts"]),
    );
    expect(pkg.files).not.toEqual(
      expect.arrayContaining(["node_modules", "coverage", "data", "data/wallets"]),
    );
    expect(pkg.bin["pulsechain-mcp"]).toBe("dist/index.js");
  });

  it("package description and keywords match public metadata", () => {
    const pkg = JSON.parse(read("package.json")) as {
      description: string;
      keywords: string[];
    };
    expect(pkg.description).toMatch(/PulseChain MCP server for AI agents/i);
    expect(pkg.description).toMatch(/encrypted.*wallets|operator-trust wallets/i);
    expect(pkg.description).not.toMatch(/optional encrypted/i);
    for (const kw of [
      "pulsechain",
      "mcp",
      "model-context-protocol",
      "web3",
      "defi",
      "hex",
      "pulsex",
      "agent-wallets",
      "typescript",
      "stdio",
    ]) {
      expect(pkg.keywords, kw).toContain(kw);
    }
  });
});

describe("agent bootstrap + durable rules (docs product)", () => {
  const requiredDocs = [
    "docs/BOOTSTRAP.md",
    "docs/AGENT_GUIDANCE.md",
    "docs/TOKEN_IDENTITY.md",
    "docs/AGGREGATORS.md",
    "docs/SECURITY.md",
    "docs/SECURITY_DEEP.md",
    "docs/README.md",
    "docs/OPERATOR.md",
  ];

  it("required focused docs exist", () => {
    for (const rel of requiredDocs) {
      expect(existsSync(join(root, rel)), rel).toBe(true);
    }
  });

  it("internal archive and V1_READINESS are not shipped", () => {
    expect(existsSync(join(root, "docs/archive"))).toBe(false);
    expect(existsSync(join(root, "docs/V1_READINESS.md"))).toBe(false);
  });

  it("BOOTSTRAP is the single ordered setup checklist", () => {
    const boot = read("docs/BOOTSTRAP.md");
    expect(boot).toMatch(/Start here|top to bottom/i);
    expect(boot).toMatch(/Clone and build|npm run build|npm install/i);
    expect(boot).toMatch(/cursor_mcp_config|codex_mcp_config|install-for-host/i);
    expect(boot).toMatch(/absolute path|REPLACE_WITH_ABSOLUTE_PATH|clone root/i);
    expect(boot).toMatch(/research-only|agent default/i);
    expect(boot).toMatch(/generate-wallet-env|write-only|\.env\.wallet/i);
    expect(boot).toMatch(/Do NOT|anti-pattern/i);
    expect(boot).toMatch(/Pre-reload|Post-reload|reload/i);
    expect(boot).toMatch(/pulsechain_health|agent_wallet_status/i);
    expect(boot).toMatch(/Where next|AGENT_GUIDANCE|TOKEN_IDENTITY|AGGREGATORS|SECURITY/i);
    expect(boot).toMatch(/package\.json|npm pkg get version/);
    // Must not instruct console.log of master key as the primary ceremony
    expect(boot).not.toMatch(
      /Generate a master key[\s\S]{0,80}console\.log\(require\(['"]crypto['"]\)/,
    );
    // First-run path must not require the deep security file
    expect(boot).not.toMatch(/must read.*SECURITY_DEEP|required.*SECURITY_DEEP/i);
  });

  it("docs map and examples README point to the same bootstrap path", () => {
    const map = read("docs/README.md");
    const examples = read("examples/README.md");
    const agent = read("docs/AGENT_GUIDANCE.md");
    expect(map).toMatch(/BOOTSTRAP\.md/);
    expect(map).toMatch(/Human vs agent|ask the agent/i);
    expect(map).not.toMatch(/archive\//i);
    expect(map).not.toMatch(/V1_READINESS/i);
    expect(map).toMatch(/SECURITY\.md/);
    expect(map).toMatch(/SECURITY_DEEP\.md/);
    expect(examples).toMatch(/docs\/BOOTSTRAP\.md/);
    expect(examples).toMatch(/package\.json|npm pkg get version|research-only/i);
    expect(examples).toMatch(/Codex|codex_mcp_config/i);
    expect(examples).toMatch(/install-for-host/);
    expect(agent).toMatch(/BOOTSTRAP\.md/);
  });

  it("SECURITY.md is short essentials only; deep residual lives in SECURITY_DEEP", () => {
    const security = read("docs/SECURITY.md");
    const deep = read("docs/SECURITY_DEEP.md");
    const lines = security.split(/\r?\n/);
    expect(lines.length).toBeLessThan(100);
    expect(security).toMatch(/Essentials|short essentials/i);
    expect(security).toMatch(/research-only|agent install default|Wallets on \(when user asks/i);
    expect(security).toMatch(/AGENT_WALLET_ENABLED=false|Research-only/i);
    expect(security).toMatch(/Funding the agent is authorization|operator-trust/i);
    expect(security).toMatch(/kill_switch/i);
    expect(security).toMatch(/AGENT_WALLET_DIR|Multiproc/i);
    expect(security).toMatch(
      /wallets-on default is `AGENT_WALLET_MULTIPROC_STRICT=true`|wallets-on default is AGENT_WALLET_MULTIPROC_STRICT=true/i,
    );
    expect(security).toMatch(/warn-only opt-out|explicit `false` or `0`/i);
    expect(deep).toMatch(/AGENT_WALLET_MRTR_SECRET/);
    expect(deep).toMatch(/HTTP_TRANSPORT_PORT/);
    expect(deep).toMatch(/process-local random secret|stdio wallets-on/i);
    expect(security).toMatch(/AES-256-GCM|encrypted/i);
    expect(security).toMatch(/Keys never in chat|never commit|never print/i);
    expect(security).toMatch(/generate-wallet-env|start-wallet-mcp|\.env\.wallet/i);
    expect(security).toMatch(/BOOTSTRAP\.md/);
    expect(security).toMatch(/SECURITY_DEEP\.md/);
    // Front door must not carry long residual tables
    expect(security).not.toMatch(/Write tools gated by multiproc strict/i);
    expect(security).not.toMatch(/Crash windows \(operator guidance\)/i);
    expect(security).not.toMatch(/## Encryption \(AES-256-GCM\)/);
    // Deep residual honesty in secondary doc
    expect(deep).toMatch(/Secondary reference only|not required for first-run|not required for bootstrap/i);
    expect(deep).toMatch(/SECURITY\.md/);
    expect(deep).toMatch(/Write tools gated by multiproc strict/i);
    expect(deep).toMatch(/not multi-writer-safe|NOT multi-writer-safe/i);
    expect(deep).toMatch(/settle_interrupted_broadcast/);
    expect(deep).toMatch(/before barrier|pre-barrier|After chain accept, before barrier/i);
  });

  it("active product docs have no lab/testing product framing", () => {
    const active = [
      "README.md",
      "docs/README.md",
      "docs/BOOTSTRAP.md",
      "docs/AGENT_GUIDANCE.md",
      "docs/TOKEN_IDENTITY.md",
      "docs/AGGREGATORS.md",
      "docs/SECURITY.md",
      "docs/SECURITY_DEEP.md",
      "docs/OPERATOR.md",
      "examples/README.md",
      ".env.wallet.example",
      ".env.example",
      ".env.lab.example",
      ".env.docker.example",
      "CHANGELOG.md",
      "RELEASE_NOTES.md",
    ];
    for (const rel of active) {
      const text = read(rel);
      // CHANGELOG may document historical purge work; only ban product-mode phrases as current framing
      if (rel === "CHANGELOG.md") {
        // New 1.0.0 section must not reintroduce lab-testing as a product mode
        const head = text.slice(0, text.indexOf("## [0.4.1]"));
        expect(head, rel).not.toMatch(/controlled lab|controlled wallet lab/i);
        expect(head, rel).not.toMatch(/lab checklist|lab wallets|lab funding story/i);
        expect(head, rel).not.toMatch(/internal validation/i);
        expect(head, rel).not.toMatch(/wallet lab path/i);
        continue;
      }
      expect(text, rel).not.toMatch(/controlled lab|controlled wallet lab/i);
      expect(text, rel).not.toMatch(/lab checklist|lab wallets|lab funding story/i);
      expect(text, rel).not.toMatch(/internal validation/i);
      expect(text, rel).not.toMatch(/wallet lab path/i);
    }
  });

  it("AGENT_GUIDANCE remains the operating manual for workflows", () => {
    const agent = read("docs/AGENT_GUIDANCE.md");
    expect(agent).toMatch(/Address beats ticker|address beats ticker/i);
    expect(agent).toMatch(/pHEX/);
    expect(agent).toMatch(/Research workflow/i);
    expect(agent).toMatch(/Swap workflow/i);
    expect(agent).toMatch(
      /quote.*prepare.*propose.*review.*execute|propose_agent_tx[\s\S]*execute_agent_tx/i,
    );
    expect(agent).toMatch(/Stale-quote rule/i);
    expect(agent).toMatch(/re-quote/i);
    expect(agent).toMatch(/Kill switch/i);
    expect(agent).toMatch(/kill_switch/);
    expect(agent).toMatch(/Trust|noise|advisory/i);
  });

  it("TOKEN_IDENTITY and AGGREGATORS durable rules still present", () => {
    const id = read("docs/TOKEN_IDENTITY.md");
    expect(id).toMatch(/Address identity always beats ticker|address.*beats.*ticker/i);
    expect(id).toMatch(/pHEX/);
    expect(id).toMatch(/eHEX|e\*/i);
    expect(id).toMatch(/pDAI|bridged DAI/i);
    expect(id).toMatch(/bridge\.pulsechain\.com/);
    expect(id).toMatch(/dexscreener_search|Discovery only/i);
    const agg = read("docs/AGGREGATORS.md");
    expect(agg).toMatch(/piteas_quote/i);
    expect(agg).toMatch(/keyless/i);
    expect(agg).toMatch(/switch_quote|SWITCH_API_KEY/i);
    expect(agg).toMatch(/prepare/i);
    expect(agg).toMatch(/propose_agent_tx|execute_agent_tx/);
    expect(agg).toMatch(/Stale-quote|re-quote/i);
  });

  it("OpenAI/Codex example is research-only without master key", () => {
    expect(existsSync(join(root, "examples/codex_mcp_config.toml"))).toBe(true);
    const codex = read("examples/codex_mcp_config.toml");
    expect(codex).toMatch(/\[mcp_servers\.pulsechain-mcp\]/);
    expect(codex).toMatch(/REPLACE_WITH_ABSOLUTE_PATH\/dist\/index\.js/);
    expect(codex).toMatch(/AGENT_WALLET_ENABLED\s*=\s*"false"/);
    expect(codex).not.toMatch(/AGENT_WALLET_MASTER_KEY\s*=/);
    expect(codex).not.toMatch(/HTTP_TRANSPORT_PORT\s*[=:]/);
  });

  it("RELEASE_NOTES has v1.0.6 plus prior 1.0.x content", () => {
    const notes = read("RELEASE_NOTES.md");
    expect(notes).toMatch(/1\.0\.6/);
    expect(notes).toMatch(/1\.0\.5/);
    expect(notes).toMatch(/1\.0\.4/);
    expect(notes).toMatch(/1\.0\.3/);
    expect(notes).toMatch(/1\.0\.2/);
    expect(notes).toMatch(/1\.0\.1/);
    expect(notes).toMatch(/1\.0\.0/);
    expect(notes).toMatch(/2\.0\.0/);
    expect(notes).toMatch(/phiat_dashboard|piteas_accumulation_plan|getPiteasQuote/i);
    expect(notes).toMatch(/key-install hygiene|generate-wallet-env|write-only|install-for-host|\.env\.wallet/i);
    expect(notes).toMatch(/MAX_PLS|spend-cap|hard spend|operator-trust/i);
    expect(notes).toMatch(/multiproc|process-local|Windows file modes|Host reload/i);
    expect(notes).toMatch(/About|topics/i);
    expect(notes).not.toMatch(/V1_READINESS|docs\/archive/i);
    expect(notes).not.toMatch(/repository\s+(stays\s+)?\*{0,2}private|keep\s+\*{0,2}private/i);
  });

  it("CHANGELOG is public-facing history with 1.0.6 plus prior 1.0.x analytics and residual honesty", () => {
    const log = read("CHANGELOG.md");
    const lines = log.split(/\r?\n/).length;
    expect(lines).toBeLessThan(360);
    expect(log).toMatch(/## \[1\.0\.6\]/);
    expect(log).toMatch(/## \[1\.0\.5\]/);
    expect(log).toMatch(/## \[1\.0\.4\]/);
    expect(log).toMatch(/## \[1\.0\.3\]/);
    expect(log).toMatch(/## \[1\.0\.2\]/);
    expect(log).toMatch(/## \[1\.0\.1\]/);
    expect(log).toMatch(/## \[1\.0\.0\]/);
    expect(log).toMatch(/phiat_dashboard|piteas_accumulation_plan/i);
    expect(log).toMatch(/key-install hygiene|generate-wallet-env|console\.log|write-only|research-only/i);
    expect(log).toMatch(/ghost|pair ranking|legacyCapsDisplayOnly|priceUsdReady|executionReady/i);
    expect(log).toMatch(/MAX_PLS|spend-cap|product-facing/i);
    expect(log).toMatch(/2\.0\.0/);
    expect(log).toMatch(/dual-era|dual:2026-07-28/i);
    expect(log).toMatch(/host-strength/i);
    expect(log).toMatch(/process-local|Multiproc is process-local/i);
    expect(log).toMatch(/upstream-quality/i);
    expect(log).toMatch(/multi-tenant SaaS/i);
    expect(log).toMatch(/## Earlier history|0\.1\.x|0\.2\.x|0\.4\./i);
    expect(log).not.toMatch(/repository stays \*\*private\*\*|Flip GitHub visibility/i);
    expect(log).not.toMatch(/compare\/v0|ticket #|R12|R15/i);
    expect(log).not.toMatch(/C:\\Users\\/i);
    expect(log).not.toMatch(/AGENT_WALLET_MASTER_KEY\s*=\s*[0-9a-fA-F]{32,}/i);
    expect(log).not.toMatch(/docs\/V1_READINESS|docs\/archive/i);
  });

  it("examples and env templates omit product MAX_PLS cap assignments", () => {
    const surfaces = [
      "examples/grok_mcp_config.toml",
      "examples/cursor_mcp_config.json",
      "examples/claude_desktop_config.json",
      "examples/codex_mcp_config.toml",
      ".env.example",
      ".env.docker.example",
      ".env.wallet.example",
      ".env.lab.example",
    ];
    for (const rel of surfaces) {
      const text = read(rel);
      // No product default assignments (active or commented-in with numbers)
      expect(text, rel).not.toMatch(/MAX_PLS_PER_TX\s*[=:]\s*"?\d+/);
      expect(text, rel).not.toMatch(/MAX_PLS_DAILY\s*[=:]\s*"?\d+/);
      expect(text, rel).not.toMatch(/MAX_PLS_PER_TX=10\b|MAX_PLS_DAILY=50\b/);
      expect(text, rel).not.toMatch(/MAX_PLS_PER_TX=500\b|MAX_PLS_DAILY=2000\b/);
    }
  });

  it("cross-doc links avoid dead root README anchors and removed archive paths", () => {
    const readme = read("README.md");
    const boot = read("docs/BOOTSTRAP.md");
    const operator = read("docs/OPERATOR.md");
    const examples = read("examples/README.md");
    const security = read("docs/SECURITY.md");
    const migration = read("MIGRATION_NOTES.md");

    expect(readme).toMatch(/docs\/BOOTSTRAP\.md/);
    expect(boot).toMatch(/npm run build/);
    expect(operator).toMatch(/## Docker \/ one-command setup/);
    expect(operator).toMatch(/## Multi-RPC/);
    expect(operator).toMatch(/AGENT_WALLET_MRTR_SECRET/);
    expect(operator).toMatch(/wallets-on: `true` if unset\/empty/);
    expect(operator).not.toMatch(/archive\/pulsechainstats-investigation/);
    expect(security).toMatch(/research-only|agent install default|Wallets on \(when user asks/i);
    expect(security).toMatch(/AGENT_WALLET_ENABLED=false|Research-only/i);

    for (const [name, text] of [
      ["examples/README.md", examples],
      ["docs/SECURITY.md", security],
      ["MIGRATION_NOTES.md", migration],
      ["docs/BOOTSTRAP.md", boot],
      ["docs/OPERATOR.md", operator],
    ] as const) {
      expect(text, name).not.toMatch(/README\.md#known-limitations/i);
      expect(text, name).not.toMatch(/README\.md#multi-rpc-configuration/i);
      expect(text, name).not.toMatch(/README\.md#first-run-wallet-setup/i);
      expect(text, name).not.toMatch(/README\.md#client-wiring/i);
      expect(text, name).not.toMatch(/docs\/archive|V1_READINESS/i);
    }

    expect(examples).toMatch(/docs\/OPERATOR\.md#docker/i);
    expect(migration).toMatch(/AGENT_GUIDANCE\.md|examples\/README\.md/i);
  });
});
