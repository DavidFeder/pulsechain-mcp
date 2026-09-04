# Release notes — pulsechain-mcp 1.0.7

Public package: **[pulsechain-mcp](https://github.com/DavidFeder/pulsechain-mcp)**.

## What shipped (1.0.7)

Operator-trust cleanup and remaining review items from PRs #18–#19. If you fund an agent wallet, the agent can spend it.

- **Wallet:** removed fake spend caps, allowlists, confirm/MRTR write gates, and leftover “display-only limit” fields. Send-time blocks: kill switch, `enabled=false`, invalid address/value.
- **Default:** `AGENT_WALLET_ENABLED` unset/empty → false. Signing is opt-in (`true` + 64-hex master key).
- **Testnet / tools:** official v4 explorer + PulseX subgraphs; canonical `get_token_transfers`; live `eth_chainId` before sign; heuristic scores labeled not settlement-grade.
- **Packaging:** npm pack includes `scripts/` (`generate-wallet-env`, write-only `.env.wallet`, `install-for-host`).
- **Version surfaces:** package, `SERVER_VERSION`, health, docs, Docker/compose report **1.0.7**. Tool counts **97** / **88**.

Dual-era MCP (`2026-07-28` + `2025-11-25`), AES-256-GCM keys, unique `AGENT_WALLET_DIR`, and research-first agent install remain.

## Upgrade

```bash
git pull
npm install
npm run build
# Prefer: node scripts/install-for-host.mjs --host <host> --mode research
# reload the MCP host so pulsechain_health.version shows 1.0.7
```

Optional smoke after reload:

1. `pulsechain_health` → version `1.0.7`
2. Research-only: write tools are absent from `tools/list` while `AGENT_WALLET_ENABLED` is unset or `false`
3. Wallets-on: `agent_wallet_status` shows `fundingAuthorizesSpend: true`; no spend-cap / confirm write gates

Tags **v1.0.0**–**v1.0.6** remain historical; **v1.0.7** is this release.

## What shipped earlier

- **1.0.6:** agent-surface, chain/policy correctness, reliability, and packaging (PRs #3–#16).
- **1.0.5:** review-hardening (configured-chain signing, confirm binds proposal contents, analytics skip/path/TVL/volume-window fixes).
- **1.0.4:** `phiat_dashboard` + `piteas_accumulation_plan` (research-only quote analytics).
- **1.0.3:** key-install hygiene (write-only recovery text; no console.log key recipe).
- **1.0.2:** agent-safe install path (research-first, write-only keys, install-for-host).
- **1.0.1:** pair ranking trust polish, legacy caps display-only markers, PulseSwap readiness flags.
- **1.0.0:** public stable major; MCP SDK **2.0.0**; dual-era protocol; OT wallets.

## Residual honesty (unchanged product limits)

| Residual | Meaning |
|----------|---------|
| Multiproc | Process-local barrier; not multi-writer-safe across hosts sharing a dir |
| Confirm / MRTR | Unused for wallet writes; host UX only if present — not a cryptographic security product |
| Legacy `MAX_PLS_*` | Removed as product spend-caps; operator-trust is funding + kill_switch + `enabled=false` (not hard spend gates) |
| Windows file modes | chmod 600/700 is best-effort; use NTFS ACLs for real restriction |
| Host reload | Install session doctor ≠ tools injected into the same chat |
| Analytics quotes | Piteas/BlockScout/DexScreener data is advisory research — heuristic_directional, not settlement-grade |

## Operator-trust reminder

Funding the agent is authorization. Fund only what you accept the agent may spend. Prefer small balances + kill_switch.

## Tag / about topics

1. Confirm tags: **`v1.0.0`**–**`v1.0.6`** untouched; **`v1.0.7`** on this release commit.
2. About / topics: pulsechain, mcp, web3, defi, phiat, piteas (operator choice).
