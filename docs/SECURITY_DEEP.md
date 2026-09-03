# Security deep residual — pulsechain-mcp

> **Secondary reference only.** First-run setup: [BOOTSTRAP.md](BOOTSTRAP.md). Short essentials: [SECURITY.md](SECURITY.md).  
> You do **not** need this file for bootstrap smoke or day-to-day research. Read when you need launcher tables, multiproc matrices, encryption internals, crash windows, reviewSummary fields, or token-notional residual detail.

Also: [AGENT_GUIDANCE.md](AGENT_GUIDANCE.md) · [TOKEN_IDENTITY.md](TOKEN_IDENTITY.md) · [OPERATOR.md](OPERATOR.md).

---
## Product default (v0.3.0+)

1. **`AGENT_WALLET_ENABLED` defaults to `true`** — signing tools are available after you set a master key and create/fund a wallet.
2. **Master key is required** when wallets are enabled (including the default). Startup fails with a clear setup message if it is missing.
3. **Research-only:** set **`AGENT_WALLET_ENABLED=false`** and omit the master key — write/signing tools refuse; analytics and quotes still work.
4. Prefer **stdio** clients (Cursor / Grok / Claude / Codex) with absolute path to `dist/index.js`.
5. Multi-RPC (`PULSECHAIN_RPC_URLS`) with local/LAN first when available — see [OPERATOR.md](OPERATOR.md).
6. Prefer **token addresses** over symbols — see [TOKEN_IDENTITY.md](TOKEN_IDENTITY.md).
7. Treat safety/scam/USD heuristics as **directional**, not settlement-grade.

Run wallets on a machine you control, with a strong master key and unique `AGENT_WALLET_DIR`. This is **not** a custody-policy product: when enabled and funded, spend caps/allowlists are not hard gates.

### Two product modes

| Mode | Host entry | Wallets | Use |
|------|------------|---------|-----|
| **Wallets on (product default)** | `dist/index.js` + master key, or `scripts/start-wallet-mcp.mjs` | On | Encrypted EOAs under **operator-trust** |
| **Research-only** | `dist/index.js` + `AGENT_WALLET_ENABLED=false` | Off | Analytics, prices, identity, unsigned prepare |

### First-run master key

