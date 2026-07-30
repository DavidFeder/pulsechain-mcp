# Aggregators — Piteas, Switch, and swap assist

Quote and prepare tools are **advisory assists**. They do **not** broadcast. Execution stays on the wallet path under operator-trust.

---

## Which tool when

| Tool | Key | Role |
|------|-----|------|
| **`piteas_quote`** | None (keyless) | **Default** aggregator quote assist |
| **`piteas_prepare_swap`** | None | Quote → reviewable intent (`to` / `data` / `value`) |
| **`switch_quote`** | Operator `SWITCH_API_KEY` | Switch.win quote; public unauthenticated → 401 |
| **`switch_prepare_swap`** | Needs successful keyed quote | Intent from **upstream `tx.to` / `tx.data` / `tx.value` only** |
| `pulseswap_quote` | None | Multi-DEX advisory |
| `pulsex_quote` / `prepare_swap` | None | PulseX router path only |

Neither Piteas nor Switch is a **best-price oracle**. Prefer addresses over symbols for tokenIn/tokenOut.

### Switch keys (operator-gated)

1. Human operator requests access: https://docs.switch.win/aggregator/request-api-key  
2. Set `SWITCH_API_KEY` in **local env only** (never commit).  
3. **Agents cannot self-serve keys** inside this MCP.  
4. Until keyed, prefer **`piteas_quote`**.

---

## End-to-end swap path

```text
1. piteas_quote (or switch_quote if operator key present)
2. Confirm quoteReady / amounts look sane
3. piteas_prepare_swap (or switch_prepare_swap)
4. [wallets on] propose_agent_tx with prepared to/data/value
5. Read reviewSummary + safetyHints + agentGuidance
6. execute_agent_tx with confirm=true (or MRTR) — only after review
```

**Stale-quote rule:** quotes expire; re-quote before send if delayed, market moved, prepare failed, or `quoteReady` is false. Never reuse old calldata.

See [AGENT_GUIDANCE.md](AGENT_GUIDANCE.md) for the durable checklist and [SECURITY.md](SECURITY.md) for wallet essentials.

---

## What “prepare” is not

- Not a signed transaction  
- Not a broadcast  
- Not approval of spend  
- Not a guarantee of minOut after delay  

Native PLS sells include human `valuePls` for review; gas is **additional** PLS on PulseChain.
