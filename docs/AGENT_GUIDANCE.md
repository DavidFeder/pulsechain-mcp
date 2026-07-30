# Agent guidance — pulsechain-mcp

**Operating manual** (workflows, rules, trust). **First-time setup is not here.**

→ **Setup checklist:** [BOOTSTRAP.md](BOOTSTRAP.md) (clone/build → client → paths → wallets → reload → smoke).

Humans only paste an example config and ask you to finish; you follow BOOTSTRAP, then use this doc for day-to-day work.

Also available as MCP resource: **`pulsechain://guidance/ro-research`**.

---

## Install / build

Covered step-by-step in [BOOTSTRAP.md](BOOTSTRAP.md). Summary:

```bash
# Node.js 20+ required
git clone https://github.com/DavidFeder/pulsechain-mcp.git
cd pulsechain-mcp
npm install
npm run build   # produces dist/index.js — required before any client connect
```

- Entry for hosts: **`dist/index.js`** (absolute path).
- Prefer dedicated wallet launcher when signing under multiproc strict: `scripts/start-wallet-mcp.mjs` + gitignored `.env.wallet` (see [SECURITY.md](SECURITY.md); residual detail in [SECURITY_DEEP.md](SECURITY_DEEP.md)).
- Docker is optional packaging only — [OPERATOR.md](OPERATOR.md). Not required for IDE/CLI stdio.

---

## Client wiring

All supported hosts use **stdio** + `node` + absolute `dist/index.js`. **Do not set `HTTP_TRANSPORT_PORT`** (that switches the process to HTTP-only and breaks stdio clients).

| Host | Sample | Where to put it |
|------|--------|-----------------|
| **Cursor** | [`examples/cursor_mcp_config.json`](../examples/cursor_mcp_config.json) | Project `.cursor/mcp.json` or Cursor MCP settings |
| **Claude Desktop** | [`examples/claude_desktop_config.json`](../examples/claude_desktop_config.json) | Claude `claude_desktop_config.json` |
| **Grok Build** | [`examples/grok_mcp_config.toml`](../examples/grok_mcp_config.toml) | `~/.grok/config.toml` or project `.grok/config.toml` |
| **OpenAI Codex** | [`examples/codex_mcp_config.toml`](../examples/codex_mcp_config.toml) | `~/.codex/config.toml` or project `.codex/config.toml` (trusted) |

### Placeholders (every sample)

| Placeholder | Meaning |
|-------------|---------|
| `REPLACE_WITH_ABSOLUTE_PATH` | Clone root only (contains `package.json` + `dist/`) |
| `REPLACE_WITH_64_CHAR_HEX_MASTER_KEY` | Offline master key — never commit or paste into chat |

**Windows paths:** prefer forward slashes (`C:/Users/.../PulseChainMCP`).

### Codex-specific notes

- Config table is **`[mcp_servers.<name>]`** (not `mcp.servers`).
- Shared by Codex CLI, IDE extension, and ChatGPT desktop Codex host.
- Optional CLI: `codex mcp add pulsechain-mcp --env KEY=VALUE -- node <ABS>/dist/index.js` — prefer the full TOML sample when many env vars are needed.
- `startup_timeout_sec` / `tool_timeout_sec` are often needed (cold start + slow RPC/aggregator tools). Sample sets 45 / 120.
- Codex can also speak Streamable HTTP to remote MCP servers; **this product’s primary path remains local stdio** — do not enable `HTTP_TRANSPORT_PORT` on the Node process for local IDE/CLI hosts.
- After rebuild: restart Codex/extension; `codex mcp list` / in-TUI `/mcp`.

### Smoke check (any host)

1. `pulsechain_health` — expect current version and `agentWalletEnabled` matching mode  
2. `agent_wallet_status` — config flags only (never a secret)  
3. Optional: `get_rpc_health`, `get_token_balance`, `dexscreener_search`  

Full placeholder notes: [examples/README.md](../examples/README.md).

---

## Wallets on default + master key

Product default (**v0.3.0+**): **`AGENT_WALLET_ENABLED=true`**. Master key is **required** to start when wallets are on.

**Generate master key (operator machine only — never log or commit):**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Mode | Env | Behavior |
|------|-----|----------|
| **Wallets on (default)** | `AGENT_WALLET_ENABLED=true` + `AGENT_WALLET_MASTER_KEY` | Create/fund wallet → signing tools |
| **Research-only** | `AGENT_WALLET_ENABLED=false`, omit master key | Analytics + quotes; writes refuse |

- Private keys stay AES-256-GCM encrypted; tools never return them.
- **Funding the agent is authorization** (operator-trust). No product spend-cap defaults; `MAX_PLS_*` / allowlists are **display / advisory** only if set, not hard custody locks.
- Confirm / MRTR is **host UX only**.
- Unique `AGENT_WALLET_DIR` per process; multiproc strict recommended.
- Details: [SECURITY.md](SECURITY.md). Gas funding ranges and launcher tables: [SECURITY_DEEP.md](SECURITY_DEEP.md).

---

## Hard rules

1. **Address beats ticker** — always verify the `0x` before pricing, balancing, or swapping on a symbol.
2. **e\*** = bridged from Ethereum (legitimate). **p\*** = state-fork (typically useless) **except pHEX** (preferred PulseChain HEX).
3. **Never invent** `token_origin` or DexScreener pair rows for unknown addresses.
4. **Wallets off** means write/signing tools refuse — do not invent broadcast paths.
5. **No auto-broadcast** — quotes and prepare tools never send transactions.
6. **Keys never in chat** — private keys, master keys, mnemonics, ciphertext must not appear in tool args or operator paste.

