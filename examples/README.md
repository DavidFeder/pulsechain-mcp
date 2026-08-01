# Client MCP config examples

Copy-paste templates for hosting **pulsechain-mcp** over **stdio**.  
Server version matches **`package.json`** (see `npm pkg get version`).

## Agents: setup path

**Follow [docs/BOOTSTRAP.md](../docs/BOOTSTRAP.md)** end-to-end.

Prefer the agent-safe installer (absolute paths, mode fork, no secrets printed):

```bash
node scripts/install-for-host.mjs --host grok --mode research
node scripts/install-for-host.mjs --host grok --mode wallets
```

Do not invent a second install story. After smoke passes: [docs/AGENT_GUIDANCE.md](../docs/AGENT_GUIDANCE.md), [docs/SECURITY.md](../docs/SECURITY.md).

| Mode | Entry | Secrets |
|------|-------|---------|
| **Research-only (agent default)** | `dist/index.js`, `AGENT_WALLET_ENABLED=false` | nowhere — **shipped samples below** |
| **Wallets-on (when user asks to sign)** | [`scripts/start-wallet-mcp.mjs`](../scripts/start-wallet-mcp.mjs) | gitignored [`.env.wallet`](../.env.wallet.example) only — **never** in host config |
| Write-only key ceremony | `node scripts/generate-wallet-env.mjs` | key written to file; **not** printed |

Docker (optional): [docs/OPERATOR.md — Docker](../docs/OPERATOR.md#docker--one-command-setup).

| File | Host |
|------|------|
| [`cursor_mcp_config.json`](cursor_mcp_config.json) | Cursor (project `.cursor/mcp.json` or Cursor MCP settings) |
| [`grok_mcp_config.toml`](grok_mcp_config.toml) | Grok Build / Grok CLI (`~/.grok/config.toml` or project `.grok/config.toml`) |
| [`claude_desktop_config.json`](claude_desktop_config.json) | Claude Desktop (`claude_desktop_config.json`) |
| [`codex_mcp_config.toml`](codex_mcp_config.toml) | OpenAI Codex CLI / IDE / ChatGPT desktop (`~/.codex/config.toml` or project `.codex/config.toml`) |

## Before wiring any client

```bash
npm install          # may already build via prepare
npm run build        # requires dist/index.js; fine to re-run after pull
```

Node **20+** must be on `PATH` (or set `command` to an absolute `node` path).

## Replace placeholders

`REPLACE_WITH_ABSOLUTE_PATH` means your **clone root only** (the directory that contains `package.json` and `dist/` after build). Do **not** append the repo folder name again.

Recommended clone roots: `~/repos/pulsechain-mcp` or `~/mcp/pulsechain-mcp` (operator choice). Avoid cloning inside an unrelated app repo unless the user wants project-scoped MCP.

**Example:** if the clone is `C:/Users/YOU/repos/pulsechain-mcp`, args become `C:/Users/YOU/repos/pulsechain-mcp/dist/index.js`.

### Path notes by OS

| OS | Example absolute path style |
|----|-----------------------------|
| **Windows** | Prefer forward slashes: `C:/Users/YOU/repos/pulsechain-mcp/dist/index.js` |
| **macOS** | `/Users/YOU/repos/pulsechain-mcp/dist/index.js` |
| **Linux** | `/home/YOU/mcp/pulsechain-mcp/dist/index.js` |

## Security defaults (shipped samples)

| Setting | Value | Why |
|---------|--------|-----|
| `AGENT_WALLET_ENABLED` | `"false"` | Agent install default = research-only |
| `AGENT_WALLET_MASTER_KEY` | **omitted** | Never embed in host config |
| `HTTP_TRANSPORT_PORT` | **omitted** | Must stay unset for stdio clients |
| `MAX_PLS_*` | **omitted** | Not product spend-cap safety; operator-trust = fund only what you accept |

### Wallets-on host shape (recommended)

Point `args` at the launcher; keep secrets in `.env.wallet` only:

```toml
args = ["REPLACE_WITH_ABSOLUTE_PATH/scripts/start-wallet-mcp.mjs"]
# env: AGENT_WALLET_ENABLED may be true, but NO AGENT_WALLET_MASTER_KEY here
```

Create the env file with write-only ceremony:

```bash
node scripts/generate-wallet-env.mjs
```

### Discouraged alternate

Inline `AGENT_WALLET_MASTER_KEY` in host env (or `mcp add -e AGENT_WALLET_MASTER_KEY=…`) can leak into configs and transcripts. Prefer launcher + `.env.wallet`. If you must use host env expansion, never paste the real key into chat or agent tools.

## Do not use for Cursor / Grok / Claude / Codex stdio

- Setting `HTTP_TRANSPORT_PORT` — process becomes **HTTP-only** and skips stdio  
- Pointing at `src/index.ts` without a runner — use built `dist/index.js` or the wallet launcher  
- Sharing one `AGENT_WALLET_DIR` across multiple MCP host processes  
- Printing or `read_file`-ing the master key to “verify”  

## OpenAI Codex notes

- Config key is **`[mcp_servers.pulsechain-mcp]`** (same shape as Grok TOML samples).
- Default path: `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`); project `.codex/config.toml` only for trusted projects.
- Optional CLI: `codex mcp add … -- node <path>/dist/index.js` — the full TOML sample is easier when many env vars are required. Do not pass the master key on the CLI.
- Raise `startup_timeout_sec` / `tool_timeout_sec` if cold start or RPC tools time out (sample uses 45 / 120).
- UI: ChatGPT desktop / Codex IDE → Settings → MCP servers → Add server (STDIO).

## Smoke check after connect

Split: **pre-reload** (host doctor/logs only) vs **post-reload** (tools). Full detail: [BOOTSTRAP.md](../docs/BOOTSTRAP.md).

**Pre-reload (install session):** `grok mcp doctor pulsechain-mcp` or host restart/logs — doctor ≠ tools in the current chat.

**Post-reload (new session/turn):**

1. `pulsechain_health` — `version` matches package; `agentWalletEnabled` matches mode  
2. `agent_wallet_status` — master key **configured flag** only (never a secret)  
3. `get_rpc_health` (optional `probe: true`)  
4. Optional: `get_token_balance` or `dexscreener_search`  

If the server never appears: confirm `npm run build`, absolute paths, Node 20+, research-only or launcher+`.env.wallet`, and that host logs show no fatal JSON on stderr (`CONFIG_ERROR`, missing `dist/index.js`, etc.).

After rebuilding, **restart / reload** the MCP host so it launches the fresh entry.
