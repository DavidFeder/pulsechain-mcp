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
3. piteas_prepare_swap (pass owner for an ERC-20 sell)
4. If allowance.allowanceSufficient is false, propose suggestedApprove first (separate tx, not auto-broadcast)
5. [wallets on] propose_agent_tx with prepared to/data/value AND quoteReview: proposalQuoteReview
6. Read reviewSummary.aggregatorQuote + quoteAgeSec + safetyHints
7. execute_agent_tx — after reading reviewSummary (funding authorizes)
```

`get_token_allowance` reads `allowance(owner, spender)` without approving. For Piteas the spender is the Piteas router. A stale `quoteAgeSec` is a warning, not a send block.

**Stale-quote rule:** quotes expire; re-quote before send if delayed, market moved, prepare failed, or `quoteReady` is false. Never reuse old calldata.

See [AGENT_GUIDANCE.md](AGENT_GUIDANCE.md) for the durable checklist and [SECURITY.md](SECURITY.md) for wallet essentials.

---

## What “prepare” is not

- Not a signed transaction  
- Not a broadcast  
- Not approval of spend  
- Not a guarantee of minOut after delay  

Native PLS sells include human `valuePls` for review; gas is **additional** PLS on PulseChain.