```bash
# Preferred write-only (never prints the key):
#   node scripts/generate-wallet-env.mjs
# Discouraged (prints key to stdout — avoid in agent terminals):
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Prefer write-only `.env.wallet` (never host config). Never commit it. Lose it → encrypted wallets are unrecoverable.

---

## Agent wallet mode (operator-trust)

**Operator-trust:** funding the agent is authorization. The steps below are operational (unique dir, multiproc, encrypted keys, gas-aware funding), **not** a claim that PLS caps or allowlists hard-stop spending.

Template for a dedicated process: [`.env.wallet.example`](../.env.wallet.example) (write-only via `scripts/generate-wallet-env.mjs`; never commit the master key). Default client samples under `examples/` are **research-only**; wallets-on uses `start-wallet-mcp.mjs` + `.env.wallet` (no master key in host config).

### Supported wallet launcher

**Preferred for multiproc-strict:** use [`scripts/start-wallet-mcp.mjs`](../scripts/start-wallet-mcp.mjs) as the host entry. It loads gitignored `.env.wallet` (falls back to a local compatibility env filename if present), enables wallets, sets multiproc strict, and starts `dist/index.js`.

| Host field | Wallet-mode value |
|------------|-------------------|
| `command` | `node` |
| `args` | `["<ABS_CLONE_ROOT>/scripts/start-wallet-mcp.mjs"]` |

**Sticky-host fallback (optional):** some hosts keep respawning bare `dist/index.js` despite config. After a clean rebuild, create an empty gitignored opt-in marker:

`data/wallets/.enable-wallet-autoload`

When that marker **and** a wallet env file (`.env.wallet`, or a local compatibility env file the launcher still accepts) exist, `dist/index.js` loads the same wallet env rules as the launcher (shipped sticky-host autoload module — survives `tsc`). Prefer fixing the host to run `start-wallet-mcp.mjs` when possible; the marker is not a secret and never ships in git (`data/wallets/` is gitignored).

Research-only hosts: `AGENT_WALLET_ENABLED=false`, no master key, no autoload marker.

After `npm run build`, restart the MCP host / refresh MCP so the process loads the new dist.

**Wallet-mode posture (required when signing):**

| Setting | Value | Why |
|---------|-------|-----|
| `AGENT_WALLET_ENABLED` | `true` (default) | Signing available on this process |
| `AGENT_WALLET_DIR` | unique path (e.g. `./data/wallets`) | One process → one dir; never share across hosts |
| `AGENT_WALLET_MULTIPROC_STRICT` | `true` recommended | Refuse writes on live foreign-owner conflict |
| `AGENT_WALLET_MASTER_KEY` | 64-char hex preferred (or passphrase ≥16) | Offline-generated; password manager only |
| `MAX_PLS_PER_TX` / `MAX_PLS_DAILY` | **omit** (optional legacy parse only) | **Not product controls** — display-only if set; not hard gates; not template defaults |

Docker images keep **`AGENT_WALLET_ENABLED=false`** so containers stay secretless unless you opt in via `.env.docker`.

### PulseChain gas (operator terms — read before funding)

PulseChain uses **EIP-1559**. Gas is priced in **BEATS** (1 PLS = 10¹⁸ BEATS). Base fees are often large in BEATS, so **fee cost in PLS terms is commonly large** even when the USD cost is small. Do **not** treat PulseChain like low-gwei Ethereum.

| Activity (order-of-magnitude) | Typical gas cost in PLS |
|-------------------------------|-------------------------|
| Simple PLS transfer | tens of PLS |
| Approval / token transfer | tens to low hundreds of PLS |
| Swap (PulseX-class) | often ~250+ PLS |

**Three numbers agents and operators must separate:**

1. **Value transferred** — native PLS `value`  
2. **Estimated gas cost** — additional PLS burned for fees  
3. **Total PLS that must be available in-wallet** — value + gas headroom  

A **tiny-value** tx (e.g. 0.01 PLS transfer) can still need **substantial PLS for gas**. Funding pays gas; legacy `MAX_PLS_*` fields do not hard-stop spends.

**Recommended funding ranges (operator-trust):**

| Stage | Fund roughly | Notes |
|-------|--------------|-------|
| Native transfer first | ~100–300 PLS (tens for gas + small value) | Prefer this before approve/swap |
| Approve / token transfer | ~200–500 PLS | Operator-trust: no hard allowlist gate |
| Swap-class | ~500–1500+ PLS | Fund enough for gas + value; kill_switch if needed |

**Steps (stop after step 2 until you fund for gas + value):**

1. **Create** — `create_agent_wallet` with `confirm=true` (optional `label`). Returns public address + wallet id only.
2. **Verify address exists** — `agent_wallet_status` (`operatorAtAGlance` should show wallets ON, multiproc mode, dir ownership) → `list_agent_wallets` / `get_agent_wallet_info`. Confirm **no** private key / ciphertext / master key in tool output.
3. **Fund later (gas-aware)** — send enough PLS for **gas + intended value** (see table above); not “1 PLS dust” Ethereum thinking. Create/verify does not require funding.
4. **Then careful signing** — prefer **native transfer first**, then approve/token, then swap. Flow: `inspect_tx_intent` (if calldata unclear) → `propose_agent_tx` → read **`reviewSummary` / `agentGuidance` / `safetyHints`** (value vs gas) → `execute_agent_tx` with confirm only after review.

Do **not** broadcast, auto-confirm, or raise caps until step 3–4. On any concern: `kill_switch` with `confirm=true`.

---

## Threat model (scope)

| In scope | Out of scope |
|----------|--------------|
| Accidental LLM exposure of private keys in tool JSON | Physical compromise of the host filesystem |
| Unbounded agent spends / arbitrary contract calls | Malicious MCP client that already has your master key |
| Accidental mainnet broadcast without confirmation | Social engineering of the human operator |
| Log leakage of secrets via stdout/stdio corruption | Supply-chain attacks on npm dependencies |

The design goal: **even if an agent is poorly prompted**, signing stays gated, keys stay encrypted, and contract calls default to deny.

---

## Agent wallets on by default (research-only opt-out)

- `AGENT_WALLET_ENABLED` defaults to **`true`** (see `src/config.ts`). A master key is required at startup when enabled.
- Write tools (`write: true` in `registerTool`) refuse when you set `AGENT_WALLET_ENABLED=false`.
- Read-only tools such as `agent_wallet_status` still work and report posture without secrets.

Use a machine you control, a strong master key, and a unique wallet directory when signing.

---

## Encryption (AES-256-GCM)

Implementation: `src/wallet/crypto.ts` (Node.js `crypto` only).

| Property | Value |
|----------|--------|
| Algorithm | `aes-256-gcm` |
| IV | 12 random bytes per encryption |
| Key length | 32 bytes |
| Master key forms | **64-char hex** (optional `0x`) → raw AES key (`kdf: raw-hex`); **any other string** → scrypt (`N=16384,r=8,p=1`) with per-blob salt (`kdf: scrypt`) |
| Private-key AAD | New blobs set `aadVersion: 1` and GCM AAD = UTF-8 `` `${walletId}:${address.toLowerCase()}` ``. Legacy blobs omit `aadVersion` and decrypt with no AAD. Load does not rewrite on-disk wallets. |

Encrypted blobs are stored under `AGENT_WALLET_DIR` as JSON wallet records (`encryptedKey` only — never plaintext private keys). File mode aims at `0o600` where the OS supports it.

**If you lose `AGENT_WALLET_MASTER_KEY`, wallet private keys cannot be recovered.**

---

## Keys never reach the LLM

Defenses:

1. Wallet APIs never put plaintext keys on public info objects (`AgentWalletPublicInfo`).
2. `neverReturnPrivateKey` / `stripSecrets` (`src/utils/safety.ts`) redact fields such as `privateKey`, `mnemonic`, `seed`, `encryptedKey`, `ciphertext`, `masterKey`, `agentWalletMasterKey`.
3. Audit log entries (`audit.jsonl`) must not include private keys.
4. MCP resources (`pulsechain://chain/config`) omit master key and wallet file contents.
5. Application logs go to **stderr** only (`LOG_LEVEL`), so stdio MCP transport on stdout is not polluted.

