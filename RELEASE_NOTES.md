# Release notes — pulsechain-mcp 1.0.2

Public package: **[pulsechain-mcp](https://github.com/DavidFeder/pulsechain-mcp)**.

## What shipped (1.0.2)

- **Agent-safe install:** research-only first; wallets-on only when the user asks to sign.
- **Key-safe default:** master key lives in gitignored `.env.wallet` only; host configs do not embed `AGENT_WALLET_MASTER_KEY`. Write-only generation never prints the key.
- **install-for-host:** `node scripts/install-for-host.mjs --host grok|cursor|claude|codex --mode research|wallets`.
- **Pre/post-reload smoke** split so agents stop inventing custom MCP stdio clients.
- **Version surfaces:** package, `SERVER_VERSION`, health, docs, Docker/compose report **1.0.2**.

## Upgrade

```bash
git pull
npm install
npm run build
# Prefer: node scripts/install-for-host.mjs --host <host> --mode research
# reload the MCP host so pulsechain_health.version shows 1.0.2
```

No OT wallet model change. Tags **v1.0.0** / **v1.0.1** remain historical; **v1.0.2** is this patch.

### If you had MASTER_KEY in host config

Move to write-only `.env.wallet` + `scripts/start-wallet-mcp.mjs` (see [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md)). Do not paste the old key into chat.

## What shipped earlier (1.0.1 / 1.0.0)

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

## Operator-trust reminder

Funding the agent is authorization. Fund only what you accept the agent may spend. Prefer small balances + kill_switch.

## Tag / about topics

1. Confirm tags: **`v1.0.0`** + **`v1.0.1`** untouched; **`v1.0.2`** on this release commit.
2. About / topics: pulsechain, mcp, web3, defi (operator choice).
