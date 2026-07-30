# Documentation map — pulsechain-mcp

## Human vs agent setup model

| Who | What they do |
|-----|----------------|
| **Human** | Clone (or open the repo), paste an [`examples/`](../examples/) config, **ask the agent to finish** |
| **Agent** | Own install, paths, master key / research-only, reload, smoke checks, and day-to-day operation |

Root [README](../README.md) is the human front door only.

---

## Agents: start here

### → [BOOTSTRAP.md](BOOTSTRAP.md) ← single checklist (no guesswork)

1. Clone/build  
2. Choose client example  
3. Absolute paths  
4. Wallets-on master key **or** research-only  
5. Reload host  
6. Smoke checks  
7. Where next  

Do **not** treat other docs as a competing install path until bootstrap smoke passes.

---

## After bootstrap

| Doc | When |
|-----|------|
| [AGENT_GUIDANCE.md](AGENT_GUIDANCE.md) | Research/swap workflows, hard rules, kill switch, trust/noise |
| [TOKEN_IDENTITY.md](TOKEN_IDENTITY.md) | e*/p*, pHEX exception, ticker traps |
| [AGGREGATORS.md](AGGREGATORS.md) | Piteas / Switch quote → prepare |
| [SECURITY.md](SECURITY.md) | Short essentials (first-run) |
| [SECURITY_DEEP.md](SECURITY_DEEP.md) | Optional residual detail — not required for bootstrap |
| [OPERATOR.md](OPERATOR.md) | Env table, multi-RPC, Docker |
| [../examples/README.md](../examples/README.md) | Client samples (Cursor / Claude / Grok / Codex) |

Also not onboarding: [../CHANGELOG.md](../CHANGELOG.md), [../MIGRATION_NOTES.md](../MIGRATION_NOTES.md), [../RELEASE_NOTES.md](../RELEASE_NOTES.md).

**Never commit:** filled `.env` / `.env.wallet` (or any local wallet env), wallet data dirs, keys, live addresses, balances, or private reports.
