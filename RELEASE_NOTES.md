# Release notes — pulsechain-mcp 1.0.1

**Trust-polish patch** on public **1.0.0**. H1 pair ranking / liquidity trust, H2 legacy cap display-only on all wallet surfaces, H3 PulseSwap readiness/USD clarity. Operator-trust unchanged (funding authorizes; no hard spend-cap reintroduction).

## What shipped (1.0.1)

- **H1:** `get_token_info` pair lists quality-ranked (catalog rails preferred; ghost/polluted reserves demoted); junk excluded from `total_liquidity_usd`; PulseX link uses preferred ranked pair. Residual: not an oracle.
- **H2:** `list_agent_wallets` / `get_agent_wallet_info` (all `toPublic` paths) include `legacyCapsDisplayOnly: true` + note.
- **H3:** PulseSwap `priceUsdReady`, `executionReady: false`, `amountInUpstreamZero`; amountIn echo preserved; `quoteReady` = advisory amountOut only.
- **Version surfaces:** package, `SERVER_VERSION`, health, docs, Docker/compose, examples report **1.0.1**.

## Upgrade from 1.0.0

```bash
git pull
npm install
npm run build
# reload the MCP host so pulsechain_health.version shows 1.0.1
```

No config migration. Wallet OT model unchanged. Tag **v1.0.0** remains the public root; **v1.0.1** is this patch.

## Residual honesty

Same as 1.0.0: host-strength confirm, process-local multiproc, upstream prices, not multi-tenant SaaS. Pair ranking improves trust but cannot fix all subgraph noise.

Full detail: [CHANGELOG.md](CHANGELOG.md) · [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md)

---

## What shipped (1.0.0)

- **MCP SDK:** exact pins `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/node@2.0.0` (stable; no beta).
- **Protocol:** dual-era **`dual:2026-07-28+2025-11-25`**. Stdio primary; Streamable HTTP local-test only.
- **Wallets / trust model:** wallets on by default; research-only with `AGENT_WALLET_ENABLED=false`; funding authorizes; confirm is host-strength UX only.
- **Examples / env templates:** no `MAX_PLS_PER_TX` / `MAX_PLS_DAILY` product defaults. Operator-trust controls are small balances, master key, unique dir, kill_switch.
- **Version surfaces:** package, `SERVER_VERSION`, health, docs, Docker/compose, examples report **1.0.0**.
- **Public docs:** SECURITY / SECURITY_DEEP / BOOTSTRAP / AGENT_GUIDANCE / TOKEN_IDENTITY / AGGREGATORS / OPERATOR (no internal archive or V1 readiness scaffolding).

## Residual honesty (1.0.0 baseline)

SDK beta is no longer a blocker. Remaining limits are product/ops: host soak for confirm/MRTR UX, multiproc process-local locks, catalog depth for long-tail tokens, upstream price quality, and no multi-tenant SaaS recommendation.

## Operator publish checklist (historical — public root already published)

| Field | Value |
|-------|--------|
| **About** | PulseChain MCP server for AI agents: chain reads, markets, swap quotes, and encrypted operator-trust wallets |
| **Topics** | `pulsechain`, `mcp`, `model-context-protocol`, `web3`, `defi`, `hex`, `pulsex`, `agent-wallets`, `typescript`, `stdio` |

1. Confirm tags: **`v1.0.0`** baseline + **`v1.0.1`** patch (do not move v1.0.0).
2. Confirm no secrets in the tree (no filled `.env*`, wallet dirs, master keys).
3. About / topics as above when public.