See [TOKEN_IDENTITY.md](TOKEN_IDENTITY.md) for the full e*/p* catalog.

---

## Research workflow (read-only)

```text
pulsechain_health
  → get_rpc_health (optional probe=true sparingly)
  → identity by address: get_token_info / get_token_balance / get_portfolio
  → discovery only: dexscreener_search (honor catalog_coverage follow-ups)
  → identity market: dexscreener_token_pairs | dexscreener_pair | dexscreener_tokens
  → price: get_token_price by address (or DexScreener by address)
  → optional flow: get_recent_swaps (labels on catalogued sides)
```

**Prefer**

| Goal | Tools |
|------|--------|
| Identity | `get_token_info`, balances/portfolio, DexScreener by **address** |
| Discovery | `dexscreener_search` only — not settlement identity |
| Ranking | `get_top_tokens` / `get_top_pairs` (origin labels when catalogued) |
| HEX stake state | `hex_global_state` / `hex_stakes_for_address` on **pHEX** (eHEX soft-fails) |

---

## Swap workflow (no auto-send)

```text
quote (piteas_quote preferred keyless)
  → prepare (piteas_prepare_swap | switch_prepare_swap)
  → propose_agent_tx   (wallets enabled)
  → review reviewSummary + safetyHints + agentGuidance
  → execute_agent_tx with confirm=true (or MRTR)
```

| Step | Rule |
|------|------|
| Quote | Prefer **`piteas_quote`** (keyless). **`switch_quote`** needs operator `SWITCH_API_KEY`. Neither is a best-price oracle. |
| Prepare | Builds reviewable `to` / `data` / `value` — **does not broadcast**. |
| Propose | Read **`reviewSummary`** (destination, native value, token movements, gas hints). |
| Execute | Only after human/operator confirm path; re-check deny/`refuse` guidance. |

Details: [AGGREGATORS.md](AGGREGATORS.md). Wallets: [SECURITY.md](SECURITY.md).

---

## Stale-quote rule

- Aggregator quotes **expire quickly** (Switch ~10s cache; Piteas also documents re-quote before send).
- If time passes, the market moves, prepare fails, or `quoteReady` is false → **re-quote**, then prepare again.
- Never reuse old calldata for a later execute.
- `quoteReady` / prepare success ≠ permission to broadcast without review.

---

## Kill switch

When wallets are enabled and something looks wrong (wrong destination, runaway agent, compromise suspicion):

1. Call **`kill_switch`** (or `revoke`) with **`confirm=true`** (or MRTR).
2. Expect wallet `enabled=false`, `killed=true` — further signing refused until operator recovers carefully.
3. Do **not** treat display `MAX_PLS_*` as a substitute for kill switch.

---

## Operator-trust (when wallets on)

- **Funding the agent is authorization.**
- No product spend-cap defaults. `MAX_PLS_*`, allowlists, and token-notional are **advisory / display** only if present, not hard spend locks.
- Confirm/MRTR is **host UX only**.
- Prefer order once funded: **native transfer → approve/token → swap-class**.
- Separate **value**, **gas cost (PLS)**, and **total PLS available**.

Security essentials: [SECURITY.md](SECURITY.md). Residual detail: [SECURITY_DEEP.md](SECURITY_DEEP.md).

---

## Trust / noise caveats

| Signal | Treat as |
|--------|----------|
| On-chain reads by **address**, catalog origin labels, `pulsechain_health` | High confidence when tools succeed |
| Aggregator quotes, gas estimates, USD notionals | Advisory — re-check before send; re-quote if stale |
| DexScreener **search by ticker**, scam scores, ranking heuristics | Noisy / discovery-only — never settle identity on ticker alone |
| Display `MAX_PLS_*` | Not a hard spend lock under operator-trust |

**Best tools for careful work:** address-first `get_token_info` / balances / DexScreener-by-address; `piteas_quote` + prepare for swaps; `hex_global_state` only on **pHEX** for stake global state.

---

## Identity rules (summary)

- Always settle on **contract address**, not symbol.
- **pHEX** is the preferred PulseChain HEX; **eHEX** is bridged — do not mix stakes/global state tools casually.
- **pDAI** (state-fork) ≠ bridged DAI; see [TOKEN_IDENTITY.md](TOKEN_IDENTITY.md) and bridge.pulsechain.com for official bridge context.

---

## Related

| Doc | Topic |
|-----|--------|
| [BOOTSTRAP.md](BOOTSTRAP.md) | **First-time setup checklist** |
| [README.md](README.md) (docs map) | Doc index after bootstrap |
| [SECURITY.md](SECURITY.md) | Essentials (first-run) |
| [SECURITY_DEEP.md](SECURITY_DEEP.md) | Optional residual detail |
| [TOKEN_IDENTITY.md](TOKEN_IDENTITY.md) | Full e*/p* + traps |
| [AGGREGATORS.md](AGGREGATORS.md) | Piteas / Switch |
| [OPERATOR.md](OPERATOR.md) | Env, multi-RPC, Docker |
| [../examples/README.md](../examples/README.md) | Client samples |
