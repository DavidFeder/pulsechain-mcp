# Release notes — pulsechain-mcp 1.0.4

Public package: **[pulsechain-mcp](https://github.com/DavidFeder/pulsechain-mcp)**.

## What shipped (1.0.4)

- **`phiat_dashboard`:** read-only PHIAT research dashboard (address-first identity, holders, market, transfers, safety) with bounded fast Piteas depth and optional adaptive mode.
- **`piteas_accumulation_plan`:** standalone adaptive Piteas quote-depth planner for accumulation research; dual analytical vs operational thresholds; decimal-safe ladder math.
- **Security boundary:** both tools are research-only (`write: false`); they call **`getPiteasQuote` only** — no prepare/sign/broadcast, no agent wallet, no master-key access.
- **Maintainer review fixes (on merge):** last usable adaptive recommendation retained when a later batch is unusable; exact threshold inclusivity aligned across dashboard and planner; constant quote `endpoint` is not freshness evidence; `includeGasEstimate: false` strips gas fields and related warnings.
- **Version surfaces:** package, `SERVER_VERSION`, health, docs, Docker/compose report **1.0.4**.

Wallet model and agent-safe install path are **unchanged** from 1.0.3.

## Upgrade

```bash
git pull
npm install
npm run build
# Prefer: node scripts/install-for-host.mjs --host <host> --mode research
# reload the MCP host so pulsechain_health.version shows 1.0.4
```

Optional smoke after reload:

1. `pulsechain_health` → version `1.0.4`
2. `phiat_dashboard` with a verified token address (research)
3. `piteas_accumulation_plan` with verified tokenIn/tokenOut (quote research only)

No OT wallet model change. Tags **v1.0.0**–**v1.0.3** remain historical; **v1.0.4** is this feature release.

## What shipped earlier

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

Funding the agent is authorization. Fund only what you accept the agent may spend. Prefer small balances + kill_switch. New 1.0.4 analytics tools do not spend or sign.

## Tag / about topics

1. Confirm tags: **`v1.0.0`**–**`v1.0.3`** untouched; **`v1.0.4`** on this release commit.
2. About / topics: pulsechain, mcp, web3, defi, phiat, piteas (operator choice).