---

## Write tool gates

| Gate | Behavior |
|------|----------|
| `AGENT_WALLET_ENABLED` | Global off switch |
| `confirm=true` | Required for create, policy, transfer, execute, settle, kill, revoke |
| Per-wallet `enabled` | Soft disable of signing |
| Per-wallet `killed` | Hard kill; clear only via `set_agent_policy` with `killed=false` **and** `enabled=true` |

Write tool descriptions include a standard `WRITE_TOOL_WARNING` (see `src/utils/safety.ts` and `src/tools/wallet/index.ts`).

### Design risk: `confirm=true` is only as strong as the host

Wallet write tools accept either:

1. **Legacy/scripts path:** tool argument `confirm=true`, or  
2. **Modern MRTR path:** `InputRequiredResult` elicitation with HMAC-signed `requestState`.

The boolean path is **not** a cryptographic operator signature. If the MCP host (or the agent) can call tools with arbitrary arguments, it can pass `confirm=true` without a human click.

**Operator-trust model (v0.1.38+):** this product is **not** a custody-policy / spend-limit backstop. **Funding the agent is authorization.** Hard spend caps, deny-by-default contract allowlists, and token-notional denies are **not** enforced as safety gates. Real operator controls:

1. Set `AGENT_WALLET_ENABLED=false` for research-only; otherwise protect the master key  
2. Protect `AGENT_WALLET_MASTER_KEY` (keys stay AES-256-GCM encrypted at rest)  
3. Fund only what you accept the agent may spend (value + PulseChain gas)  
4. Optional `kill_switch` / `enabled=false` for emergencies  
5. Unique `AGENT_WALLET_DIR` per process (multiproc)  

**Practical flow:** prefer **inspect → propose → review `reviewSummary` (destination, value vs gas) → execute** as host UX — not as a policy oracle.

### Reading policy decisions and confirmation summaries (v0.1.15+, intelligence v0.1.16)

Safe pattern:

1. Optional **`inspect_tx_intent`** for calldata meaning without a wallet  
2. **`propose_agent_tx`** (or `agent_wallet_check_policy` for a PLS-limit dry-run)  
3. **Read `reviewSummary` + `policyCheck` + `agentGuidance`** before any broadcast  
4. **`execute_agent_tx`** with `confirm=true` or MRTR only after that review  

