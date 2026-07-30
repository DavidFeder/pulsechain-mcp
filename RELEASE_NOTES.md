# Release notes — pulsechain-mcp 1.0.0

**First public stable major.** Stable MCP TypeScript SDK for the final 2026-07-28 protocol, dual-era retained, no product-facing `MAX_PLS_*` spend-cap knobs.

## What shipped (1.0.0)

- **MCP SDK:** exact pins `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/node@2.0.0` (stable; no beta).
- **Protocol:** dual-era **`dual:2026-07-28+2025-11-25`**. Stdio primary; Streamable HTTP local-test only.
- **Wallets / trust model:** wallets on by default; research-only with `AGENT_WALLET_ENABLED=false`; funding authorizes; confirm is host-strength UX only.
- **Examples / env templates:** no `MAX_PLS_PER_TX` / `MAX_PLS_DAILY` product defaults. Operator-trust controls are small balances, master key, unique dir, kill_switch.
- **Version surfaces:** package, `SERVER_VERSION`, health, docs, Docker/compose, examples report **1.0.0**.
- **Public docs:** SECURITY / SECURITY_DEEP / BOOTSTRAP / AGENT_GUIDANCE / TOKEN_IDENTITY / AGGREGATORS / OPERATOR (no internal archive or V1 readiness scaffolding).

## Upgrade / first install

```bash
git clone https://github.com/DavidFeder/pulsechain-mcp.git
cd pulsechain-mcp
npm install
npm run build
# wire a client example from examples/ — see docs/BOOTSTRAP.md
# reload the MCP host so pulsechain_health.version shows 1.0.0
# if you copied old examples with MAX_PLS_*=10/50, drop those lines
```

Smoke: `pulsechain_health` → `agent_wallet_status` → `get_rpc_health` (or any RO market tool).

## Residual honesty

SDK beta is no longer a blocker. Remaining limits are product/ops: host soak for confirm/MRTR UX, multiproc process-local locks, catalog depth for long-tail tokens, upstream price quality, and no multi-tenant SaaS recommendation.

Full detail: [CHANGELOG.md](CHANGELOG.md) · [MIGRATION_NOTES.md](MIGRATION_NOTES.md) · [docs/SECURITY.md](docs/SECURITY.md)

---

## Operator publish checklist (after private v1.0.0 root is ready)

Repo stays private until you flip visibility yourself. Suggested GitHub About / topics:

| Field | Value |
|-------|--------|
| **About** | PulseChain MCP server for AI agents: chain reads, markets, swap quotes, and encrypted operator-trust wallets |
| **Topics** | `pulsechain`, `mcp`, `model-context-protocol`, `web3`, `defi`, `hex`, `pulsex`, `agent-wallets`, `typescript`, `stdio` |

1. Confirm tags on the root commit: **`v1.0.0` only** (no extra release tags you do not want public).
2. Confirm no secrets in the tree (no filled `.env*`, wallet dirs, master keys).
3. Set **About** description and **topics** (Settings → General, or repo home gear).
4. **Settings → General → Danger Zone → Change repository visibility → Make public** when ready.
