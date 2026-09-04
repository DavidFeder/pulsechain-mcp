/**
 * v0.1.20: Docker packaging structural checks on shipped files.
 * Asserts production-sensible Docker defaults (image wallets off / secretless,
 * non-root, no secrets, compose env_file as authoritative config surface)
 * without requiring a live daemon. Runtime default is research-only.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { SERVER_VERSION } from "../src/constants.js";

const root = process.cwd();

function read(rel: string): string {
  const p = join(root, rel);
  expect(existsSync(p), `missing shipped file: ${rel}`).toBe(true);
  return readFileSync(p, "utf8");
}

describe("Docker packaging (v0.1.20 shipped artifacts)", () => {
  it("Dockerfile builds TS, runs dist/index.js, non-root, secretless wallets-off image ENV", () => {
    const df = read("Dockerfile");
    expect(df).toMatch(/FROM node:20-alpine AS builder/);
    expect(df).toMatch(/FROM node:20-alpine AS runner/);
    expect(df).toMatch(/npm run build/);
    expect(df).toMatch(/ENTRYPOINT\s*\[\s*"node"\s*,\s*"dist\/index\.js"\s*\]/);
    expect(df).toMatch(/USER\s+node/);
    // Containers stay secretless; runtime default is research-only
    expect(df).toMatch(/AGENT_WALLET_ENABLED=false/);
    expect(df).toMatch(/secretless|wallets-on/i);
    expect(df).toMatch(/NODE_ENV=production/);
    expect(df).not.toMatch(/AGENT_WALLET_MASTER_KEY=\s*[^\s\\]+/);
    expect(df).not.toMatch(/COPY\s+\.env/);
  });

  it("docker-compose uses env_file .env.docker and does not host-interpolate RPC/wallet keys", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toMatch(/pulsechain-mcp/);
    expect(compose).toMatch(/env_file/);
    expect(compose).toMatch(/\.env\.docker/);
    // Authoritative env_file — must not be optional-silent
    expect(compose).toMatch(/required:\s*true/);
    // Critical: no environment: host interpolation that overrides env_file
    // (Compose ${VAR:-default} comes from host shell / project .env, not env_file)
    expect(compose).not.toMatch(
      /^\s*PULSECHAIN_RPC_URLS:\s*\$\{/m,
    );
    expect(compose).not.toMatch(
      /^\s*AGENT_WALLET_ENABLED:\s*\$\{/m,
    );
    expect(compose).not.toMatch(
      /^\s*LOG_LEVEL:\s*\$\{/m,
    );
    // Docs / comments still mention the keys and networking
    expect(compose).toMatch(/AGENT_WALLET_ENABLED/);
    expect(compose).toMatch(/PULSECHAIN_RPC_URLS|host\.docker\.internal/);
    expect(compose).toMatch(/network_mode:\s*host|host network/i);
    expect(compose).toMatch(/one container|one unique|NOT multi-writer|not multi-writer/i);
    // Wallet volume should be optional/commented guidance, not forced on
    expect(compose).toMatch(/#\s*volumes:|#\s*-\s*pulsechain-mcp-wallets/i);
  });

  it(".env.docker.example keeps wallets off for secretless containers", () => {
    const env = read(".env.docker.example");
    expect(env).toMatch(/AGENT_WALLET_ENABLED=false/);
    expect(env).toMatch(/PULSECHAIN_RPC_URLS=/);
    expect(env).toMatch(/host\.docker\.internal|127\.0\.0\.1:8545/);
    expect(env).toMatch(/Go-Pulse|co-locat|research-only|secretless/i);
    expect(env).toMatch(/one container|unique wallet|NOT multi-writer|not multi-writer/i);
    expect(env).toMatch(/env_file|compose|Docker/i);
    expect(env).not.toMatch(/^AGENT_WALLET_MASTER_KEY=[0-9a-fA-F]{32,}/m);
  });

  it(".dockerignore excludes secrets and wallet data from build context", () => {
    const ignore = read(".dockerignore");
    expect(ignore).toMatch(/^\.env/m);
    expect(ignore).toMatch(/node_modules/);
    expect(ignore).toMatch(/data\/wallets|wallets/);
  });

  it("operator docs document Docker path; human README points agents to bootstrap", () => {
    const readme = read("README.md");
    const boot = read("docs/BOOTSTRAP.md");
    const agent = read("docs/AGENT_GUIDANCE.md");
    const operator = read("docs/OPERATOR.md");
    expect(readme).toMatch(/docs\/BOOTSTRAP\.md/);
    expect(readme).toMatch(/on by default|Encrypted agent wallets/i);
    expect(readme).toMatch(new RegExp(SERVER_VERSION.replace(/\./g, "\\.")));
    expect(boot).toMatch(/OPERATOR\.md/);
    expect(agent).toMatch(/AGENT_WALLET_ENABLED=false|research-only/i);
    expect(operator).toMatch(/## Docker \/ one-command setup/);
    expect(operator).toMatch(/docker compose up/);
    expect(operator).toMatch(/\.env\.docker/);
    expect(operator).toMatch(/env_file|config surface/i);
    expect(operator).toMatch(/host\.docker\.internal/);
    expect(operator).toMatch(/stdio vs HTTP|stdio.*HTTP/i);
    expect(operator).toMatch(/AGENT_WALLET_ENABLED/);
    expect(operator).toMatch(/## Client hosts \(stdio\)|Client hosts/i);
    expect(operator).toMatch(/research-only default|defaults to|product default/i);
  });

  it("Docker packaging posture is documented after changelog flatten", () => {
    // Detailed 0.1.x notes were condensed; operator docs + compose remain authoritative.
    const log = read("CHANGELOG.md");
    expect(log).toMatch(/## \[1\.0\.0\]/);
    const operator = read("docs/OPERATOR.md");
    expect(operator).toMatch(/Docker/i);
    expect(operator).toMatch(/AGENT_WALLET_ENABLED=false|wallets off|research-only/i);
    const compose = read("docker-compose.yml");
    expect(compose).toMatch(/env_file|\.env\.docker/i);
    const deep = read("docs/SECURITY_DEEP.md");
    expect(deep).toMatch(/multi-writer|not a multi-writer|NOT multi-writer/i);
  });

  it("npm package files include docs and examples; bin stays dist/index.js", () => {
    const pkg = JSON.parse(read("package.json")) as {
      files: string[];
      bin: Record<string, string>;
    };
    expect(pkg.files).toEqual(
      expect.arrayContaining(["dist", "README.md", "LICENSE", "docs", "examples", "scripts"]),
    );
    expect(pkg.files).not.toEqual(
      expect.arrayContaining([
        "node_modules",
        "coverage",
        "data",
        "data/wallets",
        ".env",
        ".env.wallet",
      ]),
    );
    expect(pkg.bin["pulsechain-mcp"]).toBe("dist/index.js");
    expect(existsSync(join(root, "docs/BOOTSTRAP.md"))).toBe(true);
    expect(existsSync(join(root, "examples/README.md"))).toBe(true);
    expect(existsSync(join(root, "examples/cursor_mcp_config.json"))).toBe(true);
  });

  it("npm pack dry-run includes BOOTSTRAP and examples, excludes secrets and wallets", () => {
    const r = spawnSync("npm", ["pack", "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toMatch(/docs\/BOOTSTRAP\.md/);
    expect(out).toMatch(/docs\/AGENT_GUIDANCE\.md/);
    expect(out).toMatch(/docs\/SECURITY\.md/);
    expect(out).toMatch(/docs\/OPERATOR\.md/);
    expect(out).toMatch(/examples\/README\.md/);
    expect(out).toMatch(/examples\/cursor_mcp_config\.json/);
    expect(out).toMatch(/scripts\/generate-wallet-env\.mjs/);
    expect(out).toMatch(/scripts\/start-wallet-mcp\.mjs/);
    expect(out).toMatch(/scripts\/install-for-host\.mjs/);
    expect(out).toMatch(/dist\/index\.js/);
    expect(out).not.toMatch(/node_modules\//);
    expect(out).not.toMatch(/(^|\/)coverage\//);
    expect(out).not.toMatch(/data\/wallets/);
    expect(out).not.toMatch(/(^|\/)\.env(\s|$)/);
    expect(out).not.toMatch(/(^|\/)\.env\.wallet(\s|$)/);
  }, 30_000);

  it("version surfaces are 1.0.6", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version).toBe("1.0.6");
    expect(SERVER_VERSION).toBe("1.0.6");
    expect(read("docker-compose.yml")).toMatch(/pulsechain-mcp:1\.0\.6/);
  });
});

/**
 * Live Compose check (skipped only if `docker compose` CLI is unavailable):
 * prove .env.docker values appear in `docker compose config` resolved env —
 * the real shipped path (config does not require a running daemon).
 */
