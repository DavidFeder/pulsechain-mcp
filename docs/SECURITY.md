# Security model — pulsechain-mcp

**Setup first:** [BOOTSTRAP.md](BOOTSTRAP.md). Agent workflows: [AGENT_GUIDANCE.md](AGENT_GUIDANCE.md). Token traps: [TOKEN_IDENTITY.md](TOKEN_IDENTITY.md).

This page is the **short essentials** front door only. Residual detail (launcher tables, multiproc matrices, encryption internals, crash windows, reviewSummary fields, token-notional residual) lives in **[SECURITY_DEEP.md](SECURITY_DEEP.md)** — optional, not required for first-run.

---

## Modes (install vs product)

| Mode | Env / entry | Use |
|------|-------------|-----|
| **Research-only (agent install default)** | `dist/index.js` + `AGENT_WALLET_ENABLED=false`, omit master key | Analytics + quotes; no signing |
| **Wallets on (when user asks to sign)** | `scripts/start-wallet-mcp.mjs` + gitignored `.env.wallet` | Encrypted EOAs; funding authorizes spend |

When wallets are **enabled** in the process, a master key is required to start. Agent first-install should still choose **research-only** unless the user asked for signing.

**Write-only key path** (never print the key; never commit):

```bash
node scripts/generate-wallet-env.mjs
```

Prefer that over `console.log` of a raw key into host env. Lose the master key → encrypted wallets are **unrecoverable**.

## Operator-trust (when wallets on)

- **Funding the agent is authorization.**
- Private keys stay **AES-256-GCM** encrypted at rest; tools never return them.
- No product spend-cap defaults. `MAX_PLS_*` / allowlists / token-notional are **display / advisory** if present — not hard custody locks. Real controls: **small balances**, **master key**, **unique dir**, **kill_switch**.
- `confirm=true` / MRTR is **host UX only** — not a cryptographic security product.
- Prefer: create wallet → verify address → fund (value + PulseChain gas) → inspect → propose → review → execute.

## Kill switch

If something looks wrong: call **`kill_switch`** / `revoke` with `confirm=true` (or MRTR). Signing stops until carefully recovered.

## Multiproc (one line)

**One MCP process → one unique `AGENT_WALLET_DIR`.** Do not share the dir across hosts. Optional `AGENT_WALLET_MULTIPROC_STRICT=true` refuses writes on live foreign-owner conflict (still not a distributed lock).

## Keys never in chat

No private keys, master keys, mnemonics, or ciphertext in tool args, logs, or operator paste. Do not `read_file` `.env.wallet` to “verify.”

## Prefer when signing

Dedicated launcher: `scripts/start-wallet-mcp.mjs` + gitignored `.env.wallet` (see [SECURITY_DEEP.md](SECURITY_DEEP.md)). Host config must **not** embed `AGENT_WALLET_MASTER_KEY`. Stdio clients: absolute path to launcher or `dist/index.js`; **do not** set `HTTP_TRANSPORT_PORT`.

## Permissions (don’t-read-secrets)

| Path | Mode (Unix) | Agent may |
|------|-------------|-----------|
| `.env.wallet` | 600 | existence / mode check, not contents |
| `data/wallets/` | 700 | status tools / counts, not key material |

Windows: POSIX modes are best-effort; use NTFS ACLs or keep secrets off shared folders.

## Gas (one line)

PulseChain gas often costs **tens–hundreds of PLS** even for small value transfers. Fund **value + gas headroom**, not Ethereum-dust amounts.

## Operational checklist

1. Bootstrap smoke passes ([BOOTSTRAP.md](BOOTSTRAP.md)) — research-only first unless signing was requested.
2. Master key only in `.env.wallet` **or** research-only disable.
3. Unique wallet dir; multiproc strict recommended for dedicated wallet process.
4. Fund only what you accept the agent may spend (never during bootstrap).
5. On incident: `kill_switch`.

Heuristic analytics tools are directional, not formal audits.

---

**Optional deep residual:** [SECURITY_DEEP.md](SECURITY_DEEP.md) (not required for first-run).