`propose_agent_tx`, `agent_wallet_check_policy`, `execute_agent_tx`, and `transfer_pls` attach a concise **`reviewSummary`** (source: `src/wallet/reviewSummary.ts`):

| Field | Meaning |
|-------|---------|
| `headline` | One-line ALLOWED/DENIED summary (destination, PLS, token hint) |
| `decision` | `allow` \| `deny` |
| `agentGuidance` | `proceed_with_confirm` \| `review_carefully` \| `refuse` (caution-biased) |
| `decodeKnowledge` | known_priority / unknown / truncated_or_invalid / empty |
| `destination` / `destinationKind` | `to` address; `eoa` or `contract` |
| `nativeValuePls` / `nativeValueWei` | Native **value** only (not gas) |
| `safetyHints` | Includes PulseChain gas reality, value vs gas vs total available, recommended tx order |
| `tokenMovements` / `movementExplanations` | Decoded notional + plain-language lines |
| `tokenNotional` | Pattern, confidence, capsApplied (when calldata inspected) |
| `checksApplied` | Which policy checks were in scope |
| `reasons` / `decisionTrace` | Explicit deny reasons; categories for machines |
| `confirmRationale` / `policyBackstop` | Host-strength confirm vs real controls (+ value/gas reminder) |
| `simulation.gasEstimate` | Gas **units** when sim ran — not PLS cost; convert via fee market |
| `nextStep` | Operator action (execute vs fix deny; fund gas headroom) |

**How to use it:** If `decision` is `deny` or `agentGuidance` is `refuse`, do **not** execute. If `review_carefully`, prefer human review. If `allow` + `proceed_with_confirm`, still verify destination and amounts; then confirm only if the host shows a real human approval path.

**What still depends on the host:** Presenting `reviewSummary` to a human, refusing to auto-pass `confirm=true`, and not rubber-stamping MRTR. The server still re-checks policy before sign; confirm alone is never the main security boundary.

### Write tools

- `create_agent_wallet`
- `set_agent_policy`
- `propose_agent_tx` (simulation + policy preview + `reviewSummary`; no broadcast)
- `execute_agent_tx` / `sign_and_send` (broadcast; confirm prompt includes summary when proposal loads)
- `transfer_pls`
- `kill_switch` / `revoke`

### Non-wallet “prepare” tools (unsigned)

- `prepare_transaction` — builds unsigned tx fields; **never signs**
- `prepare_swap` — builds PulseX swap calldata; **never signs**

These do not require agent wallets. Still treat outputs as untrusted until a human or an operator-trust funded agent wallet executes them.

---

## Operator-trust wallet checks (v0.1.38+)

Source: `src/wallet/policy.ts`.

**This is not a custody-policy product.** If wallets are enabled and funded, ordinary native transfers and contract calls are **not** blocked by allowlists, PLS caps, or token-notional rules.

### Hard blocks at send time (only)

| Control | Effect |
|---------|--------|
| `killed=true` | Kill switch — signing disabled until cleared |
| `enabled=false` | Soft disable — signing disabled |
| Invalid `to` / unparseable value | Technical input error |

### Legacy stored fields (not hard gates)

`maxPlsPerTx`, `maxPlsDaily`, `contractAllowlist`, `tokenAllowlist`, `tokenSpendCaps`, `tokenDailyCaps`, `erc20NotionalCaps`, `requireDecodableCalldata`, and `allowNativeTransfers` may still be stored and shown for compatibility / spend accounting. They are **not** enforced as allow/deny safety backstops in v0.1.38+.

### Token-notional decode (advisory)

Source: `src/wallet/tokenNotional.ts`. Used for `reviewSummary` / `inspect_tx_intent` visibility only — **not** a hard deny path.