describe("docker compose config respects .env.docker (live)", () => {
  const composeCliOk = (() => {
    const r = spawnSync("docker", ["compose", "version"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    return r.status === 0;
  })();

  it.skipIf(!composeCliOk)(
    "sentinel RPC and wallet flag from .env.docker appear in compose config",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "pcmcp-compose-"));
      const envPath = join(root, ".env.docker");
      const backupPath = join(dir, ".env.docker.backup");
      const hadEnv = existsSync(envPath);
      if (hadEnv) {
        writeFileSync(backupPath, readFileSync(envPath));
      }

      const sentinel =
        "http://sentinel-from-env-docker.example:18545,https://rpc-pulsechain.g4mm4.io";
      try {
        writeFileSync(
          envPath,
          [
            `PULSECHAIN_RPC_URLS=${sentinel}`,
            "AGENT_WALLET_ENABLED=true",
            "LOG_LEVEL=debug",
          ].join("\n") + "\n",
          "utf8",
        );

        const r = spawnSync("docker", ["compose", "config"], {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
          windowsHide: true,
          env: {
            ...process.env,
            // Ensure host shell does not supply competing values
            PULSECHAIN_RPC_URLS: "",
            AGENT_WALLET_ENABLED: "",
            LOG_LEVEL: "",
          },
        });
        expect(r.status, r.stderr || r.stdout).toBe(0);
        const out = `${r.stdout}\n${r.stderr}`;
        expect(out).toMatch(/sentinel-from-env-docker\.example/);
        expect(out).toMatch(
          /AGENT_WALLET_ENABLED:\s*["']?true["']?|AGENT_WALLET_ENABLED=true/i,
        );
        // Must not force the old host-interpolated default when env_file differs
        expect(out).not.toMatch(
          /PULSECHAIN_RPC_URLS:.*host\.docker\.internal:8545,https:\/\/rpc-pulsechain\.g4mm4\.io,https:\/\/rpc\.pulsechain\.com/,
        );
      } finally {
        if (hadEnv) {
          writeFileSync(envPath, readFileSync(backupPath));
        } else if (existsSync(envPath)) {
          unlinkSync(envPath);
        }
      }
    },
  );
});

