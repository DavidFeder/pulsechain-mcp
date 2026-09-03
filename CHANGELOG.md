# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Swap and explorer pages expose machine-readable incompleteness: `get_wallet_swaps` / `get_recent_swaps` set `incomplete` plus a `coverage` object on deep or pair-capped subgraph pages; `blockscout_event_logs` / `pulsechain_get_logs` and PHIAT Transfer `getLogs` set `truncated` plus a `window` when the row cap is hit (not full history)
- Health and wallet tools declare MCP `outputSchema` for the existing ToolResult envelope (`ok` / `data?` / `error?` / `code?` / `warnings?`); analytics and chain tools stay unset. Health `data` matches `HealthStatus` / RPC health fields (including optional `networkMismatch`). Wallet `data` is a conservative object passthrough with no privateKey/mnemonic/ciphertext fields. SDK v2 already skips output validation for MRTR `InputRequiredResult` and `isError: true`.

### Changed

- Legacy `pulsechain_*` chain scaffold tools stay registered (behavior unchanged) but descriptions lead with `DEPRECATED:` and point at canonical replacements (`get_*`, `pulsechain_health`, `blockscout_event_logs`); agents should prefer those names
- Research-only mode (`AGENT_WALLET_ENABLED=false`) omits write/signing tools from `tools/list`; wallet reads still register; wallets-on still advertises the full 96-tool surface
- MCP tool registrations include SDK `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) derived from the existing `write` flag; unsigned prepare tools stay read-only
- Write-tool warning mentions `confirm=true` and modern MRTR `InputRequiredResult` elicitation (host UX only, not a cryptographic lock)
- `createServer` instructions branch on `agentWalletEnabled` (research-only vs operator-trust wallets)

### Fixed

- `execute_agent_tx`, `sign_and_send`, and `settle_interrupted_broadcast` pass a real `policySnapshotId` (same `snapshotForWallet` helper as other wallet writes) so an MRTR confirm challenge re-prompts if kill, disable, or other policy JSON changes between challenge and resume; a missing wallet record fails closed instead of snapshot `"none"`
- Persist `chainId` and `network` on `TxProposal` at propose time; refuse execute (and `transfer_pls`) when the sealed chain is missing or does not match live config, and bind chain in confirm intent so MRTR cannot reuse a proposal after a mainnet ↔ testnet env flip
- Report the configured PulseChain id (369 mainnet / 943 testnet) on chain tools, unsigned prepare payloads, health, and `pulsechain://chain/config` instead of always stamping 369; testnet with default mainnet explorer/subgraph surfaces `networkMismatch`; Piteas/Switch/PulseSwap quotes stay on aggregator chain 369 and warn when the server is on testnet

## [1.0.5] - 2026-08-28

