# Migration notes — MCP 2026-07-28 dual-era stack

> **Current package version on `main`:** see `package.json` (**1.0.1**). Dual-era MCP remains the protocol default. The TypeScript MCP SDK is pinned to stable **`2.0.0`** (released for the final **2026-07-28** spec). No product-facing `MAX_PLS_*` spend-cap knobs in examples/templates.

This document describes what changed between **v0.1.0** (pre-2026-07-28, MCP TypeScript SDK v1) and the dual-era MCP stack on TypeScript SDK **v2** (introduced as `0.2.0-rc.1` on beta pins; **stable as of 1.0.0**).

| Field | Value |
|-------|--------|
| **From** | `0.1.0` — `@modelcontextprotocol/sdk` v1, stdio + optional SSE |
| **To (protocol cut)** | `0.2.0-rc.1` — `@modelcontextprotocol/server` / `node` v2 dual-era |
| **Current SDK pin (1.0.0)** | `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/node@2.0.0` (**stable**, exact) |
| **Protocol mode** | `dual:2026-07-28+2025-11-25` |
| **Dual support** | Yes (default) |
| **Rollback tag** | [`v0.1.0`](https://github.com/DavidFeder/pulsechain-mcp/releases/tag/v0.1.0) |

---

## What changed vs v0.1.0 / pre-2026-07-28

### Dependencies

| Before (0.1.0) | After (dual-era v2) | Current (1.0.0) |
|----------------|---------------------|-----------------|
| `@modelcontextprotocol/sdk` (monolithic v1) | `@modelcontextprotocol/server` v2 | **`2.0.0` stable** (exact pin) |
| — | `@modelcontextprotocol/node` v2 | **`2.0.0` stable** (exact pin) |
| Zod 3-era (via sdk) | `zod@^4.2.0` (Standard Schema / tool list) | same |

SDK packages are **pinned exactly** (`2.0.0`). Bump server, node, and codemod packages together; prefer exact pins over floating caret ranges.

### Transports

| Path | Before | After |
|------|--------|--------|
| **stdio (primary)** | Manual `StdioServerTransport` + `server.connect(...)` | `serveStdio(() => createServer(config), { legacy: "serve" })` |
| **HTTP (optional)** | SSE: `/sse` + `/messages` | Streamable HTTP: `/mcp` via `createMcpHandler` + `toNodeHandler` |
| **Health** | (if present) | `GET /health` JSON (includes `protocolMode`) |

stdio remains the production path for Claude Desktop and Cursor. Setting `HTTP_TRANSPORT_PORT` starts **HTTP-only** mode (stdio is not also bound in that process).

### Stateless core

- Application code does **not** maintain sticky `Mcp-Session-Id` sessions for protocol identity.
- `createServer(config)` builds a **fresh** `McpServer` per stdio connection pin and per HTTP request (factory pattern required by dual-era handlers).
- Wallet state remains **file-backed** under `AGENT_WALLET_DIR` (unchanged model; not MCP-session-keyed).

### Per-request `_meta`

Modern (2026-07-28) requests carry client identity on the request envelope. App helper: `readClientRequestMeta` in `src/utils/requestMeta.ts` (protocol version, clientInfo, clientCapabilities from SDK meta keys).

Server identity for modern responses is stamped by the SDK into result `_meta` (`io.modelcontextprotocol/serverInfo`) from `{ name, version }` — not an app-owned initialize body.

### `server/discover`

Answered automatically by the SDK when serving via `serveStdio` / `createMcpHandler`. Capabilities reflect registered tools and resources. No custom discover handler in this repo.

### Wallet confirms (MRTR + legacy)

Write wallet tools still require confirmation. Dual path:

1. **All clients / scripts:** pass `confirm=true` (same as 0.1.0).
2. **Modern MRTR-capable clients:** omit `confirm` (or leave false); server may return `InputRequiredResult` (`resultType: "inputRequired"`, `inputRequests.confirm`, HMAC-signed `requestState`). Client retries with `inputResponses` + echoed `requestState`.

Implementation: `src/utils/confirm.ts` (`resolveConfirm` / `requireConfirmOrInput`). `requestState` never contains private keys, master keys, or ciphertext. Service layer still re-checks policy and simulation before sign/broadcast.

Optional env: `AGENT_WALLET_MRTR_SECRET` (≥32-byte UTF-8 HMAC secret for `requestState`). If unset, a process-local random secret is used (fine for single-process stdio).

### Tool surface

**69 tools** — same names and categories as 0.1.0. Registration moved to SDK v2 `registerTool` + Zod object schemas; behavior of analytics / chain / wallet tools is intentionally unchanged aside from confirm dual-path.

---

## How clients should connect

### Claude Desktop / Cursor (recommended)

Use **stdio** — no HTTP port, no SSE URL.

1. `npm install && npm run build`
2. Configure MCP server:

```json
{
  "mcpServers": {
    "pulsechain-mcp": {
      "command": "node",
      "args": ["C:/absolute/path/to/PulseChainMCP/dist/index.js"],
      "env": {
        "PULSECHAIN_RPC_URL": "https://rpc.pulsechain.com",
        "AGENT_WALLET_ENABLED": "false",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

3. Restart the host. Dual-era negotiation is automatic:
   - Current Desktop/Cursor → **2025-11-25** via `initialize`
   - Future modern hosts → **2026-07-28** via `server/discover` + `_meta`

See [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json), [docs/AGENT_GUIDANCE.md — Client wiring](docs/AGENT_GUIDANCE.md#client-wiring), and [examples/README.md](examples/README.md).

### Local Streamable HTTP (testing)

```bash
# Windows PowerShell example
$env:HTTP_TRANSPORT_PORT = "8787"
node dist/index.js
# → http://127.0.0.1:8787/mcp  and  GET /health
```

Do **not** set `HTTP_TRANSPORT_PORT` inside Claude/Cursor env when you want stdio.

### Wallet write confirmation

| Client | How to confirm |
|--------|----------------|
| Scripts, 2025-era hosts, CI | Always pass `confirm: true` in tool args |
| 2026-07-28 hosts with MRTR | May complete elicitation when `confirm` is omitted |

`AGENT_WALLET_ENABLED` must still be `true` and `AGENT_WALLET_MASTER_KEY` set for write tools.

---

## Breaking changes

| Change | Impact |
|--------|--------|
| **SSE removed** | Clients using `/sse` or `/messages` must switch to stdio or Streamable HTTP `/mcp` |
| **Package rename** | No longer depends on `@modelcontextprotocol/sdk`; consumers of this package as a library should import built `dist/` only (same as before) |
| **HTTP exclusive with stdio** | When `HTTP_TRANSPORT_PORT` is set, the process does not also serve stdio |
| **Zod 4** | If you extend this codebase, tool schemas use Zod 4 / Standard Schema |

Non-breaking for typical Desktop/Cursor users who already pointed at `node dist/index.js` over stdio: rebuild and restart.

---

## Rollback

To return to the pre-migration server:

```bash
git fetch --tags
git checkout v0.1.0
npm install
npm run build
# point Claude/Cursor args at this tree’s dist/index.js again
```

Tag: **`v0.1.0`**. Wallet files under `AGENT_WALLET_DIR` remain compatible (encryption format unchanged); protocol-only migration.

---

## See also

- [README.md](README.md) — install, client config, security summary
- [docs/SECURITY.md](docs/SECURITY.md) — wallet security model
- [docs/AGENT_GUIDANCE.md](docs/AGENT_GUIDANCE.md) — day-to-day agent workflows
- [examples/README.md](examples/README.md) — client samples
- [CHANGELOG.md](CHANGELOG.md) — public release history
- [RELEASE_NOTES.md](RELEASE_NOTES.md) — v1.0.0 notes + operator publish checklist
