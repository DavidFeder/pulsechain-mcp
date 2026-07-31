# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-07-31

**Trust-polish patch** (H1–H3 from post-1.0.0 feature review). Operator-trust model unchanged: funding authorizes; no hard `MAX_PLS_*` gates reintroduced.

### Before → after

| Area | Before (1.0.0) | After (1.0.1) |
|------|----------------|---------------|
| **H1 pair ranking** | `get_token_info` could lead with high-reserveUSD / near-zero-volume junk; `total_liquidity_usd` and PulseX links followed raw subgraph order | Pairs quality-ranked (catalog rails preferred; ghost/polluted reserves demoted); ghost rails excluded from `total_liquidity_usd`; PulseX link uses preferred ranked pair. Residual: subgraph can still be wrong — ranking is trust improvement, not an oracle |
| **H2 legacy caps** | `list_agent_wallets` / `get_agent_wallet_info` showed `maxPlsPerTx` / `maxPlsDaily` as plain numbers that looked enforceable | Every public wallet summary includes `legacyCapsDisplayOnly: true` + short note (consistent with status/propose). Caps remain display-only compatibility fields |
| **H3 PulseSwap readiness** | `quoteReady: true` with `amountInUpstream: "0"` and `amountOutUSD: "0"` looked fully ready | `quoteReady` = advisory non-zero amountOut only; `priceUsdReady` requires positive `amountOutUSD`; `executionReady` always `false`; amountIn request-echo preserved |

### Changed

- Analytics helpers: ghost-liquidity detection, catalog rail score, quality ranking, trust-worthy liquidity sum
- Wallet public `toPublic`: additive display-only markers on list/info (and all paths using `toPublic`)
- PulseSwap normalize: `priceUsdReady`, `executionReady`, `amountInUpstreamZero` + clearer note/tool description
- Version surfaces **1.0.1**

### Unchanged

- Dual-era MCP, multi-RPC, identity catalog, OT wallet model, no product-facing hard spend caps

## [1.0.0] - 2026-07-29

**First public stable major.** MCP TypeScript SDK pinned to stable **2.0.0** for the released **2026-07-28** protocol; dual-era support retained. No wallet architecture redesign. Product-facing `MAX_PLS_*` spend-cap knobs removed from examples/templates/docs.

### Highlights

| Item | Detail |
|------|--------|
| **MCP SDK** | `@modelcontextprotocol/server` / `node` / `codemod` **2.0.0** (exact pins; no beta) |
| **Protocol** | Dual-era **`dual:2026-07-28+2025-11-25`** (stdio primary; Streamable HTTP local-test only) |
| **Version** | Surfaces **1.0.0** (package, `SERVER_VERSION`, health, README, Docker, examples, env templates) |
| **Wallets** | On by default; research-only via `AGENT_WALLET_ENABLED=false`; operator-trust (funding authorizes; confirm is host-strength UX) |
| **Spend caps** | No product-facing `MAX_PLS_PER_TX` / `MAX_PLS_DAILY` knobs in examples, env templates, or operator tables |

### Changed

- Bumped MCP runtime deps from `2.0.0-beta.5` → stable **`2.0.0`** (coordinated server / node / core / codemod)
- Product docs: SDK described as **stable** for the 2026-07-28 era; dual-era client guidance retained
- **Removed product-facing `MAX_PLS_PER_TX` / `MAX_PLS_DAILY` knobs** from client MCP examples, env templates, and operator tables so new installs do not inherit fake Ethereum-style “safety” numbers
- Operator-trust honesty: **funding authorizes**; real controls are **small balances**, **master key**, **unique `AGENT_WALLET_DIR`**, and **`kill_switch`**. Optional legacy env parse remains in code for compatibility only — **not** advertised as required controls
- Public doc set: SECURITY / SECURITY_DEEP / BOOTSTRAP / AGENT_GUIDANCE / TOKEN_IDENTITY / AGGREGATORS / OPERATOR (no internal archive or readiness scaffolding in-tree)

### Unchanged

- Tool surface, operator-trust model, encryption (AES-256-GCM), multiproc ownership model
- Address-first identity (pHEX/eHEX), aggregator quote/prepare posture
- Setup path: short human README → agent `docs/BOOTSTRAP.md`

### Residual honesty (not blockers for 1.0.0)

- Confirm / MRTR UX is only as strong as the host
- Multiproc is process-local; unique `AGENT_WALLET_DIR` remains the multi-instance model
- Prices / 24h data are upstream-quality, not settlement-grade oracles
- Not recommended as multi-tenant SaaS

## [0.4.1] - 2026-07-29

Public-ready polish: active docs/examples free of lab-testing framing; package description + keywords aligned with GitHub topics; version surfaces **0.4.1**. Runtime wallets and operator-trust model unchanged.

## [0.4.0] - 2026-07-29

Public-ready docs split: essentials-only [SECURITY.md](docs/SECURITY.md) front door; optional residual detail in [SECURITY_DEEP.md](docs/SECURITY_DEEP.md). Agent setup remains [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md).

## [0.3.x] - 2026-07-29

| Tag | Focus |
|-----|--------|
| **0.3.2** | Human short README + agent-first bootstrap path |
| **0.3.1** | Codex / multi-client examples polish |
| **0.3.0** | Wallets **on by default**; research-only via `AGENT_WALLET_ENABLED=false` |

## Earlier history

Development through **0.1.x–0.2.x** established the product core:

- PulseChain read-only analytics, multi-RPC, DexScreener discovery
- Dual MCP protocol support (modern + legacy era)
- Encrypted operator-trust agent wallets (AES-256-GCM; propose → confirm → execute)
- Address-first e*/p* token identity guidance (pHEX preferred-hex exception)
- Piteas / Switch quote-prepare posture (no auto-broadcast)

Intermediate private build notes were condensed for the public history.
