# Release notes — pulsechain-mcp 1.0.5

Public package: **[pulsechain-mcp](https://github.com/DavidFeder/pulsechain-mcp)**.

## What shipped (1.0.5)

Correctness and hardening from PR #2 on the 1.0.4 tree. **Not** a protocol or wallet-model change.

- **Wallet:** signing uses `chainForConfig` (mainnet 369 / testnet 943); execute/settle/`transfer_pls` confirm binds proposal contents (`to`, `valueWei`, `data`), not only `proposalId`; `confirm=false` / MRTR reject **declines** (no re-challenge); `transfer_pls` simulates before confirm; store dirs `0700` / files `0600`; filename vs embedded `id` must match.
- **Analytics:** token-filtered and wallet-swap skip pagination; explicit PulseX paths must start/end with `tokenIn`/`tokenOut`; bridge TVL unique-pair total; `volume_24h` labeled UTC calendar day (`volume_window`); holder-rank `page>1` uses the module API; `extraTokens` survive truncation; empty explorer timestamps are not age-zero.
- **Reliability:** process-wide Piteas 10 req/min limiter (outer timeouts abort wait + HTTP); tool results include `structuredContent` alongside JSON text; GitHub Actions (Node 20, typecheck, test).
- **Version surfaces:** package, `SERVER_VERSION`, health, docs, Docker/compose report **1.0.5**.

Operator-trust, dual-era MCP (`2026-07-28` + `2025-11-25`), and research-first agent install are **unchanged**.

## Upgrade

```bash
git pull
npm install
npm run build
# Prefer: node scripts/install-for-host.mjs --host <host> --mode research
# reload the MCP host so pulsechain_health.version shows 1.0.5
```

Optional smoke after reload:

1. `pulsechain_health` → version `1.0.5`
2. `get_token_price` on a known address → `volume_window` is `utc_calendar_day`
3. Research-only: write tools still refuse while `AGENT_WALLET_ENABLED=false`

No OT wallet model change. Tags **v1.0.0**–**v1.0.4** remain historical; **v1.0.5** is this patch.

## What shipped earlier

- **1.0.4:** `phiat_dashboard` + `piteas_accumulation_plan` (research-only quote analytics).
- **1.0.3:** key-install hygiene (write-only recovery text; no console.log key recipe).
- **1.0.2:** agent-safe install path (research-first, write-only keys, install-for-host).
- **1.0.1:** pair ranking trust polish, legacy caps display-only markers, PulseSwap readiness flags.
- **1.0.0:** public stable major; MCP SDK **2.0.0**; dual-era protocol; OT wallets.

## Residual honesty (unchanged product limits)

| Residual | Meaning |
|----------|---------|
| Multiproc | Process-local barrier; not multi-writer-safe across hosts sharing a dir |
| Confirm / MRTR | Host UX only — not a cryptographic security product |
| Legacy `MAX_PLS_*` | Display/advisory if present — not hard spend gates |
| Windows file modes | chmod 600/700 is best-effort; use NTFS ACLs for real restriction |
| Host reload | Install session doctor ≠ tools injected into the same chat |
| Analytics quotes | Piteas/BlockScout/DexScreener data is advisory research — not execution guarantees |

## Operator-trust reminder

Funding the agent is authorization. Fund only what you accept the agent may spend. Prefer small balances + kill_switch.

## Tag / about topics

1. Confirm tags: **`v1.0.0`**–**`v1.0.4`** untouched; **`v1.0.5`** on this release commit.
2. About / topics: pulsechain, mcp, web3, defi, phiat, piteas (operator choice).
