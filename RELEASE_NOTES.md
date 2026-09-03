# Release notes — pulsechain-mcp 1.0.6

Public package: **[pulsechain-mcp](https://github.com/DavidFeder/pulsechain-mcp)**.

## What shipped (1.0.6)

Agent-surface, chain/policy correctness, reliability, and packaging from PRs #3–#16 on the 1.0.5 tree. **Not** a protocol or wallet-model change.

- **Agent / MCP:** tool `annotations`; research-only (`AGENT_WALLET_ENABLED=false`) omits write tools from `tools/list`; `outputSchema` on health and wallet tools; legacy `pulsechain_*` chain tools marked `DEPRECATED:`.
- **Correctness:** configured chainId (369/943) on chain tools, health, unsigned prepare, and `pulsechain://chain/config`; proposals seal `chainId`/`network`; execute/settle/`sign_and_send` use a real `policySnapshotId`; swap/explorer pages set `incomplete`/`truncated` when capped.
- **Reliability:** explorer/subgraph HTTP 429 retry with capped Retry-After; CI ESLint + Node 20/22 + targeted coverage + docker build.
- **Wallet:** AES-256-GCM AAD binds `walletId` + address (`aadVersion: 1`; legacy blobs still decrypt); wallets-on `AGENT_WALLET_MULTIPROC_STRICT` defaults true; wallets + HTTP require `AGENT_WALLET_MRTR_SECRET`; opt-in `AGENT_WALLET_ENFORCE_LEGACY_CAPS` (`true`/`1`) hard-denies stored `MAX_PLS_*` / allowlists / token caps — unset stays operator-trust (display-only).
- **Packaging:** npm pack includes `docs/` + `examples/`; unused production helpers removed.
- **Version surfaces:** package, `SERVER_VERSION`, health, docs, Docker/compose report **1.0.6**. Tool counts stay **96** / **87**.

Operator-trust, dual-era MCP (`2026-07-28` + `2025-11-25`), and research-first agent install (`generate-wallet-env`, write-only `.env.wallet`, `install-for-host`) are **unchanged**.

## Upgrade

```bash
git pull
npm install
npm run build
# Prefer: node scripts/install-for-host.mjs --host <host> --mode research
# reload the MCP host so pulsechain_health.version shows 1.0.6
```

Optional smoke after reload:

1. `pulsechain_health` → version `1.0.6`
2. Research-only: write tools are absent from `tools/list` while `AGENT_WALLET_ENABLED=false`
3. Wallets-on: `agent_wallet_status` still shows operator-trust (legacy caps display-only) unless `AGENT_WALLET_ENFORCE_LEGACY_CAPS=true`

No OT wallet model change. Tags **v1.0.0**–**v1.0.5** remain historical; **v1.0.6** is this patch.

## What shipped earlier

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
| Confirm / MRTR | Host UX only — not a cryptographic security product |
| Legacy `MAX_PLS_*` | Display/advisory if present — not hard spend gates unless `AGENT_WALLET_ENFORCE_LEGACY_CAPS` is on |
| Windows file modes | chmod 600/700 is best-effort; use NTFS ACLs for real restriction |
| Host reload | Install session doctor ≠ tools injected into the same chat |
| Analytics quotes | Piteas/BlockScout/DexScreener data is advisory research — not execution guarantees |

## Operator-trust reminder

Funding the agent is authorization. Fund only what you accept the agent may spend. Prefer small balances + kill_switch.

## Tag / about topics

1. Confirm tags: **`v1.0.0`**–**`v1.0.5`** untouched; **`v1.0.6`** on this release commit.
2. About / topics: pulsechain, mcp, web3, defi, phiat, piteas (operator choice).
