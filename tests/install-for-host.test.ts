/**
 * Drives shipped install / write-only key helpers (scripts/lib/*).
 * Temp dirs only; never embeds real operator secrets in the suite.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  cpSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createWalletEnvWriteOnly, looksLikeMasterKeyHex } from "../scripts/lib/wallet-env.mjs";
import {
  installForHost,
  buildHostConfigText,
  resolveInstallPaths,
} from "../scripts/lib/install-for-host-core.mjs";

const repoRoot = process.cwd();

function makeCloneSim(): string {
  const dir = mkdtempSync(join(tmpdir(), "pcmcp-install-"));
  // Minimal clone simulation: example + launcher + dist stub
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.js"), "// stub\n", "utf8");
  writeFileSync(
    join(dir, "scripts", "start-wallet-mcp.mjs"),
    "// launcher stub\n",
    "utf8",
  );
  // Copy real example template from repo
  const exampleSrc = join(repoRoot, ".env.wallet.example");
  if (existsSync(exampleSrc)) {
    cpSync(exampleSrc, join(dir, ".env.wallet.example"));
  } else {
    writeFileSync(
      join(dir, ".env.wallet.example"),
      "AGENT_WALLET_ENABLED=true\nAGENT_WALLET_MASTER_KEY=\nAGENT_WALLET_DIR=./data/wallets\n",
      "utf8",
    );
  }
  return dir;
}

describe("write-only wallet env (shipped wallet-env.mjs)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeCloneSim();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates .env.wallet with key in file only; messages never contain the key", () => {
    const result = createWalletEnvWriteOnly({ cloneRoot: dir });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(existsSync(join(dir, ".env.wallet"))).toBe(true);

    const body = readFileSync(join(dir, ".env.wallet"), "utf8");
    const keyMatch = body.match(/^AGENT_WALLET_MASTER_KEY=([0-9a-fA-F]{64})\s*$/m);
    expect(keyMatch, "key must be written into .env.wallet").toBeTruthy();
    const key = keyMatch![1]!;

    const joined = result.messages.join("\n");
    expect(joined).not.toContain(key);
    expect(looksLikeMasterKeyHex(joined)).toBe(false);
    expect(joined).toMatch(/Created|\.env\.wallet|not printed/i);
  });

  it("refuses overwrite when .env.wallet already exists", () => {
    const first = createWalletEnvWriteOnly({ cloneRoot: dir });
    expect(first.ok).toBe(true);
    const before = readFileSync(join(dir, ".env.wallet"), "utf8");

    const second = createWalletEnvWriteOnly({ cloneRoot: dir });
    expect(second.ok).toBe(false);
    expect(second.code).toBe("ENV_EXISTS");
    expect(second.messages.join(" ")).toMatch(/already exists|refusing/i);
    expect(looksLikeMasterKeyHex(second.messages.join("\n"))).toBe(false);
    expect(readFileSync(join(dir, ".env.wallet"), "utf8")).toBe(before);
  });
});

describe("installForHost core (shipped install-for-host-core.mjs)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeCloneSim();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("research mode: host sample points at dist, wallets off, no master key", () => {
    const result = installForHost({
      cloneRoot: dir,
      host: "grok",
      mode: "research",
    });
    expect(result.ok).toBe(true);
    expect(result.configText).toBeTruthy();
    const cfg = result.configText!;
    expect(cfg).toMatch(/dist\/index\.js/);
    expect(cfg).toMatch(/AGENT_WALLET_ENABLED\s*=\s*"false"/);
    expect(cfg).not.toMatch(/AGENT_WALLET_MASTER_KEY/);
    expect(looksLikeMasterKeyHex(cfg)).toBe(false);
    expect(looksLikeMasterKeyHex(result.messages.join("\n"))).toBe(false);
    expect(existsSync(result.outPath!)).toBe(true);
    const written = readFileSync(result.outPath!, "utf8");
    expect(written).not.toMatch(/AGENT_WALLET_MASTER_KEY/);
  });

  it("wallets mode: creates .env.wallet without key in messages; host points at launcher", () => {
    const result = installForHost({
      cloneRoot: dir,
      host: "grok",
      mode: "wallets",
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, ".env.wallet"))).toBe(true);
    const envBody = readFileSync(join(dir, ".env.wallet"), "utf8");
    const keyMatch = envBody.match(/^AGENT_WALLET_MASTER_KEY=([0-9a-fA-F]{64})\s*$/m);
    expect(keyMatch).toBeTruthy();
    const key = keyMatch![1]!;

    expect(result.configText).toMatch(/start-wallet-mcp\.mjs/);
    expect(result.configText).not.toMatch(/AGENT_WALLET_MASTER_KEY/);
    expect(result.messages.join("\n")).not.toContain(key);
    expect(looksLikeMasterKeyHex(result.messages.join("\n"))).toBe(false);
  });

  it("wallets mode re-run leaves existing .env.wallet untouched (no key print)", () => {
    const first = installForHost({
      cloneRoot: dir,
      host: "cursor",
      mode: "wallets",
    });
    expect(first.ok).toBe(true);
    const before = readFileSync(join(dir, ".env.wallet"), "utf8");

    const second = installForHost({
      cloneRoot: dir,
      host: "cursor",
      mode: "wallets",
    });
    expect(second.ok).toBe(true);
    expect(second.messages.join(" ")).toMatch(/already present|untouched|leaving/i);
    expect(readFileSync(join(dir, ".env.wallet"), "utf8")).toBe(before);
    expect(looksLikeMasterKeyHex(second.messages.join("\n"))).toBe(false);
    // JSON host sample has no master key
    expect(second.configText).not.toMatch(/AGENT_WALLET_MASTER_KEY/);
    expect(second.configText).toMatch(/start-wallet-mcp\.mjs/);
  });

  it("buildHostConfigText never assigns master key for any host/mode", () => {
    for (const host of ["grok", "cursor", "claude", "codex"] as const) {
      for (const mode of ["research", "wallets"] as const) {
        const paths = resolveInstallPaths(dir, mode);
        const text = buildHostConfigText({ host, mode, paths });
        expect(text, `${host}/${mode}`).not.toMatch(/AGENT_WALLET_MASTER_KEY/);
        expect(looksLikeMasterKeyHex(text)).toBe(false);
      }
    }
  });
});

describe("CLI entry scripts (spawn shipped .mjs)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeCloneSim();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generate-wallet-env.mjs stdout has no 64-hex key; file has key", () => {
    const script = join(repoRoot, "scripts", "generate-wallet-env.mjs");
    const r = spawnSync(process.execPath, [script, "--clone-root", dir], {
      encoding: "utf8",
      cwd: dir,
      timeout: 15_000,
      windowsHide: true,
    });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(looksLikeMasterKeyHex(r.stdout + r.stderr)).toBe(false);
    const body = readFileSync(join(dir, ".env.wallet"), "utf8");
    expect(body).toMatch(/^AGENT_WALLET_MASTER_KEY=[0-9a-fA-F]{64}\s*$/m);
  });

  it("install-for-host.mjs --mode research produces config without master key", () => {
    const script = join(repoRoot, "scripts", "install-for-host.mjs");
    const r = spawnSync(
      process.execPath,
      [script, "--host", "grok", "--mode", "research", "--clone-root", dir],
      {
        encoding: "utf8",
        cwd: dir,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(looksLikeMasterKeyHex(r.stdout + r.stderr)).toBe(false);
    expect(r.stdout).not.toMatch(/AGENT_WALLET_MASTER_KEY\s*=\s*"[0-9a-fA-F]{64}"/);
    // Generated file under data/install-host-configs
    const out = join(dir, "data", "install-host-configs", "grok-research.toml");
    expect(existsSync(out)).toBe(true);
    const cfg = readFileSync(out, "utf8");
    expect(cfg).toMatch(/dist\/index\.js/);
    expect(cfg).toMatch(/AGENT_WALLET_ENABLED\s*=\s*"false"/);
    expect(cfg).not.toMatch(/AGENT_WALLET_MASTER_KEY/);
  });

  it("install-for-host.mjs --mode wallets then refuse path is key-safe", () => {
    const script = join(repoRoot, "scripts", "install-for-host.mjs");
    const first = spawnSync(
      process.execPath,
      [script, "--host", "grok", "--mode", "wallets", "--clone-root", dir],
      {
        encoding: "utf8",
        cwd: dir,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    expect(first.status, first.stderr + first.stdout).toBe(0);
    expect(looksLikeMasterKeyHex(first.stdout + first.stderr)).toBe(false);
    const envBody = readFileSync(join(dir, ".env.wallet"), "utf8");
    const key = envBody.match(/^AGENT_WALLET_MASTER_KEY=([0-9a-fA-F]{64})/m)?.[1];
    expect(key).toBeTruthy();
    expect(first.stdout).not.toContain(key!);

    const second = spawnSync(
      process.execPath,
      [script, "--host", "grok", "--mode", "wallets", "--clone-root", dir],
      {
        encoding: "utf8",
        cwd: dir,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(second.stdout).not.toContain(key!);
    expect(looksLikeMasterKeyHex(second.stdout + second.stderr)).toBe(false);
    expect(readFileSync(join(dir, ".env.wallet"), "utf8")).toBe(envBody);

    const out = join(dir, "data", "install-host-configs", "grok-wallets.toml");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toMatch(/start-wallet-mcp\.mjs/);
    expect(readFileSync(out, "utf8")).not.toMatch(/AGENT_WALLET_MASTER_KEY/);
  });
});
