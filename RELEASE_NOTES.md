# Release notes — pulsechain-mcp 1.0.11

## What shipped (1.0.11)

- `pulsex_buy_and_burn` is a read-only chain 369 status check for the PulseX buyback proxy. It reports whether `paused()` or `enabled()` says the contract is running, and how much PLSX sits at the dead address versus inside the buyback.
- If those views are missing, `running` is unknown. The tool does not guess from admin gates, and it does not call `buyAndBurn` or `convertLps`.
- Tool counts **89** / **79** slim. Full profile **104** / **94**.

Version surfaces: package, `SERVER_VERSION`, health, and Docker tag **1.0.11**.

# Release notes — pulsechain-mcp 1.0.10

## What shipped (1.0.10)

- `hex_stake_summary` is a read-only PulseChain pHEX stake summary: days left, ending-soon, approximate T-shares, principal, and a share-rate yield estimate.
- Yield is omitted when current day or share rate is missing. It is not an endStake payout, an audit, or financial advice.
- pHEX and eHEX USD context comes from existing PulseX or DexScreener reads. No Ethereum RPC.
- Tool counts **88** / **78** slim. Full profile **103** / **93**.

Version surfaces: package, `SERVER_VERSION`, health, and Docker tag **1.0.10**.

# Release notes — pulsechain-mcp 1.0.9

## What shipped (1.0.9)

- Liquid Loans nominal ICR is PLS per USDL, not a percent. Vault debt and collateral are the entire amounts used for ICR, and `netDebtUsdl` subtracts the gas reserve.
- Price reads simulate `fetchPrice` and report oracle status. `lastGoodPrice` is the fallback.
- `liquid_loans_position` reads a compounded stability-pool deposit, LOAN stake, and collateral surplus. The system snapshot adds pool debt share and the lowest-ICR vault.
- Tool counts **87** / **77** slim. Full profile **102** / **92**.

Version surfaces: package, `SERVER_VERSION`, health, and Docker tag **1.0.9**.

# Release notes — pulsechain-mcp 1.0.8

## What shipped (1.0.8)

- Default RPC list leads with canonical PublicNode (`https://pulsechain-rpc.publicnode.com`). Legacy `pulsechain.publicnode.com` still answers chain id 369 and stays in the fallback list. RPC posts send `User-Agent: pulsechain-mcp`.
- `piteas_prepare_swap` reads ERC-20 allowance when `owner` is set and returns unsigned approve calldata when it is short. Pass `proposalQuoteReview` into `propose_agent_tx` so review shows the quote even when the router selector is unknown. Stale quotes are labeled and do not block the send.
- `transfer_token` proposes an ERC-20 transfer (no broadcast). `USDL` and `LOAN` are explicit catalog symbols, not aliases of DAI or USD.
- `liquid_loans_system` and `liquid_loans_vault` are read-only.
- Tool profile defaults to **slim** (86 wallets-on / 76 research-only). `PULSECHAIN_TOOL_PROFILE=full` restores 15 legacy `pulsechain_*` aliases.

Version surfaces: package, `SERVER_VERSION`, health, and Docker tag **1.0.8**.

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
# reload the MCP host so pulsechain_health.version shows 1.0.9
```

Optional smoke after reload:

1. `pulsechain_health` → version `1.0.9`, `toolProfile` `slim`
2. Research-only: write tools are absent from `tools/list` while `AGENT_WALLET_ENABLED` is unset or `false`
3. Wallets-on: `agent_wallet_status` shows `fundingAuthorizesSpend: true`; no spend-cap / confirm write gates
4. Legacy `pulsechain_*` aliases stay off unless `PULSECHAIN_TOOL_PROFILE=full`

Tags **v1.0.0**–**v1.0.8** remain historical; **v1.0.9** is this release.

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

1. Confirm tags: **`v1.0.0`**–**`v1.0.8`** untouched; **`v1.0.9`** on this release commit.
2. About / topics: pulsechain, mcp, web3, defi, phiat, piteas (operator choice).
