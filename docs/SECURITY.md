# Security model — pulsechain-mcp

**Setup first:** [BOOTSTRAP.md](BOOTSTRAP.md). Agent workflows: [AGENT_GUIDANCE.md](AGENT_GUIDANCE.md). Token traps: [TOKEN_IDENTITY.md](TOKEN_IDENTITY.md).

This page is the **short essentials** front door only. Residual detail (launcher tables, multiproc matrices, encryption internals, crash windows, reviewSummary fields, token-notional residual) lives in **[SECURITY_DEEP.md](SECURITY_DEEP.md)** — optional, not required for first-run.

---

## Modes

| Mode | Env | Use |
|------|-----|-----|
| **Wallets on (default)** | `AGENT_WALLET_ENABLED=true` + `AGENT_WALLET_MASTER_KEY` | Encrypted EOAs; funding authorizes spend |
| **Research-only** | `AGENT_WALLET_ENABLED=false`, omit master key | Analytics + quotes; no signing |

Wallets are **on by default**. Master key is required when enabled. Generate offline (never commit or paste into chat):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Lose the master key → encrypted wallets are **unrecoverable**.

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

No private keys, master keys, mnemonics, or ciphertext in tool args, logs, or operator paste.

## Prefer when signing

Dedicated launcher: `scripts/start-wallet-mcp.mjs` + gitignored `.env.wallet` (see [SECURITY_DEEP.md](SECURITY_DEEP.md)). Stdio clients: absolute path to `dist/index.js`; **do not** set `HTTP_TRANSPORT_PORT`.

## Gas (one line)

PulseChain gas often costs **tens–hundreds of PLS** even for small value transfers. Fund **value + gas headroom**, not Ethereum-dust amounts.

## Operational checklist

1. Bootstrap smoke passes ([BOOTSTRAP.md](BOOTSTRAP.md)).
2. Master key set **or** research-only disable.
3. Unique wallet dir; multiproc strict recommended for dedicated wallet process.
4. Fund only what you accept the agent may spend.
5. On incident: `kill_switch`.

Heuristic analytics tools are directional, not formal audits.

---

**Optional deep residual:** [SECURITY_DEEP.md](SECURITY_DEEP.md) (not required for first-run).