| Pattern | Confidence when fully decoded | Token identity | Amount |
|---------|--------------------------------|----------------|--------|
| ERC-20 `transfer` / `transferFrom` / `approve` | high | tx `to` | `amount` |
| WETH9 `deposit()` (WPLS wrap) | high | `native` | msg.value |
| WETH9 `withdraw(uint256)` (WPLS unwrap) | high | tx `to` (WPLS) | `wad` |
| Exact-in: `swapExactTokensForTokens` / `ForETH` | high | `path[0]` | `amountIn` |
| Exact-in: `swapExactETHForTokens` | high | `native` | msg.value |
| Exact-out: `swapTokensForExactTokens` / `ForETH` | high | `path[0]` | **`amountInMax`** (upper bound) |
| Exact-out: `swapETHForExactTokens` | high | `native` | msg.value |
| Fee-supporting exact-in (`*SupportingFeeOnTransferTokens`) | high | `path[0]` / native | `amountIn` / msg.value |
| `addLiquidity` (v0.1.16) | high | `tokenA` / `tokenB` | **`amountADesired` / `amountBDesired`** (pull upper bounds) |
| `addLiquidityETH` (v0.1.16) | high | token + `native` | **`amountTokenDesired` + msg.value** |
| `removeLiquidity` / `removeLiquidityETH` (v0.1.16) | high (pattern) | underlyings noted only | LP share amount **not** applied as ERC-20 notional (pair address not in calldata; underlyings not invented) |
| `multicall(bytes[])` / `multicall(deadline,bytes[])` | high if all risk-relevant inners reliable | per inner + **outer native** | aggregated one level |
| Multicall3 `aggregate` / `tryAggregate` / `aggregate3` | high if all risk-relevant inners reliable | per-call `target` + **outer native** | aggregated one level |

PulseX V1/V2 router destinations and known WPLS are tagged in notes when applicable. Multicall expansion is **one level only** (`tokenNotional.multicallExpanded`, `innerCallCount`, `innerUnreliableCount`).

#### Agent intelligence (v0.1.16)

- **`reviewSummary`** adds `agentGuidance` (`proceed_with_confirm` \| `review_carefully` \| `refuse`), `decodeKnowledge` (known vs unknown vs truncated), `movementExplanations`, and `safetyHints` (includes PulseChain EIP-1559 / BEATS gas reality, value vs gas vs in-wallet total, prefer native then approve/swap).
- **`inspect_tx_intent`** tool: pure local decode (no wallet, no chain I/O) for agents to inspect calldata before propose/execute. Reports residual uncertainty honestly (not full simulation; gas cost in PLS not estimated here).
- Guidance is **caution-biased**: unknown selectors → `review_carefully`; truncated/invalid priority layouts → `refuse`. Do not assume Ethereum-tiny gas.

#### Multicall + outer native value (v0.1.12, C1)

Supported multicall ABIs **do not encode per-inner `msg.value`**. Inners are decoded with `valueWei=0`, so ETH-in / WPLS `deposit` would otherwise report native amount `0`.

**Chosen rule:** when the outer transaction has `valueWei > 0`, token-notional attributes the **full outer native value once** as a single `native` movement (`role: nativeValue`). That amount is included in `erc20NotionalCaps["native"]` sums. Zero-value outer multicalls are unchanged (token inners only).

- **Does not** invent per-inner value splits (would over-count vs `msg.value`).
- **Does not** decode Multicall3 `aggregate3Value` (per-call value) — treat as out of scope / unknown selector.
- If non-zero native somehow appears from inners while outer value &gt; 0 → **fail-closed** (low confidence) to avoid double-count ambiguity.
- Outer native value is still reported on review summaries for operator visibility (not a hard cap).

#### Token decode is advisory only (v0.1.38+)

Decode coverage (ERC-20, WPLS wrap/unwrap, router swaps/liquidity, one-level multicall) remains useful for `inspect_tx_intent` and `reviewSummary` **visibility**. It does **not** hard-deny sends.

**Practical guidance:** fund only what you accept losing; use kill_switch in emergencies; do not rely on allowlists/caps as a security product.

### Spend accounting (wei)

From **v0.1.4**, daily ledgers store `spentWei` (integer string) as the source of truth. Input PLS amounts are parsed via a strict decimal path (`parsePlsToWei`); scientific notation is rejected. Prefer plain decimal strings for fractional PLS when calling tools programmatically.

### Concurrency (single process)

From **v0.1.5**, the per-wallet async mutex covers **all wallet-record mutations** that must not race execute:

| Path | Under `withWalletLock` |
|------|------------------------|
| `execute_agent_tx` / `transfer_pls` | yes |
| `kill_switch` / `revoke` | yes |
| `set_agent_policy` | yes |
| `get_agent_wallet_info` day-roll save | yes |

