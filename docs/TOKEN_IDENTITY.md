# Token identity — PulseChain e*/p* and traps

**Address identity always beats ticker.** Symbol search is discovery-only.

PulseChain is a **full-state fork of Ethereum**. Many contracts exist at the **same address** as on Ethereum but are **PRC-20 on chain 369**, not Ethereum ERC-20s. Separately, assets can be **bridged** via [bridge.pulsechain.com](https://bridge.pulsechain.com) onto **new** addresses.

---

## Community e* / p* naming

| Prefix | Meaning | Guidance |
|--------|---------|----------|
| **e\*** | Bridged from Ethereum | Legitimate (eHEX, eUSDC, eUSDT, eWBTC, …) |
| **p\*** | State-fork copy | **Typically useless** (pDAI, pWBTC, …) |
| **Exception** | **pHEX** `0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39` | Preferred HEX on PulseChain (state-fork but **not** “typically useless”) |

---

## High-confusion pairs

| Asset | Bridged (real path) | State fork | Symbol rules |
|-------|---------------------|------------|--------------|
| **DAI** | `0xefD7…F305` (~$1) | `0x6B17…1d0F` (**pDAI**, not $1) | `DAI` → bridged; `PDAI` / `FORK_DAI` → fork |
| **HEX** | `0x57fd…D225` (**eHEX**) | `0x2b59…eb39` (**pHEX** / `HEX`, preferred) | `HEX` / `PHEX` → pHEX; `EHEX` → eHEX |
| **USDC** | `0x15D3…1f07` (**eUSDC**) | — | `USDC` / `EUSDC` → eUSDC |
| **USDT** | `0x0Cb6…1A2f` (**eUSDT**) | `0xdAC1…1ec7` (forked) | `USDT` / `EUSDT` → eUSDT; `FUSDT` → fork |
| **WBTC** | `0xb17D…5cA1` (**eWBTC**) | `0x2260…C599` (**pWBTC**) | `WBTC` / `EWBTC` → eWBTC; `PWBTC` → fork |
| **WETH** | `0x02Dc…3C3C` | `0xC02a…6Cc2` (forked) | `WETH` → bridged; `FWETH` → fork |

Bridged stables (DAI / eUSDC / eUSDT) are the dollar-oriented assets. Forked “stables” and pWBTC are not.

**Agents must never confuse:** pHEX vs eHEX; bridged DAI vs pDAI; eUSDC vs spoof “USDC” tickers.

---

## DexScreener usage

| Tool | Role |
|------|------|
| `dexscreener_search` | **Discovery only** — tickers spoof easily |
| `dexscreener_pair` / `dexscreener_token_pairs` / `dexscreener_tokens` | **Identity** by address |

- Honor `catalog_coverage` and `recommended_address_followups` when search is empty or spoof-dominated.
- Catalog origin labels attach **only** for known addresses — never invented for unknowns.
- Fail-soft on upstream errors/rate limits (~60/min on some routes).

Known major pair addresses (catalog follow-ups for `dexscreener_pair` only — not invented search rows) include eUSDC/bridged-DAI, eUSDT, and eHEX majors; re-check live when routing capital.

---

## Tool labeling

When a catalogued address appears, tools may attach:

- `display_symbol`, `token_origin`
- `identity_note` / `warning`
- pair-side `token0/1_display_symbol` + origin

Resource: `pulsechain://tokens/core` embeds dual-DAI and token-origin guidance.

**Catalog is incomplete by design** — unknown symbols still require address verification.

---

## HEX stake tools

| Tool | pHEX | eHEX |
|------|------|------|
| `hex_global_state` | On-chain globals | Soft-fail (ERC-20 only, not stake contract) |
| `hex_stakes_for_address` | stakeCount / stakeLists | Soft-fail / non-stake |

pHEX is stakeable state-fork HEX. eHEX is bridged ERC-20 exposure without those stake views.
