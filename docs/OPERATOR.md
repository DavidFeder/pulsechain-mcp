# Advanced operator notes — multi-RPC, env, Docker

Deep detail for operators who need more than the README front door.  
Security / wallets: [SECURITY.md](SECURITY.md) (essentials) · [SECURITY_DEEP.md](SECURITY_DEEP.md) (optional residual). Agent rules: [AGENT_GUIDANCE.md](AGENT_GUIDANCE.md).

---

## Multi-RPC

Ordered failover. Put preferred URL first: local → LAN → g4mm4 → official → publicnode → PulseChainStats.

1. Requests try RPCs in list order.  
2. On timeout / connection / HTTP 429·5xx / transport failure → next URL.  
3. Failed endpoints enter a short cooldown (not retried every call).  
4. Inspect with **`get_rpc_health`** (passive default; `probe=true` sparingly).

| Field | Meaning |
|-------|---------|
| `primaryRpcUrl` | First URL in configured list — not auto-picked by latency |
| `activeRpcUrl` | Last success/probe — **not sticky**; does not reorder failover |

**Defaults (mainnet 369)** when unset: g4mm4 → `rpc.pulsechain.com` → publicnode → `rpc.pulsechainstats.com`.

```bash
# Local + public
PULSECHAIN_RPC_URLS=http://127.0.0.1:8545,https://rpc-pulsechain.g4mm4.io,https://rpc.pulsechain.com,https://pulsechain.publicnode.com,https://rpc.pulsechainstats.com

# Public only
PULSECHAIN_RPC_URLS=https://rpc-pulsechain.g4mm4.io,https://rpc.pulsechain.com,https://pulsechain.publicnode.com,https://rpc.pulsechainstats.com

# Testnet
PULSECHAIN_NETWORK=testnet
```

PulseChainStats **website** stats are not scraped — only its public JSON-RPC is used.

---

## Environment variables (summary)

Copy [`.env.example`](../.env.example) → `.env`. Dedicated wallet process: [`.env.wallet.example`](../.env.wallet.example).

| Variable | Default | Notes |
|----------|---------|--------|
| `PULSECHAIN_RPC_URLS` | multi public | Ordered list |
| `PULSECHAIN_RPC_URL` | merged | Legacy single; prepended when set |
| `PULSECHAIN_NETWORK` | `mainnet` | or `testnet` |
| `PULSECHAIN_EXPLORER_API` | scan.pulsechain.com API | BlockScout-compatible |
| `PULSEX_SUBGRAPH_V1` / `V2` | graph.pulsechain.com | PulseX |
| `HTTP_TIMEOUT_MS` | `30000` | Explorer/subgraph/per-RPC |
| `AGENT_WALLET_ENABLED` | **`true`** | Product default; set `false` for research-only |
| `AGENT_WALLET_MASTER_KEY` | empty | **Required** when wallets on (including default) |
| `AGENT_WALLET_DIR` | `./data/wallets` | One process → one unique dir |
| `AGENT_WALLET_MULTIPROC_STRICT` | wallets-on: `true` if unset/empty; research-only unset: `false` | `false`/`0` warn-only opt-out; `true`/`1` refuse writes on foreign owner. Not a distributed lock |
| `AGENT_WALLET_MRTR_SECRET` | process-local HMAC (stdio) | **Required** (≥32 bytes UTF-8) when wallets on **and** `HTTP_TRANSPORT_PORT` is set. Do not reuse `AGENT_WALLET_MASTER_KEY` |
| `AGENT_WALLET_ENFORCE_LEGACY_CAPS` | **off** (unset/`false`/`0`/empty) | Opt-in. `true`/`1` hard-denies stored `maxPls*` / allowlists / token caps / `requireDecodableCalldata` / `allowNativeTransfers` on **this process**. Product default remains display-only / operator-trust |
| `MAX_PLS_*` | **omit** | Not shipped in templates; optional legacy display only — **not** hard gates or product safety unless `AGENT_WALLET_ENFORCE_LEGACY_CAPS` is on |
| `SWITCH_API_KEY` | empty | Operator-gated Switch only |
| `HTTP_TRANSPORT_PORT` | empty | If set: HTTP-only (breaks stdio hosts) |
| `LOG_LEVEL` | `info` | stderr only |

When `PULSECHAIN_NETWORK=testnet`, explorer and PulseX subgraph still default to those mainnet hosts; `pulsechain_health` and `pulsechain://chain/config` report `networkMismatch` rather than inventing unofficial testnet subgraph URLs.

---

## Client hosts (stdio)

1. Node 20+ as `command`.  
2. Absolute path to `dist/index.js` (or wallet launcher).  
3. Master key set when wallets on (default), or `AGENT_WALLET_ENABLED=false` for research-only.  
4. **Unset** `HTTP_TRANSPORT_PORT` for Cursor/Grok/Claude/Codex.  
5. Logs on **stderr**; stdout is JSON-RPC.

| OS | Path style |
|----|------------|
| Windows | Prefer `C:/Users/…/PulseChainMCP/dist/index.js` |
| macOS / Linux | `/Users/…` or `/home/…` absolute paths |

Samples: [`examples/`](../examples/).

---

## Docker / one-command setup

Optional local packaging. **Not required** for Cursor/Grok/Claude/Codex (keep host Node stdio).

```bash
cp .env.docker.example .env.docker
# Edit .env.docker — compose env_file is the real config surface
docker compose up --build
```

| Artifact | Role |
|----------|------|
| `Dockerfile` | Multi-stage Node 20; non-root; no secrets; image ENV wallets **false** (secretless) |
| `docker-compose.yml` | `env_file: .env.docker` (required); wallet volume commented |
| `.env.docker.example` | Template → gitignored `.env.docker` |

**Config surface:** put RPC, wallet flags, and keys in **`.env.docker`**. Compose does not re-map those from host shell interpolation. Missing `.env.docker` fails loudly.

Containers default to **research-only** (`AGENT_WALLET_ENABLED=false`) so the image never needs a baked master key. To enable wallets in Docker: set the key + flag in `.env.docker` and a unique volume. Product default for host Node remains wallets-on.

**Networking:** Docker Desktop uses `host.docker.internal` to reach a host Go-Pulse RPC (see `.env.docker.example`). On Linux, prefer `network_mode: host` in compose for `127.0.0.1:8545`.

### stdio vs HTTP in Docker

| Mode | When |
|------|------|
| **stdio** (default) | Compose smoke; not a substitute for IDE host spawn |
| **HTTP** | Set `HTTP_TRANSPORT_PORT` in `.env.docker` — binds 127.0.0.1 only |

### Wallet volumes

One container → one unique volume/dir. Never share with another writer. Never bake `AGENT_WALLET_MASTER_KEY` into the image.

```bash
docker build -t pulsechain-mcp:1.0.6 .
docker run --rm -it -e AGENT_WALLET_ENABLED=false pulsechain-mcp:1.0.6
```

---

## Optional Streamable HTTP (local only)

Set `HTTP_TRANSPORT_PORT` only when **not** using stdio agent hosts. Serves `/mcp` + `GET /health` on `127.0.0.1`. Wallets-on HTTP requires `AGENT_WALLET_MRTR_SECRET` (≥32 bytes UTF-8); stdio may omit it (process-local HMAC). Do not reuse `AGENT_WALLET_MASTER_KEY`. Shared `AGENT_WALLET_DIR` is still not multi-writer-safe.