Within one Node process, concurrent kill or policy updates cannot be undone by execute’s final save: mutations queue on the same lock, and after broadcast execute **re-loads** the wallet and merges **spend only** (never writes back a stale full policy/kill snapshot).

**These locks are process-local only.** They do **not** coordinate two Node processes (two MCP server instances, two Claude Desktop profiles, etc.) that point at the same `AGENT_WALLET_DIR`.

### Multi-process / shared directory (v0.1.6+, strict v0.1.13+, visibility v0.1.14)

**Recommended model: one MCP process → one unique `AGENT_WALLET_DIR`.**

Do **not** share `AGENT_WALLET_DIR` across multiple MCP processes (two Cursor profiles, Grok + Claude, containers, etc.). **Docker:** one container → one unique wallet volume/dir; never share a wallet volume across containers or with a host MCP process writing the same path. Shared directories can cause:

- Double-broadcast of the same proposal (or parallel spends past daily caps)
- Kill/policy races (last writer wins on whole JSON files)
- Confusing audit logs from interleaved writers

**This is not a distributed lock and is not multi-writer-safe by architecture.** Process-local `withWalletLock` never serializes across processes. The ownership marker is a best-effort foot-gun detector (PID liveness via `kill(pid, 0)`; EPERM treated as alive; rare PID-reuse residual remains).

From **v0.1.6**, when agent wallets are enabled the server writes a best-effort ownership marker (`.mcp-wallet-owner.json`) containing `pid`, random `ownerId`, `startedAt`, and optional `hostname`:

| Situation | Default behavior (`AGENT_WALLET_MULTIPROC_STRICT` unset/false) |
|-----------|----------|
| No marker / dead PID | This process claims the directory (reclaim after crash is normal) |
| Marker is this process | Refresh; no multi-process risk (`riskLevel: "none"`) |
| Marker PID still alive (other process) | **Loud stderr warning** (startup + each write attempt) + status `multiProcessRisk=true`, `riskLevel: "warn"`, `multiprocMode: "warn-only"` — **writes still allowed** so clean single-process use is not hard-blocked |

#### Optional fail-closed mode (v0.1.13+)

Set **`AGENT_WALLET_MULTIPROC_STRICT=true`** to refuse wallet **writes** when `multiProcessRisk` is true:

| Env | On conflict with live foreign owner |
|-----|-------------------------------------|
| unset / `false` (default) | Warn only; writes allowed (each write logs multiproc risk) |
| `true` / `1` | **Fail closed** — explicit `PolicyError` on write tools; status `riskLevel: "blocked"`, `writesBlockedByMultiproc=true`, `multiprocMode: "strict-fail-closed"` |

**Write tools gated by multiproc strict** (`requireWritable` — same gate as wallet-enabled writes):

- `create_agent_wallet`, `set_agent_policy`, `propose_agent_tx`
- `execute_agent_tx` / `sign_and_send`
- **`settle_interrupted_broadcast`** (local recovery only; never re-broadcasts; still a wallet write)
- `transfer_pls`, `kill_switch`, `revoke`
- `get_agent_wallet_info` when a day-roll save runs

**Still allowed under conflict:** `agent_wallet_status` and `list_agent_wallets` (diagnostics; enabled-gate only). `inspect_tx_intent` does not touch the wallet dir.

#### Status fields operators should check (v0.1.14)

`agent_wallet_status.walletDirOwnership` surfaces:

| Field | Meaning |
|-------|---------|
| `riskLevel` | `none` \| `warn` \| `blocked` |
| `multiProcessRisk` | Live foreign owner appears to share the dir |
| `writesBlockedByMultiproc` | Strict mode is blocking writes right now |
| `multiprocMode` | `warn-only` or `strict-fail-closed` |
| `foreignOwner` | `{ pid, ownerIdPrefix, startedAt, hostname? }` when risk |
| `recommendedAction` | Operator-actionable next step |
| `recommendedModel` | Always `one process → one unique AGENT_WALLET_DIR` |
| `locksAreProcessLocalOnly` / `notADistributedLock` | Honest architecture limits |
| `posture` | Short multiproc summary |

Also: `security.multiprocRecommendedModel`, `security.multiprocStrictDoesNot` (what strict mode does **not** guarantee).

#### What strict mode does **not** guarantee

