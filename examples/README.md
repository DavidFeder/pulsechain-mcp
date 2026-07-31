# Client MCP config examples

Copy-paste templates for hosting **pulsechain-mcp** over **stdio**.  
Server version **1.0.1** — **wallets on by default** (master key required).

## Agents: setup path

**Follow [docs/BOOTSTRAP.md](../docs/BOOTSTRAP.md)** end-to-end (build → pick a sample below → paths → master key or research-only → reload → smoke).

Do not invent a second install story. After smoke passes: [docs/AGENT_GUIDANCE.md](../docs/AGENT_GUIDANCE.md), [docs/SECURITY.md](../docs/SECURITY.md).

| Mode | How |
|------|-----|
| **Wallets on (default)** | Samples below: `AGENT_WALLET_ENABLED=true` + replace master-key placeholder |
| **Research-only** | Set `AGENT_WALLET_ENABLED=false` and omit `AGENT_WALLET_MASTER_KEY` |
| **Dedicated wallet process** | [`scripts/start-wallet-mcp.mjs`](../scripts/start-wallet-mcp.mjs) + [`.env.wallet.example`](../.env.wallet.example) |

Docker (optional): [docs/OPERATOR.md — Docker](../docs/OPERATOR.md#docker--one-command-setup).

| File | Host |
|------|------|
| [`cursor_mcp_config.json`](cursor_mcp_config.json) | Cursor (project `.cursor/mcp.json` or Cursor MCP settings) |
| [`grok_mcp_config.toml`](grok_mcp_config.toml) | Grok Build / Grok CLI (`~/.grok/config.toml` or project `.grok/config.toml`) |
| [`claude_desktop_config.json`](claude_desktop_config.json) | Claude Desktop (`claude_desktop_config.json`) |
| [`codex_mcp_config.toml`](codex_mcp_config.toml) | OpenAI Codex CLI / IDE / ChatGPT desktop (`~/.codex/config.toml` or project `.codex/config.toml`) |

## Before wiring any client

```bash
npm install
npm run build   # requires dist/index.js
```

Node **20+** must be on `PATH` (or set `command` to an absolute `node` path).

Generate a master key (wallets-on path):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Replace placeholders

`REPLACE_WITH_ABSOLUTE_PATH` means your **clone root only** (the directory that contains `package.json` and `dist/` after build). Do **not** append the repo folder name again.

`REPLACE_WITH_64_CHAR_HEX_MASTER_KEY` is your offline-generated master key — never commit the real value.

Every sample uses:

- `REPLACE_WITH_ABSOLUTE_PATH/dist/index.js` — absolute path to the built entry  
- `REPLACE_WITH_ABSOLUTE_PATH/data/wallets` — wallet data dir  

**Example:** if the clone is `C:/Users/YOU/Documents/PulseChainMCP`, replace the path placeholder with that string so args become `C:/Users/YOU/Documents/PulseChainMCP/dist/index.js`.

### Path notes by OS

| OS | Example absolute path style |
|----|-----------------------------|
| **Windows** | Prefer forward slashes: `C:/Users/YOU/Documents/PulseChainMCP/dist/index.js` |
| **macOS** | `/Users/YOU/Documents/PulseChainMCP/dist/index.js` |
| **Linux** | `/home/YOU/PulseChainMCP/dist/index.js` |

## Security defaults (samples)

| Setting | Value | Why |
|---------|--------|-----|
| `AGENT_WALLET_ENABLED` | `"true"` | Product default — signing available after create/fund |
| `AGENT_WALLET_MASTER_KEY` | `REPLACE_…` placeholder | Required when wallets on; never commit a real key |
| `HTTP_TRANSPORT_PORT` | **omitted** | Must stay unset for stdio clients |
| `MAX_PLS_*` | **omitted** | Not product spend-cap safety; operator-trust = fund only what you accept |

Research-only: set `AGENT_WALLET_ENABLED` to `"false"` and remove the master-key line.

## Do not use for Cursor / Grok / Claude / Codex stdio

- Setting `HTTP_TRANSPORT_PORT` — process becomes **HTTP-only** and skips stdio  
- Pointing at `src/index.ts` without a runner — use built `dist/index.js`  
- Sharing one `AGENT_WALLET_DIR` across multiple MCP host processes  

## OpenAI Codex notes

- Config key is **`[mcp_servers.pulsechain-mcp]`** (same shape as Grok TOML samples).
- Default path: `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`); project `.codex/config.toml` only for trusted projects.
- Optional CLI: `codex mcp add … -- node <path>/dist/index.js` — the full TOML sample is easier when many env vars are required.
- Raise `startup_timeout_sec` / `tool_timeout_sec` if cold start or RPC tools time out (sample uses 45 / 120).
- UI: ChatGPT desktop / Codex IDE → Settings → MCP servers → Add server (STDIO).

## Smoke check after connect

(Same as [BOOTSTRAP.md §6](../docs/BOOTSTRAP.md#6-smoke-checks).)

1. `pulsechain_health` — expect `version: "1.0.1"` (and `agentWalletEnabled: true` when wallets on)  
2. `agent_wallet_status` — master key configured flag only (never a secret)  
3. `get_rpc_health` (optional `probe: true`)  
4. Optional: `get_token_balance` or `dexscreener_search`  

If the server never appears: confirm `npm run build`, absolute paths, Node 20+, master key or wallets off, and that host logs show no fatal JSON on stderr (`CONFIG_ERROR`, missing `dist/index.js`, etc.).

After rebuilding, **restart / reload** the MCP host so it launches the fresh `dist/index.js`.
