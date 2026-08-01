# Agent bootstrap — pulsechain-mcp

**Start here.** Follow this list top to bottom. Do not invent a second install path.

---

## Do NOT (agent anti-patterns)

| Never | Why |
|-------|-----|
| `console.log` / print the master key | Lands in terminal, chat, and tool transcripts |
| Paste the master key into chat | Same leak surface |
| `read_file` / `cat` host config or `.env.wallet` to “verify” the key | Pulls secrets into agent context |
| Write a custom MCP stdio client for smoke | Hosts already expose doctor + tools after reload |
| Fund the agent wallet during bootstrap | Bootstrap is install + smoke only; funding is a later operator step |
| Embed `AGENT_WALLET_MASTER_KEY` in host config samples | Prefer gitignored `.env.wallet` + launcher |

**Verify secrets without reading them:** file existence, optional Unix mode bits, then post-reload `agent_wallet_status` / `masterKeyConfigured`-style flags only.

---

## 1. Clone and build

Node.js **20+** required.

**Recommended clone locations** (operator choice):

- `~/repos/pulsechain-mcp`
- `~/mcp/pulsechain-mcp`
- Or any dedicated folder you control

**Avoid** cloning inside an unrelated app repo unless the user wants a project-scoped MCP only for that app.

```bash
git clone https://github.com/DavidFeder/pulsechain-mcp.git
cd pulsechain-mcp
npm install          # may already run build via prepare
npm run build        # fine to re-run after pull
```

Confirm `dist/index.js` exists. That file is the research-only host entry.

**Path fill:** in examples, `REPLACE_WITH_ABSOLUTE_PATH` means the **clone root only** (folder with `package.json` and `dist/`). Prefer forward slashes on Windows (`C:/Users/YOU/repos/pulsechain-mcp`).

---

## 2. Pick mode first (agent default = research-only)

| Intent | When | Entry | Secrets |
|--------|------|-------|---------|
| **Research-only (agent default)** | User said “set it up / install” with no signing ask | `dist/index.js`, `AGENT_WALLET_ENABLED=false` | nowhere |
| **Wallets-on** | User explicitly wants signing / agent wallets | `scripts/start-wallet-mcp.mjs` | gitignored `.env.wallet` only |

If the user only asked to install, choose **research-only first**. Promoting to wallets-on is an **explicit later step**.

**Product vs agent:** the product runtime may default wallets-on when `AGENT_WALLET_ENABLED` is unset (operators who want signing immediately). That is **not** the agent first-install default — agents follow this checklist (research-only unless the user asked to sign).

---

## 3. Secrets ceremony (wallets-on only)

Skip this entire section for research-only.

**Recommended (write-only):**

```bash
node scripts/generate-wallet-env.mjs
# or via installer:
node scripts/install-for-host.mjs --host grok --mode wallets
```

Behavior:

1. Creates `.env.wallet` from `.env.wallet.example` if missing  
2. **Refuses** if `.env.wallet` already exists (no overwrite)  
3. Writes the master key **into the file only**  
4. Prints success **without** printing the key  
5. Sets file mode **600** / wallet dir **700** where the OS supports it  

| Path | Mode (Unix) | Agent may |
|------|-------------|-----------|
| `.env.wallet` | 600 | existence check, **not** contents |
| `data/wallets/` | 700 | list counts / status tools, **not** key material |
| Host config (if it ever had an inline key — discouraged) | 600 | avoid reading after write |

**Windows:** POSIX `chmod` is best-effort only; NTFS ACLs are operator-managed. Do not fail install solely because mode bits are incomplete.

Lose the master key → encrypted wallets cannot be recovered.

**Discouraged alternate:** putting `AGENT_WALLET_MASTER_KEY` in host env (including `grok mcp add -e AGENT_WALLET_MASTER_KEY=…`). That still lands in config files and often in transcripts. Prefer launcher + `.env.wallet`.

**Migration (pre–launcher / pre-1.0.2 host configs):** if the host still embeds `AGENT_WALLET_MASTER_KEY`, move to write-only `.env.wallet` + `scripts/start-wallet-mcp.mjs`, then **remove** the inline key from host config (do not leave both).

---

## 4. Wire host (prefer install script)

```bash
# Research-only (default)
node scripts/install-for-host.mjs --host grok --mode research

# Wallets-on (after user asks to sign)
node scripts/install-for-host.mjs --host grok --mode wallets
```

Supported `--host`: `grok` | `cursor` | `claude` | `codex`.

The script:

- Resolves **absolute** paths from the clone root  
- Research: host sample → `dist/index.js`, wallets off, **no** secrets  
- Wallets: ensures `.env.wallet` via write-only path (or leaves existing file), host sample → `scripts/start-wallet-mcp.mjs`, **never** embeds master key  
- Writes a sample under `data/install-host-configs/` (gitignored if under `data/`; safe to re-run)  
- Prints **next steps only** (merge sample, reload, doctor, smoke tool names)  
- Never prints secrets; never requires opening secret files  

**Idempotent:** re-run is safe. Existing `.env.wallet` is not overwritten. Host sample files may be regenerated (no secrets in them).

### Manual samples (if you skip the script)

| Host | Sample | Config location |
|------|--------|-----------------|
| Cursor | [`examples/cursor_mcp_config.json`](../examples/cursor_mcp_config.json) | `.cursor/mcp.json` or Cursor MCP settings |
| Claude Desktop | [`examples/claude_desktop_config.json`](../examples/claude_desktop_config.json) | Claude desktop MCP config |
| Grok Build | [`examples/grok_mcp_config.toml`](../examples/grok_mcp_config.toml) | `~/.grok/config.toml` or project `.grok/config.toml` |
| OpenAI Codex | [`examples/codex_mcp_config.toml`](../examples/codex_mcp_config.toml) | `~/.codex/config.toml` or project `.codex/config.toml` |

Shipped examples are **research-only** (agent default). Wallets-on host config points at the launcher; details in [examples/README.md](../examples/README.md).

**Do not set `HTTP_TRANSPORT_PORT`** — stdio hosts need stdout for the protocol.

Optional: `grok mcp add …` works for research-only env flags, but **avoid** `-e AGENT_WALLET_MASTER_KEY=…` (transcript/config leak). Prefer `install-for-host` + launcher.

---

## 5. Pre-reload doctor (this install session)

This install session **cannot** call PulseChain MCP tools until the host reloads MCP. Doctor ≠ tools injected into the current chat.

| Host | Pre-reload check |
|------|------------------|
| Grok | `grok mcp doctor pulsechain-mcp` — command found, handshake OK, tool count |
| Cursor / Claude | Restart MCP / app; check host logs for clean start |
| Codex | `codex mcp list` / restart extension; check host logs |

Do **not** invent a custom stdio MCP client to “smoke” from this session.

---

## 6. User reloads host

After editing config or running `npm run build`, **restart or reload MCP** so the host launches the fresh entry (`dist/index.js` or the wallet launcher).

| Host | Typical action |
|------|----------------|
| Cursor | Reload MCP / restart window |
| Claude Desktop | Restart app |
| Grok | Restart or re-check with doctor after reload |
| Codex | Restart extension / app |

---

## 7. Post-reload smoke (new session / turn)

Call **after** reload, in order:

1. **`pulsechain_health`** — `version` matches `package.json` / `npm pkg get version` (do **not** hardcode an old pin as the only instruction); `agentWalletEnabled` matches the mode you chose  
2. **`agent_wallet_status`** — flags only (`masterKeyConfigured`, enabled, dir); **no** private key, master key, or ciphertext  
3. Optional: `get_rpc_health`, `get_token_balance`, or `dexscreener_search`  

When wallets are on: **funding authorizes** (operator-trust); legacy `maxPls*` on list/info are **display-only** — not hard send gates; use `kill_switch` in emergencies. Do **not** fund during bootstrap smoke.

If the server never appears: rebuild, fix absolute paths, Node 20+ on PATH, research-only or launcher+`.env.wallet`, and check host stderr for `CONFIG_ERROR`.

---

## 8. Where next (after smoke passes)

| Need | Doc |
|------|-----|
| Day-to-day agent rules, research & swap flows | [AGENT_GUIDANCE.md](AGENT_GUIDANCE.md) |
| Address-first identity, e*/p*, HEX/DAI traps | [TOKEN_IDENTITY.md](TOKEN_IDENTITY.md) |
| Piteas / Switch quote → prepare | [AGGREGATORS.md](AGGREGATORS.md) |
| Security essentials (short) | [SECURITY.md](SECURITY.md) |
| Security residual detail (optional) | [SECURITY_DEEP.md](SECURITY_DEEP.md) |
| Multi-RPC, env table, Docker | [OPERATOR.md](OPERATOR.md) |
| Client sample notes | [examples/README.md](../examples/README.md) |

**Promote to wallets-on later:** re-run `install-for-host.mjs --mode wallets`, merge the new host sample, reload, smoke again — still no fund until the operator is ready.

**Not onboarding:** [CHANGELOG.md](../CHANGELOG.md), [MIGRATION_NOTES.md](../MIGRATION_NOTES.md).