- Not a cross-process / distributed lock
- Not multi-writer-safe shared storage
- Not perfect PID liveness (OS residuals)
- Prefer **unique directories** over relying on strict mode alone

**Practical fix for conflict:** stop the other instance **or** point this process at a new empty `AGENT_WALLET_DIR` (and matching master key only if you intentionally share wallets — usually you should not).

### Post-broadcast durability (v0.1.5+, tightened v0.1.6 / v0.1.17)

After `sendTransaction` returns, the shipped order is intentionally tight:

1. **Barrier only (first durable write):** proposal `status=broadcasting` + `txHash` + `broadcastAcceptedAt` via temp+rename with **best-effort fsync**. No spend merge, audit, or wallet reload runs before this write completes.
2. **Best-effort audit** `broadcast_accepted` (txHash recorded for operators; must not block settlement).
3. **Settlement:** re-load wallet → **idempotent** native spend merge keyed by `proposalId` (`appliedSpendProposalIds`) → promote proposal to **`executed`** (fsync’d).
4. Audit `execute_tx` ok.

**Re-broadcast is always fail-closed** once a proposal has a `txHash` or status `broadcasting` / `executed`. `execute_agent_tx` will not send again.

**Interrupted settlement recovery:** if the process dies after the barrier but before `executed`, call **`settle_interrupted_broadcast`** (`confirm=true`). It never re-broadcasts; it finishes local spend (idempotent) and marks `executed`. Requires an existing `txHash` on the proposal.

#### Crash windows (operator guidance)

| Window | On-disk state | Re-execute? | What to do |
|--------|---------------|-------------|------------|
| **A. After chain accept, before barrier** | Proposal may still be `pending` (no `txHash`) | Dangerous — may re-sign/re-broadcast | Check explorer by from-address / nonce. Do **not** blindly re-execute. Residual risk; not eliminable without chain recovery product work. |
| **B. After barrier, before spend / executed** | `broadcasting` + `txHash` | **No** (fail closed) | Verify `txHash` on explorer. Call `settle_interrupted_broadcast` so spend ledger and status catch up. Spend may undercount until settled. |
| **C. After executed** | `executed` + `txHash`, spend applied | **No** | Done. Daily ledger and proposal are durable for this process. |

**Honesty:** this is **not** distributed exactly-once. Multi-process share of `AGENT_WALLET_DIR` remains unsafe. The pre-barrier window (A) cannot be closed without out-of-band chain reconciliation.

### Design limits / residual risks (still apply)

Keep these in mind when enabling wallets. None of these are “silent bugs” — they are intentional architecture limits.

| Limit | What it means in practice |
|-------|---------------------------|
| **Shared `AGENT_WALLET_DIR` is not multi-writer-safe** | Two MCP processes on one dir can double-broadcast, race daily caps, or last-write-wins policy/kill. Locks are **process-local only**. Use **one process → one unique dir**. Default multiproc is **warn-only** (risk is loud, **writes still allowed** — easy to miss). Optional `AGENT_WALLET_MULTIPROC_STRICT=true` refuses writes on live foreign owner — still **not** a distributed lock and still **not** multi-writer-safe if you keep sharing the dir. Status: `operatorAtAGlance`, `walletDirOwnership`, `security.multiprocModeMeanings`. |
| **`confirm=true` is host UX only** | Any host/agent that can call tools with arbitrary args can pass confirm without a human. Confirm is **not** cryptographic operator intent. Operator-trust: funding authorizes — do not treat confirm or legacy caps as a security product. |
| **No hard spend-policy backstop (v0.1.38+)** | Caps/allowlists/token-notional are not hard gates. Fund only what you accept losing; use kill_switch if needed. |
| **Pre-barrier crash window** | After RPC accept, before `broadcasting`+`txHash` barrier, a crash can leave the proposal `pending`. Do **not** blindly re-execute — check the explorer. Not eliminable without chain/nonce recovery product work. |
| **Post-barrier incomplete settlement** | Proposal is non-retryable (`broadcasting`+`txHash`); use **`settle_interrupted_broadcast`** (never re-sends). Spend may undercount until settled. |
| **Token notional is advisory only** | Priority ERC-20 + WPLS + univ2/PulseX swaps/liquidity + one-level multicall for review visibility; not full EVM simulation and not a hard deny path. |
| **No distributed exactly-once** | Barrier + settle improve single-process durability; they do not provide multi-node transactional guarantees. |
| **Unsigned host files** | Wallet JSON and spend ledgers are not HSM-backed or tamper-evident. |

