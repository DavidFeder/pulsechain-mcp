# pulsechain-mcp

An MCP server that lets AI agents work with **PulseChain** and encrypted agent wallets.

You can give your AI agent its own PLS and other tokens in a local wallet it controls.

Sending PLS and swaps on PulseX/Piteas have been successful.

**Version `1.0.0`** · MCP TypeScript SDK **2.0.0** (stable) · dual-era `2026-07-28` + `2025-11-25`

## Features

- PulseChain data and market research
- Smart contract reviews and creation
- Swap quotes/prices and executions
- Encrypted agent wallets — send PLS and other tokens to a wallet your agent can control

## Security

- AI Agent starts with zero PLS and is in "Research Only Mode" until you fund it's wallet. Sending PLS to your agent is optional, if you do be smart and start small.
- Kill switch command can disable the wallet
- Encrypted keys at rest (AES-256-GCM)
- Unique wallet directory per process
- Don't give your agent more coins than you are willing to lose, agents make mistakes just like humans

## Setup (humans)

1. Install **Node.js 20+** if needed or have your agent do it.
2. Clone this repo and open it in your AI app (Cursor, Claude, Grok, Codex, …) or have your agent do it.
3. **Ask your AI agent to finish setup** — paths, master key or research-only mode, reload, and smoke checks.

You do not need to learn MCP, RPC, or wallet cryptography. The agent does it for you.

Optional one-liner if the agent has not cloned yet:

```bash
git clone https://github.com/DavidFeder/pulsechain-mcp.git && cd pulsechain-mcp && npm install && npm run build
```

## If you are an AI agent

**Start here → [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md)**  
(ordered checklist: build → client example → paths → wallets → reload → smoke → next docs)

## License

MIT
