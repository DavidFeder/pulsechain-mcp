# Agent bootstrap — pulsechain-mcp

**Start here.** Follow this list top to bottom. Do not invent a second install path.

---

## 1. Clone and build

Node.js **20+** required.

```bash
git clone https://github.com/DavidFeder/pulsechain-mcp.git
cd pulsechain-mcp
npm install
npm run build
```

Confirm `dist/index.js` exists. That file is the host entry for every sample.

---

## 2. Choose the client example

| Host | Sample | Config location |
|------|--------|-----------------|
| Cursor | [`examples/cursor_mcp_config.json`](../examples/cursor_mcp_config.json) | `.cursor/mcp.json` or Cursor MCP settings |
| Claude Desktop | [`examples/claude_desktop_config.json`](../examples/claude_desktop_config.json) | Claude desktop MCP config |
| Grok Build | [`examples/grok_mcp_config.toml`](../examples/grok_mcp_config.toml) | `~/.grok/config.toml` or project `.grok/config.toml` |
| OpenAI Codex | [`examples/codex_mcp_config.toml`](../examples/codex_mcp_config.toml) | `~/.codex/config.toml` or project `.codex/config.toml` |

Copy the matching sample into the host config. Details: [examples/README.md](../examples/README.md).

---

## 3. Write absolute paths

Replace every `REPLACE_WITH_ABSOLUTE_PATH` with the **clone root only** (the folder that contains `package.json` and `dist/`).

| OS | Style |
|----|--------|
| Windows | Prefer `C:/Users/YOU/Documents/PulseChainMCP` |
| macOS / Linux | `/Users/YOU/...` or `/home/YOU/...` |

Resulting args must look like: `<clone-root>/dist/index.js`  
Wallet dir: `<clone-root>/data/wallets`

**Do not set `HTTP_TRANSPORT_PORT`** — stdio hosts need stdout for the protocol.

---

## 4. Wallets on (default) or research-only

| Mode | What to set |
|------|-------------|
| **Wallets on (default)** | `AGENT_WALLET_ENABLED=true` + real `AGENT_WALLET_MASTER_KEY` |
| **Research-only** | `AGENT_WALLET_ENABLED=false` and **omit** the master key |

Generate a master key **on the operator machine only** (never commit, never paste into chat logs):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Replace `REPLACE_WITH_64_CHAR_HEX_MASTER_KEY` with that value — or switch to research-only.

Lose the master key → encrypted wallets cannot be recovered.

---

## 5. Restart / reload the host

After editing config or running `npm run build`, **restart or reload MCP** so the host launches the fresh `dist/index.js`.

| Host | Typical action |
|------|----------------|
| Cursor | Reload MCP / restart window |
| Claude Desktop | Restart app |
| Grok | Restart or `grok mcp doctor pulsechain-mcp` |
| Codex | Restart extension / app; `codex mcp list` |

---

## 6. Smoke checks

Call, in order:

1. **`pulsechain_health`** — `version` matches package (currently **1.0.0**); `agentWalletEnabled` matches the mode you chose  
2. **`agent_wallet_status`** — flags only; **no** private key, master key, or ciphertext  
3. Optional: `get_rpc_health`, `get_token_balance`, or `dexscreener_search`

If the server never appears: rebuild, fix absolute paths, Node 20+ on PATH, master key present or wallets explicitly off, and check host stderr for `CONFIG_ERROR`.

---

## 7. Where next (after smoke passes)

| Need | Doc |
|------|-----|
| Day-to-day agent rules, research & swap flows | [AGENT_GUIDANCE.md](AGENT_GUIDANCE.md) |
| Address-first identity, e*/p*, HEX/DAI traps | [TOKEN_IDENTITY.md](TOKEN_IDENTITY.md) |
| Piteas / Switch quote → prepare | [AGGREGATORS.md](AGGREGATORS.md) |
| Security essentials (short) | [SECURITY.md](SECURITY.md) |
| Security residual detail (optional) | [SECURITY_DEEP.md](SECURITY_DEEP.md) |
| Multi-RPC, env table, Docker | [OPERATOR.md](OPERATOR.md) |
| Client sample notes | [examples/README.md](../examples/README.md) |

**Not onboarding:** [CHANGELOG.md](../CHANGELOG.md), [MIGRATION_NOTES.md](../MIGRATION_NOTES.md).