**Correctness patch** on the 1.0.4 tree (PR #2). Operator-trust wallet model, dual-era MCP (`2026-07-28` + `2025-11-25`), and research-first agent install are unchanged. Version surfaces **1.0.5**.

### Highlights

| Area | Change |
|------|--------|
| **Wallet** | Signing uses configured chain (369/943); execute/settle/`transfer_pls` bind proposal contents; `confirm=false` declines without re-challenge; `transfer_pls` simulates before confirm |
| **Analytics** | Swap skip pagination; PulseX path start/end; bridge TVL unique-pair total; UTC calendar-day volume window; holder-rank page>1 module API |
| **Reliability** | Process-wide Piteas 10/min limiter; tool `structuredContent`; GitHub Actions CI |

### Fixed

- Wallet signing uses the configured network chain (PulseChain testnet 943 vs mainnet 369)
- Execute/settle confirmation binds proposal contents (to, value, data), not only proposal id
- Dual-path `confirm=true` still verifies echoed MRTR `requestState` intentHash
- `transfer_pls` decline happens before propose; sealed reuse binds amount as well as destination
- Proposal/wallet JSON `id` must match the filename
- `confirm=false` / MRTR reject declines instead of re-issuing a challenge
- `transfer_pls` simulates (propose) before confirm so the prompt includes review/fees
- Token-filtered swap `skip` and wallet-swap merged pagination
- Explicit PulseX paths must start/end with `tokenIn`/`tokenOut`
- Bridge TVL no longer double-counts shared stablecoin pools
- Token safety no longer double-counts ABI findings as honeypot flags
- ERC-20 transfer simulation treats ABI `false` as failure
- `get_holder_rank` honors `page` via the module API (v2 is page 1 / cursor)
- `get_wallet_balances` keeps explicit `extraTokens` ahead of core/discovery truncation
- Empty/invalid explorer timestamps no longer mark wallets as age-zero
- Expired proposals that already have a `txHash` remain settleable
- Autoload does not override host-set environment variables
- Uppercase `0X` master keys are treated as raw hex, not passphrases
- Wallet directory/files best-effort mode `0700`/`0600`

### Changed

- Tool results include `structuredContent` alongside JSON text (existing text parse still works)
- `volume_24h` / `price_change_24h` labeled as UTC calendar-day windows
- Confirm prompts disclose truncated token-movement lists
- Process-wide Piteas 10/min limiter; outer quote timeouts abort the limiter wait and HTTP (no ghost requests); 429 is not rapidly retried
- `agent_wallet_check_policy` accepts optional `walletId` for kill/enabled state

## [1.0.4] - 2026-08-05

**Read-only PHIAT + Piteas analytics** (community PR #1 + maintainer review fixes). Research tools only: no wallet, sign, prepare, or broadcast paths. Operator-trust and install model unchanged from 1.0.3.

### Highlights

| Area | Change |
|------|--------|
| **`phiat_dashboard`** | Address-first PHIAT dashboard (holders, market, transfers, safety) with bounded fast Piteas depth (4-quote sandwich) and optional adaptive mode |
| **`piteas_accumulation_plan`** | Standalone adaptive Piteas quote-depth research planner; analytical vs operational thresholds; decimal-safe ladder math |
| **Security boundary** | Tools register `write: false`; analytics call `getPiteasQuote` only; no `piteas_prepare_swap` / agent-wallet / key access |
| **Review fixes** | Keep last usable adaptive recommendation when a later round is unusable; exact threshold inclusivity aligned; constant quote `endpoint` is not freshness; `includeGasEstimate: false` strips gas fields/warnings |
| **Version surfaces** | **1.0.4** |

### Added

- `src/tools/analytics/phiat-dashboard/*`, `phiatDashboard.ts`
- `src/tools/analytics/piteas-accumulation/*`, `piteasAccumulationPlan.ts`
- Large unit suites: `tests/phiat-dashboard.test.ts`, `tests/piteas-accumulation-plan.test.ts`
- Agent guidance rows for PHIAT / accumulation research

### Unchanged

- Operator-trust wallet model, dual-era MCP, multi-RPC, agent-safe install (research-first; write-only keys; launcher)
- No hard spend-cap redesign

## [1.0.3] - 2026-08-01

**Key-install hygiene** from the v1.0.2 security review (R1–R2). Happy-path security model unchanged (write-only `.env.wallet` + launcher; research-only agent first-install). This patch only closes **off-path** messaging foot-guns.

### Highlights

| Area | Change |
|------|--------|
| **Config recovery text** | Missing/short/empty master-key `ConfigError` paths point at `generate-wallet-env.mjs` / `install-for-host --mode wallets`; **no** `console.log(randomBytes…)` recipe |
| **Env templates** | `.env.example` / `.env.lab.example` prefer write-only generation; print/paste discouraged for agents |
| **Product vs agent** | SECURITY + BOOTSTRAP one-line: product may default wallets-on; agent first-install remains research-only via BOOTSTRAP |
| **Migration** | BOOTSTRAP note: remove old inline host `AGENT_WALLET_MASTER_KEY` after moving to launcher + `.env.wallet` |
| **Version surfaces** | **1.0.3** |

### Unchanged

- Operator-trust wallet model, dual-era MCP, multi-RPC, analytics, no hard spend-cap redesign
- Recommended agent install path (research-first; write-only keys; launcher)

## [1.0.2] - 2026-07-31

**Agent-safe install path** from live Grok bootstrap feedback. Operator-trust model unchanged: funding authorizes; no hard `MAX_PLS_*` gates reintroduced.

### Highlights

| Area | Change |
|------|--------|
| **Key-safe wallets-on** | Recommended path: gitignored `.env.wallet` + `scripts/start-wallet-mcp.mjs`; host samples no longer embed `AGENT_WALLET_MASTER_KEY` |
| **Write-only key ceremony** | `scripts/generate-wallet-env.mjs` creates `.env.wallet`, refuses overwrite, never prints the key, best-effort mode 600/700 |
| **Mode fork** | Agent install default = **research-only**; wallets-on only when user asks to sign |
| **Pre/post-reload smoke** | Doctor/logs before reload; `pulsechain_health` → `agent_wallet_status` after; no custom stdio client |
| **install-for-host** | `scripts/install-for-host.mjs --host … --mode research\|wallets` — absolute paths, no secret prints |

### Added

- `scripts/lib/wallet-env.mjs`, `scripts/lib/install-for-host-core.mjs`
- `scripts/generate-wallet-env.mjs`, `scripts/install-for-host.mjs`
- Install-helper unit tests (temp dirs; key not in stdout; refuse-on-exists; research config has no master key)

### Changed

- `docs/BOOTSTRAP.md` rewrite (mode fork, Do NOT box, permissions table, install script preferred)
- Examples default to research-only; launcher documented for wallets-on
- `docs/SECURITY.md`, `examples/README.md`, agent guidance, env template comments
- Version surfaces **1.0.2**

### Unchanged

- Dual-era MCP, multi-RPC, identity catalog, OT wallet model, no product-facing hard spend caps

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