---

## Simulation before broadcast

`propose_agent_tx` and the execute path:

1. Load encrypted wallet (decrypt only in-process for signing).
2. Evaluate operator-trust gates (kill switch / enabled / valid inputs only).
3. Attach **`reviewSummary`** (operator-readable; no secrets).
4. Simulate via `estimateGas` / `eth_call` where applicable (skipped when write is already blocked).
5. Only on `execute_agent_tx` / `sign_and_send` / `transfer_pls` with `confirm=true` or MRTR, re-check kill/enabled, then sign and broadcast.

Failed simulation or kill/disabled blocks send. Prefer reading `reviewSummary` between propose and execute.

---

## Audit log

Path: `{AGENT_WALLET_DIR}/audit.jsonl` (append-only JSON lines).

- Records wallet lifecycle and signing events without private keys.
- Treat the directory as sensitive (addresses, amounts, policy changes).
- Directory is gitignored (`data/wallets/`, `wallets/`).

---

## MRTR secret (multi-process / multi-instance HTTP)

Modern confirm elicitation seals `requestState` with an HMAC key from:

1. **`AGENT_WALLET_MRTR_SECRET`** (≥32 bytes UTF-8) when set — **required for multi-process or multi-instance** deployments that resume confirmations across processes, or  
2. A **process-local random secret** when unset — valid only for single-process round-trips (typical Claude Desktop / Cursor stdio).

Do **not** reuse `AGENT_WALLET_MASTER_KEY` as the MRTR secret. If you set `HTTP_TRANSPORT_PORT` and run more than one server instance (or restart mid-elicitation), set a stable `AGENT_WALLET_MRTR_SECRET` or confirmations will fail integrity checks after restart / on another instance.

---

## Operational checklist

1. **First run:** set `AGENT_WALLET_MASTER_KEY`, or set `AGENT_WALLET_ENABLED=false` for research-only.
2. For a dedicated multiproc-strict process: use **[Agent wallet mode](#agent-wallet-mode-operator-trust)** (`.env.wallet.example`, unique dir, `start-wallet-mcp.mjs`).
3. Generate a strong master key offline (64-char hex preferred, or passphrase ≥16 chars); store in a password manager / OS secret store — **not** in chat history.
4. **Operator-trust:** funding the agent is authorization. Do not treat `MAX_PLS_*` / allowlists as hard safety gates (legacy fields may still appear in config).
5. Fund agent EOAs with **value + PulseChain gas headroom** (**after** create + address verify) — transfers often cost tens of PLS gas; swaps ~250+.
6. Use a **unique `AGENT_WALLET_DIR` per MCP process** — multi-process sharing is warned by default; set `AGENT_WALLET_MULTIPROC_STRICT=true` to refuse writes on live foreign-owner conflict (still not a distributed lock).
7. Prefer **`inspect_tx_intent` → `propose_agent_tx` → read `reviewSummary` / `safetyHints` (value vs gas) → `execute_agent_tx`**.
8. On incident: `kill_switch` immediately (`confirm=true`).
9. Never paste private keys or master keys into the LLM.
10. Set `AGENT_WALLET_MRTR_SECRET` if using multi-process HTTP or long-lived multi-instance confirm flows.
11. Remember: `confirm=true` / MRTR is **host UX only** — this is not a custody-policy product.

---

## Analytics / safety tool caveats

Heuristic tools (`get_token_safety`, `get_honeypots`, `get_scam_alerts`, `check_address_risk`, etc.) use **public** data only. They:

- Are **not** formal audits or honeypot oracles
- Can false-positive and false-negative
- Should never be the sole basis for financial decisions

See the caveats above and first-run / research-only notes in [AGENT_GUIDANCE.md](AGENT_GUIDANCE.md#wallets-on-default--master-key) and [SECURITY.md](SECURITY.md).

---

## Reporting issues

If you find a vulnerability in key handling, policy bypass, or secret leakage in tool responses, treat it as high priority: open a private security report to the repository maintainers rather than a public issue with exploit details.
