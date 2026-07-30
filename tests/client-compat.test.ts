/**
 * Cursor / Grok Build / Claude Desktop stdio compatibility.
 * Drives shipped clientCompat helpers + structural checks on example configs and README.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  describeTransportMode,
  formatFatalStartupHint,
  isStdioClientConfigSafe,
  STDIO_HOST_SAFE_ENV_DEFAULTS,
} from "../src/clientCompat.js";
import { SERVER_VERSION } from "../src/constants.js";

const root = process.cwd();

function readExample(name: string): string {
  const p = join(root, "examples", name);
  expect(existsSync(p), `missing examples/${name}`).toBe(true);
  return readFileSync(p, "utf8");
}

describe("clientCompat helpers (shipped)", () => {
  it("formatFatalStartupHint mentions stdio hosts and wallets-on first-run", () => {
    const hint = formatFatalStartupHint();
    expect(hint).toMatch(/Cursor|Grok|Claude/i);
    expect(hint).toMatch(/HTTP_TRANSPORT_PORT/);
    expect(hint).toMatch(/MASTER_KEY|master key|research-only|AGENT_WALLET_ENABLED=false/i);
    expect(hint).toMatch(/dist\/index\.js|npm run build/i);
    expect(hint).toMatch(/unique AGENT_WALLET_DIR|agent_wallet_status|inspect/i);
  });

  it("describeTransportMode distinguishes stdio vs http for hosts", () => {
    const stdio = describeTransportMode(undefined);
    expect(stdio.mode).toBe("stdio");
    expect(stdio.clientNote).toMatch(/Cursor|Grok|Claude|stdio/i);

    const http = describeTransportMode(8787);
    expect(http.mode).toBe("http");
    expect(http.clientNote).toMatch(/8787|HTTP|not for Cursor/i);
  });

  it("safe env defaults keep wallets enabled (product default)", () => {
    expect(STDIO_HOST_SAFE_ENV_DEFAULTS.AGENT_WALLET_ENABLED).toBe("true");
  });
});

describe("example client configs (structural, shipped files)", () => {
  const files = [
    "cursor_mcp_config.json",
    "grok_mcp_config.toml",
    "claude_desktop_config.json",
  ] as const;

  it.each(files)("%s is wallets-on, stdio-safe, placeholder paths", (name) => {
    const src = readExample(name);
    const check = isStdioClientConfigSafe(src);
    expect(check.reasons, check.reasons.join("; ")).toEqual([]);
    expect(check.ok).toBe(true);
    expect(src).toMatch(/REPLACE_WITH_ABSOLUTE_PATH\/dist\/index\.js/);
    expect(src).toMatch(/REPLACE_WITH_ABSOLUTE_PATH\/data\/wallets/);
    expect(src).not.toMatch(
      /REPLACE_WITH_ABSOLUTE_PATH\/[^/\s"'\\\]]+\/dist\/index\.js/,
    );
    expect(src).not.toMatch(
      /REPLACE_WITH_ABSOLUTE_PATH\/[^/\s"'\\\]]+\/data\/wallets/,
    );
  });

  it("cursor JSON is valid mcpServers shape with wallets-on placeholders", () => {
    const raw = readExample("cursor_mcp_config.json");
    const json = JSON.parse(raw) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const srv = json.mcpServers["pulsechain-mcp"];
    expect(srv).toBeDefined();
    expect(srv.command).toBe("node");
    expect(srv.args[0]).toBe("REPLACE_WITH_ABSOLUTE_PATH/dist/index.js");
    expect(srv.env.AGENT_WALLET_DIR).toBe("REPLACE_WITH_ABSOLUTE_PATH/data/wallets");
    expect(srv.env.AGENT_WALLET_ENABLED).toBe("true");
    expect(srv.env.AGENT_WALLET_MASTER_KEY).toMatch(/^REPLACE_/);
    expect(srv.env.HTTP_TRANSPORT_PORT).toBeUndefined();
  });

  it("isStdioClientConfigSafe rejects double-nested PulseChainMCP segment", () => {
    const bad =
      'args = ["REPLACE_WITH_ABSOLUTE_PATH/PulseChainMCP/dist/index.js"]\n' +
      'AGENT_WALLET_ENABLED = "true"\n' +
      'AGENT_WALLET_MASTER_KEY = "REPLACE_WITH_64_CHAR_HEX_MASTER_KEY"\n';
    const check = isStdioClientConfigSafe(bad);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/no intermediate folder/i);
  });

  it("isStdioClientConfigSafe accepts research-only false without master key", () => {
    const ro =
      'args = ["REPLACE_WITH_ABSOLUTE_PATH/dist/index.js"]\n' +
      'AGENT_WALLET_ENABLED = "false"\n' +
      'AGENT_WALLET_DIR = "REPLACE_WITH_ABSOLUTE_PATH/data/wallets"\n';
    const check = isStdioClientConfigSafe(ro);
    expect(check.ok, check.reasons.join("; ")).toBe(true);
  });

  it("grok TOML uses wallets-on stdio shape", () => {
    const src = readExample("grok_mcp_config.toml");
    expect(src).toMatch(/\[mcp_servers\.pulsechain-mcp\]/);
    expect(src).toMatch(/command\s*=\s*"node"/);
    expect(src).toMatch(/args\s*=\s*\[/);
    expect(src).toMatch(/\[mcp_servers\.pulsechain-mcp\.env\]/);
    expect(src).toMatch(/AGENT_WALLET_ENABLED\s*=\s*"true"/);
    expect(src).toMatch(/AGENT_WALLET_MASTER_KEY\s*=\s*"REPLACE_/);
    expect(src).not.toMatch(/HTTP_TRANSPORT_PORT\s*[=:]/);
  });

  it("examples/README documents Cursor, Grok, and Codex", () => {
    const readme = readExample("README.md");
    expect(readme).toMatch(/Cursor/i);
    expect(readme).toMatch(/Grok/i);
    expect(readme).toMatch(/Codex/i);
    expect(readme).toMatch(/codex_mcp_config\.toml/);
    expect(readme).toMatch(/HTTP_TRANSPORT_PORT/);
    expect(readme).toMatch(/AGENT_WALLET_ENABLED/);
    expect(readme).toMatch(/1\.0\.0/);
  });

  it("codex TOML uses wallets-on stdio shape", () => {
    const src = readExample("codex_mcp_config.toml");
    expect(src).toMatch(/\[mcp_servers\.pulsechain-mcp\]/);
    expect(src).toMatch(/command\s*=\s*"node"/);
    expect(src).toMatch(/args\s*=\s*\[/);
    expect(src).toMatch(/\[mcp_servers\.pulsechain-mcp\.env\]/);
    expect(src).toMatch(/AGENT_WALLET_ENABLED\s*=\s*"true"/);
    expect(src).toMatch(/AGENT_WALLET_MASTER_KEY\s*=\s*"REPLACE_/);
    expect(src).not.toMatch(/HTTP_TRANSPORT_PORT\s*[=:]/);
  });
});

describe("README + agent docs client pointers (structural)", () => {
  it("human README points at bootstrap; agent docs own host wiring depth", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const boot = readFileSync(join(root, "docs", "BOOTSTRAP.md"), "utf8");
    const agent = readFileSync(join(root, "docs", "AGENT_GUIDANCE.md"), "utf8");
    // Client samples are listed in BOOTSTRAP / examples/README; human README
    // may omit the examples/ path and only point agents at BOOTSTRAP.
    expect(readme).toMatch(/docs\/BOOTSTRAP\.md/);
    expect(readme).toMatch(/If you are an AI agent/i);
    expect(readme).toMatch(/on by default|Encrypted agent wallets/i);
    expect(boot).toMatch(/cursor_mcp_config|Cursor/i);
    expect(boot).toMatch(/grok_mcp_config|Grok/i);
    expect(boot).toMatch(/codex_mcp_config|Codex/i);
    expect(agent).toMatch(/cursor_mcp_config|Cursor/i);
    expect(agent).toMatch(/\.cursor\/mcp\.json|Cursor MCP/i);
    expect(agent).toMatch(/\.grok\/config\.toml/);
    expect(agent).toMatch(/\.codex\/config\.toml/);
    expect(agent).toMatch(/AGENT_WALLET_ENABLED=false|research-only/i);
    const identity = readFileSync(join(root, "docs", "TOKEN_IDENTITY.md"), "utf8");
    expect(identity).toMatch(/bridged DAI|pDAI|eHEX/i);
    expect(identity).toMatch(/bridge\.pulsechain\.com/);
  });

  it("SERVER_VERSION matches release line", () => {
    expect(SERVER_VERSION).toBe("1.0.0");
  });
});

describe("docs hygiene (shipped SECURITY essentials + deep residual)", () => {
  it("essentials front door is short; multiproc honesty lives in SECURITY_DEEP", () => {
    const security = readFileSync(join(root, "docs", "SECURITY.md"), "utf8");
    const deep = readFileSync(join(root, "docs", "SECURITY_DEEP.md"), "utf8");
    expect(security.split(/\r?\n/).length).toBeLessThan(100);
    expect(security).toMatch(/operator-trust|funding the agent is authorization/i);
    expect(security).toMatch(/host UX only|not a cryptographic security product/i);
    expect(security).toMatch(/on by default|Wallets on \(default\)/i);
    expect(security).toMatch(/SECURITY_DEEP\.md/);
    expect(security).not.toMatch(/Write tools gated by multiproc strict/i);
    expect(deep).toMatch(/Write tools gated by multiproc strict/i);
    expect(deep).toMatch(/settle_interrupted_broadcast/);
    expect(deep).toMatch(/not multi-writer-safe|NOT multi-writer-safe/i);
    expect(deep).toMatch(/before barrier|pre-barrier|After chain accept, before barrier/i);
    expect(deep).toMatch(/not.*distributed exactly-once|not distributed exactly-once/i);
    expect(deep).not.toMatch(/distributed lock that serializes/i);
    expect(deep).toMatch(/not hard gates|not a custody-policy/i);
  });
});

describe("stdio remains default when HTTP_TRANSPORT_PORT unset", () => {
  it("describeTransportMode(undefined) is stdio (index main uses this branch)", () => {
    expect(describeTransportMode(undefined).mode).toBe("stdio");
    const indexSrc = readFileSync(join(root, "src", "index.ts"), "utf8");
    expect(indexSrc).toMatch(/startStdio\(config\)/);
    expect(indexSrc).toMatch(/httpTransportPort/);
    expect(indexSrc).toMatch(/formatFatalStartupHint/);
  });
});
