/**
 * PulseChain network constants and well-known public contract addresses.
 *
 * Sources (public, no openpulsechain dependency):
 * - Network: https://pulsechain.com (chain id 369, RPC, native PLS)
 * - Explorer API: https://api.scan.pulsechain.com/api (BlockScout)
 * - Tokens verified via PulseX V2 subgraph + scan.pulsechain.com
 * - PulseX factories/routers verified on-chain (factory() eth_call + getPair)
 * - Subgraphs: https://graph.pulsechain.com/subgraphs/name/pulsechain/{pulsex,pulsexv2}
 */

/** PulseChain mainnet chain id */
export const PULSECHAIN_CHAIN_ID = 369 as const;

/** Native gas token */
export const PULSECHAIN_NATIVE_SYMBOL = "PLS" as const;
export const PULSECHAIN_NATIVE_DECIMALS = 18 as const;

/**
 * Default ordered mainnet RPC list (priority: community g4mm4 → official →
 * publicnode → PulseChainStats public fallback).
 * Users should prepend local (`http://127.0.0.1:8545`) or LAN nodes via
 * `PULSECHAIN_RPC_URLS` / `PULSECHAIN_RPC_URL` — we do not put loopback in the
 * default list (unreachable locals would only add latency on every cold start).
 *
 * g4mm4.io: https://rpc-pulsechain.g4mm4.io
 * Official: https://rpc.pulsechain.com
 * PublicNode: https://pulsechain.publicnode.com
 * PulseChainStats: https://rpc.pulsechainstats.com (additional public fallback)
 */
export const DEFAULT_RPC_URLS = [
  "https://rpc-pulsechain.g4mm4.io",
  "https://rpc.pulsechain.com",
  "https://pulsechain.publicnode.com",
  "https://rpc.pulsechainstats.com",
] as const;

/** @deprecated Prefer DEFAULT_RPC_URLS[0] / first of active list; kept for BC */
export const DEFAULT_RPC_URL = DEFAULT_RPC_URLS[0];

/** PulseChain testnet (v4) chain id */
export const PULSECHAIN_TESTNET_CHAIN_ID = 943 as const;

/**
 * Default testnet RPC endpoints (chain id 943). Optional; not used unless
 * PULSECHAIN_NETWORK=testnet or PULSECHAIN_TESTNET_RPC_URLS is set.
 */
export const DEFAULT_TESTNET_RPC_URLS = [
  "https://rpc-testnet-pulsechain.g4mm4.io",
  "https://rpc.v4.testnet.pulsechain.com",
] as const;

/**
 * Optional later: Beacon API bases (not used by this server yet).
 * - https://rpc-pulsechain.g4mm4.io/beacon-api/
 * - https://rpc-testnet-pulsechain.g4mm4.io/beacon-api/
 */
export const G4MM4_BEACON_API_MAINNET =
  "https://rpc-pulsechain.g4mm4.io/beacon-api/" as const;
export const G4MM4_BEACON_API_TESTNET =
  "https://rpc-testnet-pulsechain.g4mm4.io/beacon-api/" as const;

/** Temporary cooldown after a failed RPC (ms) before retrying that URL */
export const RPC_UNHEALTHY_COOLDOWN_MS = 30_000;

/**
 * BlockScout-compatible explorer REST base.
 * Docs: https://api.scan.pulsechain.com/api-docs
 * UI: https://scan.pulsechain.com
 */
export const DEFAULT_EXPLORER_API = "https://api.scan.pulsechain.com/api";
export const DEFAULT_EXPLORER_UI = "https://scan.pulsechain.com";

/**
 * Official PulseChain testnet v4 BlockScout (chain 943).
 * UI: https://scan.v4.testnet.pulsechain.com
 */
export const DEFAULT_TESTNET_EXPLORER_API =
  "https://api.scan.v4.testnet.pulsechain.com/api";
export const DEFAULT_TESTNET_EXPLORER_UI =
  "https://scan.v4.testnet.pulsechain.com";

/**
 * Official public PulseX subgraph endpoints (The Graph on PulseChain).
 * V1 = INC farm / buy-and-burn fee model; V2 = standard LP fee DEX.
 */
export const DEFAULT_PULSEX_SUBGRAPH_V1 =
  "https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex";
export const DEFAULT_PULSEX_SUBGRAPH_V2 =
  "https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsexv2";

/**
 * Official PulseX subgraphs on PulseChain testnet v4 (same path names as mainnet).
 * Verified live: `_meta.block` responds on both hosts.
 */
export const DEFAULT_TESTNET_PULSEX_SUBGRAPH_V1 =
  "https://graph.v4.testnet.pulsechain.com/subgraphs/name/pulsechain/pulsex";
export const DEFAULT_TESTNET_PULSEX_SUBGRAPH_V2 =
  "https://graph.v4.testnet.pulsechain.com/subgraphs/name/pulsechain/pulsexv2";

export const DEFAULT_LOG_LEVEL = "info" as const;

export const SERVER_NAME = "pulsechain-mcp";
export const SERVER_VERSION = "1.0.7";

/**
 * Achieved wire protocol mode for dual-era serving:
 * - modern: 2026-07-28 via `server/discover` + per-request `_meta` (stateless HTTP; connection-pinned stdio)
 * - legacy: 2025-11-25 via `initialize` (serveStdio default + createMcpHandler `legacy: 'stateless'`)
 *
 * No application reliance on Mcp-Session-Id for protocol identity.
 */
export const PROTOCOL_MODE = "dual:2026-07-28+2025-11-25" as const;

/** Request timeout for HTTP data clients (ms) */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * Multicall3 — same CREATE2 address as most EVM chains (including PulseChain).
 * https://github.com/mds1/multicall
 */
export const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

// ---------------------------------------------------------------------------
// Core tokens (PulseChain mainnet)
// Addresses lowercased in maps for lookup; checksummed forms used in exports.
// ---------------------------------------------------------------------------

/** Wrapped PLS (WPLS) — scan.pulsechain.com token page */
export const WPLS_ADDRESS =
  "0xA1077a294dDE1B09bB078844df40758a5D0f9a27" as const;

/**
 * HEX / pHEX — Ethereum HEX address preserved at PulseChain state fork.
 * Community often calls this **pHEX** (PulseChain-side). Same address as
 * Ethereum HEX (`0x2b59…`). Distinct from bridged eHEX.
 */
export const HEX_ADDRESS =
  "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39" as const;

/** Alias: pHEX is the state-fork HEX at HEX_ADDRESS. */
export const PHEX_ADDRESS = HEX_ADDRESS;

/**
 * eHEX — HEX bridged from Ethereum via bridge.pulsechain.com.
 * On-chain name often "HEX from Ethereum". Verified via PulseX / DexScreener
 * (scan.pulsechain.com token page + major eHEX/WPLS pools).
 */
export const EHEX_ADDRESS =
  "0x57fde0a71132198BBeC939B98976993d8D89D225" as const;

/** Alias for EHEX_ADDRESS (bridged HEX). */
export const BRIDGED_HEX_ADDRESS = EHEX_ADDRESS;

/** PulseX (PLSX) — pulsex.com */
export const PLSX_ADDRESS =
  "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab" as const;

/** Incentive (INC) — PulseX farm reward token */
export const INC_ADDRESS =
  "0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d" as const;

/**
 * How a known token exists on PulseChain.
 * - bridged: moved via bridge.pulsechain.com (real economic asset from ETH)
 * - state_fork: copied from Ethereum state at PulseChain launch (same address as ETH)
 * - pulsechain: native or PulseChain-origin token
 */
export type TokenOrigin = "bridged" | "state_fork" | "pulsechain";

/**
 * Bridged DAI — real ~$1 stable on PulseChain.
 * Brought over via bridge.pulsechain.com. Name on-chain often
 * "Dai Stablecoin from Ethereum". Canonical "DAI" for tools/defaults.
 * Verified via PulseX V2 subgraph major pools.
 */
export const BRIDGED_DAI_ADDRESS =
  "0xefD766cCb38EaF1dfd701853BFCe31359239F305" as const;

/**
 * @deprecated Prefer BRIDGED_DAI_ADDRESS for clarity; kept as the single
 * implied "DAI" address for backward-compatible callers.
 */
export const DAI_ADDRESS = BRIDGED_DAI_ADDRESS;

/**
 * Forked DAI (often called pDAI) — Ethereum DAI address preserved at state fork.
 * Same address as Ethereum DAI (`0x6B17…`), but on PulseChain it is **not** the
 * dollar-pegged bridged stable. Treat as a separate meme/fork asset.
 * Do **not** resolve symbol "DAI" to this address.
 */
export const FORK_DAI_ADDRESS =
  "0x6B175474E89094C44Da98b954EedeAC495271d0F" as const;

/** Alias for FORK_DAI_ADDRESS (community name pDAI). */
export const PDAI_ADDRESS = FORK_DAI_ADDRESS;

/**
 * eUSDC — USDC bridged from Ethereum via bridge.pulsechain.com.
 * Community **e*** prefix = bridged (legitimate). Canonical for symbol "USDC".
 */
export const USDC_FROM_ETH_ADDRESS =
  "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07" as const;

/** Alias: eUSDC is the bridged USDC at USDC_FROM_ETH_ADDRESS. */
export const EUSDC_ADDRESS = USDC_FROM_ETH_ADDRESS;

/**
 * eUSDT — USDT bridged from Ethereum — real Tether stable on PulseChain.
 * Community **e*** prefix = bridged (legitimate). Canonical for symbol "USDT".
 */
export const USDT_FROM_ETH_ADDRESS =
  "0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f" as const;

/** Alias: eUSDT is the bridged USDT at USDT_FROM_ETH_ADDRESS. */
export const EUSDT_ADDRESS = USDT_FROM_ETH_ADDRESS;

/**
 * Forked USDT — Ethereum USDT address preserved at state fork.
 * Same address as ETH USDT (`0xdAC1…`); **not** the bridged Tether stable.
 * Do **not** resolve symbol "USDT" to this address.
 */
export const FORK_USDT_ADDRESS =
  "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;

/**
 * Bridged WETH — "Wrapped Ether from Ethereum" via bridge.pulsechain.com.
 * Verified on PulseX / DexScreener major pools.
 */
export const BRIDGED_WETH_ADDRESS =
  "0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C" as const;

/**
 * Forked WETH — Ethereum WETH address preserved at state fork (`0xC02a…`).
 * **Not** the bridged WETH. Do **not** resolve symbol "WETH" to this address.
 */
export const FORK_WETH_ADDRESS =
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;

/**
 * eWBTC — WBTC bridged from Ethereum via bridge.pulsechain.com.
 * Community **e*** prefix = bridged (legitimate). Canonical for symbol "WBTC".
 */
export const EWBTC_ADDRESS =
  "0xb17D901469B9208B17d916112988A3FeD19b5cA1" as const;

/** Alias: bridged WBTC. */
export const BRIDGED_WBTC_ADDRESS = EWBTC_ADDRESS;

/**
 * pWBTC — Ethereum WBTC address preserved at PulseChain state fork (`0x2260…`).
 * Community **p*** prefix = state-fork copy (typically useless / not the liquid
 * bridged asset). Do **not** resolve symbol "WBTC" to this address.
 */
export const PWBTC_ADDRESS =
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as const;

/** Alias for PWBTC_ADDRESS (bad fork). */
export const FORK_WBTC_ADDRESS = PWBTC_ADDRESS;

// ---------------------------------------------------------------------------
// Known major pairs (catalog guidance only — never invent as live DexScreener rows)
// ---------------------------------------------------------------------------

/**
 * Major eUSDC / bridged-DAI PulseX pool — address follow-up for dexscreener_pair.
 * Re-verified live 2026-07-27: prior pointer 0x8C357BE2…976b was pHEX/WPLS (wrong).
 * Current: highest-liquidity clear eUSDC side at ~$199k (PulseX v1 eUSDC/DAI).
 */
export const EUSDC_MAJOR_PAIR_ADDRESS =
  "0x3225E3B0D3C6b97EC9848f7B40bb3030E5497709" as const;

/** Major eUSDT pool — address follow-up for dexscreener_pair. */
export const EUSDT_MAJOR_PAIR_ADDRESS =
  "0x322Df7921F28F1146Cdf62aFdaC0D6bC0Ab80711" as const;

/** Major eHEX pool — address follow-up for dexscreener_pair. */
export const EHEX_MAJOR_PAIR_ADDRESS =
  "0xF0eA3efE42C11c8819948Ec2D3179F4084863D3F" as const;

export interface TokenInfo {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  /** Public source note */
  source: string;
  /** How this token exists on PulseChain */
  origin?: TokenOrigin;
  /**
   * Optional alias for display (e.g. pDAI). Symbol resolution for "DAI"
   * still means bridged only — aliases are for explicit PDAI / FORK_DAI keys.
   */
  displaySymbol?: string;
  /** True only when this is a real dollar-oriented bridged stable we document as such */
  isRealStablecoin?: boolean;
  /** Short identity line for tool outputs */
  identityNote?: string;
  /** Warning agents/operators must see when this address appears */
  warning?: string;
}

/** Canonical agent-facing warnings (stable copy for tests/docs). */
export const BRIDGED_DAI_WARNING =
  "bridged DAI; real stablecoin (~$1). Bridge path: https://bridge.pulsechain.com — never confuse with forked pDAI at 0x6B17…";

export const FORK_DAI_WARNING =
  "forked from Ethereum state (pDAI); NOT the bridged stable — do not treat as $1 DAI. Real stable is bridged DAI at 0xefD7… via bridge.pulsechain.com";

export const BRIDGED_DAI_IDENTITY =
  "Bridged DAI (from Ethereum via bridge.pulsechain.com) — real stablecoin";

export const FORK_DAI_IDENTITY =
  "Forked DAI / pDAI (Ethereum state copy at PulseChain launch) — not dollar-stable";

export const PHEX_WARNING =
  "pHEX / HEX state-fork (0x2b59…); popular on PulseChain. Distinct from bridged eHEX at 0x57fd… — never treat as the same asset";

export const EHEX_WARNING =
  "eHEX bridged from Ethereum via bridge.pulsechain.com (0x57fd…). Distinct from pHEX/HEX state-fork at 0x2b59…";

export const PHEX_IDENTITY =
  "HEX / pHEX (Ethereum state fork at PulseChain launch) — PulseChain-side HEX; not bridged eHEX";

export const EHEX_IDENTITY =
  "eHEX — HEX bridged from Ethereum via bridge.pulsechain.com";

export const BRIDGED_USDC_WARNING =
  "eUSDC / bridged USDC via bridge.pulsechain.com (0x15D3…) — legitimate bridged stable. e* = bridged from Ethereum. Always verify address (ticker spoof risk)";

export const BRIDGED_USDT_WARNING =
  "eUSDT / bridged USDT (real Tether stable via bridge.pulsechain.com, 0x0Cb6…). e* = bridged. Forked USDT at 0xdAC1… is a separate state-fork asset — verify address";

export const FORK_USDT_WARNING =
  "forked USDT (Ethereum state copy at 0xdAC1…); NOT the bridged Tether stable (eUSDT). Real bridged USDT is 0x0Cb6… via bridge.pulsechain.com";

export const BRIDGED_WETH_WARNING =
  "bridged WETH from Ethereum via bridge.pulsechain.com. Forked WETH at 0xC02a… is a separate state-fork asset — verify address";

export const FORK_WETH_WARNING =
  "forked WETH (Ethereum state copy at 0xC02a…); NOT the bridged WETH. Bridged WETH is 0x02Dc… via bridge.pulsechain.com";

export const EWBTC_WARNING =
  "eWBTC / bridged WBTC via bridge.pulsechain.com (0xb17D…) — legitimate bridged BTC exposure. e* = bridged. Distinct from pWBTC fork at 0x2260…";

export const PWBTC_WARNING =
  "pWBTC / state-fork WBTC at Ethereum address 0x2260… — typically useless fork copy (p* = state fork). Prefer eWBTC 0xb17D… via bridge.pulsechain.com";

export const EWBTC_IDENTITY =
  "eWBTC — WBTC bridged from Ethereum via bridge.pulsechain.com (not the state-fork pWBTC)";

export const PWBTC_IDENTITY =
  "pWBTC — Ethereum WBTC state-fork copy at PulseChain launch; not preferred; prefer eWBTC";

export const BRIDGED_USDC_IDENTITY =
  "eUSDC — USDC bridged from Ethereum via bridge.pulsechain.com — real stablecoin (PRC-20)";

export const BRIDGED_USDT_IDENTITY =
  "eUSDT — USDT bridged from Ethereum via bridge.pulsechain.com — real Tether stable (PRC-20)";

/**
 * Community e-star / p-star naming rule for agents (high-value catalog only).
 * - e-prefix = bridged from Ethereum = legitimate
 * - p-prefix = PulseChain state-fork copy = typically useless
 * - Exception: pHEX is the preferred HEX on PulseChain (state-fork but preferred)
 * - Address identity always beats ticker; symbol search is discovery-only
 */
export const EP_NAMING_RULES = [
  "Prefix e* = bridged from Ethereum = legitimate (eHEX, eUSDC, eUSDT, eWBTC, …).",
  "Prefix p* = PulseChain state-fork copy from the fork = typically useless (pDAI, pWBTC, …).",
  "Exception: pHEX 0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39 is the preferred HEX on PulseChain (state-fork but preferred, not 'typically useless').",
  "Address identity always beats ticker — never invent token_origin for unknown addresses.",
  "Symbol search is discovery-only; use address tools for identity-sensitive work.",
] as const;

/**
 * Concise RO research preference card for agents (resource + docs).
 * Controllable MCP guidance only — does not invent market data.
 */
export const RO_RESEARCH_GUIDANCE = {
  title: "PulseChain MCP read-only research guidance",
  version_note:
    "Ship with SERVER_VERSION; research-only by default (AGENT_WALLET_ENABLED unset/false); set AGENT_WALLET_ENABLED=true and a master key to sign",
  principles: [
    "Address identity always beats ticker — verify the 0x before acting on a symbol.",
    ...EP_NAMING_RULES,
    "Prefer display_symbol / token_origin over raw on-chain symbol when present.",
    "Never invent token_origin or DexScreener pair rows for unknown addresses.",
  ],
  toolPreference: {
    identity:
      "get_token_info, get_token_balance, get_portfolio, dexscreener_token_pairs, dexscreener_tokens, dexscreener_pair — always with a verified 0x address",
    discovery:
      "dexscreener_search is discovery-only. Honor catalog_coverage and recommended_address_followups (including when pairs[] is empty). Do not trust ticker alone.",
    price:
      "get_token_price (PulseX derivedUSD by address) or DexScreener by token/pair address. token0_price/token1_price on pair rows are NOT USD.",
    quote:
      "piteas_quote = preferred keyless aggregator assist (default). " +
      "switch_quote = Switch.win assist — operator-gated SWITCH_API_KEY " +
      "(request: https://docs.switch.win/aggregator/request-api-key; agents cannot self-serve keys). " +
      "Neither is a best-price oracle. prepare_* → propose/execute. " +
      "pulseswap_quote = multi-DEX advisory; pulsex_quote = PulseX router getAmountsOut only. None execute swaps.",
    ranking:
      "get_top_tokens / get_top_pairs include origin labels + liquidity demotion. Raw pulsex_top_* also label catalogued sides but skip free-tier demotion.",
  },
  knownMajorPairsNote:
    "Curated major pairs are address follow-ups for dexscreener_pair only — re-verified live; never invented as search rows. Top subgraph pool by reserve may differ from the curated major.",
  resourceUri: "pulsechain://guidance/ro-research",
} as const;

/**
 * Core token registry for tools/resources.
 * Symbol **DAI** always means **bridged** DAI only. Forked pDAI is not a
 * default core portfolio symbol (it is labeled via KNOWN_TOKENS_BY_ADDRESS).
 * Symbol **HEX** means state-fork pHEX; **EHEX** is bridged HEX.
 * Symbol **USDT** / **WETH** mean bridged assets only.
 */
export const CORE_TOKENS: Record<string, TokenInfo> = {
  WPLS: {
    symbol: "WPLS",
    name: "Wrapped Pulse",
    address: WPLS_ADDRESS,
    decimals: 18,
    source: "scan.pulsechain.com / PulseX subgraph",
    origin: "pulsechain",
  },
  HEX: {
    symbol: "HEX",
    displaySymbol: "pHEX",
    name: "HEX (PulseChain state fork / pHEX)",
    address: HEX_ADDRESS,
    decimals: 8,
    source: "scan.pulsechain.com / CoinGecko HEX (PulseChain)",
    origin: "state_fork",
    identityNote: PHEX_IDENTITY,
    warning: PHEX_WARNING,
  },
  PLSX: {
    symbol: "PLSX",
    name: "PulseX",
    address: PLSX_ADDRESS,
    decimals: 18,
    source: "pulsex.com",
    origin: "pulsechain",
  },
  INC: {
    symbol: "INC",
    name: "Incentive",
    address: INC_ADDRESS,
    decimals: 18,
    source: "PulseX subgraph + scan.pulsechain.com",
    origin: "pulsechain",
  },
  DAI: {
    symbol: "DAI",
    name: "Dai Stablecoin from Ethereum",
    address: BRIDGED_DAI_ADDRESS,
    decimals: 18,
    source: "PulseX subgraph (bridged from Ethereum)",
    origin: "bridged",
    displaySymbol: "DAI",
    isRealStablecoin: true,
    identityNote: BRIDGED_DAI_IDENTITY,
    warning: BRIDGED_DAI_WARNING,
  },
  USDC: {
    symbol: "USDC",
    displaySymbol: "eUSDC",
    name: "USD Coin from Ethereum (bridged / eUSDC)",
    address: USDC_FROM_ETH_ADDRESS,
    decimals: 6,
    source: "PulseX subgraph (bridged from Ethereum)",
    origin: "bridged",
    isRealStablecoin: true,
    identityNote: BRIDGED_USDC_IDENTITY,
    warning: BRIDGED_USDC_WARNING,
  },
  USDT: {
    symbol: "USDT",
    displaySymbol: "eUSDT",
    name: "Tether USD from Ethereum (bridged / eUSDT)",
    address: USDT_FROM_ETH_ADDRESS,
    decimals: 6,
    source: "PulseX subgraph (bridged from Ethereum)",
    origin: "bridged",
    isRealStablecoin: true,
    identityNote: BRIDGED_USDT_IDENTITY,
    warning: BRIDGED_USDT_WARNING,
  },
  WETH: {
    symbol: "WETH",
    name: "Wrapped Ether from Ethereum",
    address: BRIDGED_WETH_ADDRESS,
    decimals: 18,
    source: "PulseX / DexScreener (bridged from Ethereum)",
    origin: "bridged",
    displaySymbol: "WETH",
    identityNote:
      "Bridged WETH from Ethereum via bridge.pulsechain.com — not forked WETH",
    warning: BRIDGED_WETH_WARNING,
  },
  WBTC: {
    symbol: "WBTC",
    displaySymbol: "eWBTC",
    name: "Wrapped BTC from Ethereum (bridged / eWBTC)",
    address: EWBTC_ADDRESS,
    decimals: 8,
    source: "bridge.pulsechain.com / PulseX eWBTC pools",
    origin: "bridged",
    isRealStablecoin: false,
    identityNote: EWBTC_IDENTITY,
    warning: EWBTC_WARNING,
  },
};

/**
 * Explicit forked-DAI registry entry (not in CORE_TOKENS defaults).
 * Resolve via symbols PDAI / FORK_DAI / FORKED_DAI only — never plain "DAI".
 */
export const FORK_DAI_TOKEN: TokenInfo = {
  symbol: "DAI",
  displaySymbol: "pDAI",
  name: "Dai Stablecoin (PulseChain state fork / pDAI)",
  address: FORK_DAI_ADDRESS,
  decimals: 18,
  source: "Ethereum state fork at PulseChain launch (same address as ETH DAI)",
  origin: "state_fork",
  isRealStablecoin: false,
  identityNote: FORK_DAI_IDENTITY,
  warning: FORK_DAI_WARNING,
};

/** Bridged eHEX — not a default core portfolio key; resolve via EHEX / BRIDGED_HEX. */
export const EHEX_TOKEN: TokenInfo = {
  symbol: "eHEX",
  displaySymbol: "eHEX",
  name: "HEX from Ethereum (bridged)",
  address: EHEX_ADDRESS,
  decimals: 8,
  source: "bridge.pulsechain.com / PulseX eHEX pools / DexScreener",
  origin: "bridged",
  identityNote: EHEX_IDENTITY,
  warning: EHEX_WARNING,
};

/** Forked USDT — resolve via FUSDT / FORK_USDT only — never plain USDT. */
export const FORK_USDT_TOKEN: TokenInfo = {
  symbol: "USDT",
  displaySymbol: "fUSDT",
  name: "Tether USD (PulseChain state fork)",
  address: FORK_USDT_ADDRESS,
  decimals: 6,
  source: "Ethereum state fork at PulseChain launch (same address as ETH USDT)",
  origin: "state_fork",
  isRealStablecoin: false,
  identityNote:
    "Forked USDT (Ethereum state copy) — not the bridged Tether stable",
  warning: FORK_USDT_WARNING,
};

/** Forked WETH — resolve via FWETH / FORK_WETH only — never plain WETH. */
export const FORK_WETH_TOKEN: TokenInfo = {
  symbol: "WETH",
  displaySymbol: "fWETH",
  name: "Wrapped Ether (PulseChain state fork)",
  address: FORK_WETH_ADDRESS,
  decimals: 18,
  source: "Ethereum state fork at PulseChain launch (same address as ETH WETH)",
  origin: "state_fork",
  identityNote: "Forked WETH (Ethereum state copy) — not bridged WETH",
  warning: FORK_WETH_WARNING,
};

/**
 * pWBTC — bad state-fork copy. Resolve via PWBTC / FORK_WBTC only — never plain WBTC.
 * Prefer eWBTC (CORE WBTC) for real bridged exposure.
 */
export const PWBTC_TOKEN: TokenInfo = {
  symbol: "WBTC",
  displaySymbol: "pWBTC",
  name: "Wrapped BTC (PulseChain state fork / pWBTC — typically useless)",
  address: PWBTC_ADDRESS,
  decimals: 8,
  source: "Ethereum state fork at PulseChain launch (same address as ETH WBTC)",
  origin: "state_fork",
  isRealStablecoin: false,
  identityNote: PWBTC_IDENTITY,
  warning: PWBTC_WARNING,
};

/** Symbol aliases that resolve to forked pDAI (never plain DAI). */
export const FORK_DAI_SYMBOLS = ["PDAI", "FORK_DAI", "FORKED_DAI", "P_DAI"] as const;

/** Symbol aliases for state-fork HEX / pHEX (same address as CORE HEX). */
export const PHEX_SYMBOLS = ["PHEX", "P_HEX", "HEX_PLS"] as const;

/** Symbol aliases for bridged eHEX (never plain HEX). */
export const EHEX_SYMBOLS = ["EHEX", "E_HEX", "BRIDGED_HEX", "HEX_ETH"] as const;

/** Symbol aliases for bridged eUSDC (same as CORE USDC). */
export const EUSDC_SYMBOLS = ["EUSDC", "E_USDC", "BRIDGED_USDC", "USDC_ETH"] as const;

/** Symbol aliases for bridged eUSDT (same as CORE USDT). */
export const EUSDT_SYMBOLS = ["EUSDT", "E_USDT", "BRIDGED_USDT", "USDT_ETH"] as const;

/** Symbol aliases for forked USDT (never plain USDT). */
export const FORK_USDT_SYMBOLS = [
  "FUSDT",
  "FORK_USDT",
  "FORKED_USDT",
  "P_USDT",
] as const;

/** Symbol aliases for forked WETH (never plain WETH). */
export const FORK_WETH_SYMBOLS = [
  "FWETH",
  "FORK_WETH",
  "FORKED_WETH",
  "P_WETH",
] as const;

/** Symbol aliases for bridged eWBTC (same as CORE WBTC). */
export const EWBTC_SYMBOLS = ["EWBTC", "E_WBTC", "BRIDGED_WBTC", "WBTC_ETH"] as const;

/** Symbol aliases for pWBTC bad fork (never plain WBTC). */
export const PWBTC_SYMBOLS = [
  "PWBTC",
  "P_WBTC",
  "FORK_WBTC",
  "FORKED_WBTC",
] as const;

/**
 * Address → known token identity including bridged + fork pairs.
 * Pure lookup for tool labeling; not limited to CORE_TOKENS portfolio defaults.
 */
export const KNOWN_TOKENS_BY_ADDRESS: Record<string, TokenInfo> = (() => {
  const map: Record<string, TokenInfo> = {};
  for (const t of Object.values(CORE_TOKENS)) {
    map[t.address.toLowerCase()] = t;
  }
  map[FORK_DAI_ADDRESS.toLowerCase()] = FORK_DAI_TOKEN;
  map[EHEX_ADDRESS.toLowerCase()] = EHEX_TOKEN;
  map[FORK_USDT_ADDRESS.toLowerCase()] = FORK_USDT_TOKEN;
  map[FORK_WETH_ADDRESS.toLowerCase()] = FORK_WETH_TOKEN;
  map[PWBTC_ADDRESS.toLowerCase()] = PWBTC_TOKEN;
  // HEX / pHEX / eUSDC / eUSDT / eWBTC already in CORE_TOKENS
  return map;
})();

/**
 * Agent-facing label fields for a token address (pure / unit-testable).
 * Returns null when the address is not in our known origin catalog.
 */
export interface TokenIdentityLabel {
  address: `0x${string}`;
  symbol: string;
  displaySymbol: string;
  origin: TokenOrigin;
  isRealStablecoin: boolean;
  identityNote: string;
  warning?: string;
  /** True when this is forked pDAI */
  isForkDai: boolean;
  /** True when this is bridged real DAI */
  isBridgedDai: boolean;
  /** True when this is state-fork HEX / pHEX (preferred HEX exception) */
  isPhex: boolean;
  /** True when this is bridged eHEX */
  isEhex: boolean;
  /** True when this is forked USDT */
  isForkUsdt: boolean;
  /** True when this is bridged eUSDT */
  isBridgedUsdt: boolean;
  /** True when this is bridged eUSDC */
  isBridgedUsdc: boolean;
  /** True when this is forked WETH */
  isForkWeth: boolean;
  /** True when this is bridged WETH */
  isBridgedWeth: boolean;
  /** True when this is bridged eWBTC */
  isEwbtc: boolean;
  /** True when this is pWBTC bad state-fork */
  isPwbtc: boolean;
  /**
   * True for pHEX only: state-fork that is still the preferred PulseChain HEX.
   * Other p* forks are typically useless.
   */
  isPreferredStateFork?: boolean;
  /** PRC-20 reminder (PulseChain tokens are not Ethereum ERC-20) */
  standardNote: string;
}

export const PRC20_STANDARD_NOTE =
  "PulseChain tokens are PRC-20 (EVM-compatible). Address identity matters more than symbol — names can collide with Ethereum ERC-20s.";

/**
 * Lookup fork/bridged/core identity for an address. Pure / unit-testable.
 */
export function getTokenIdentityLabel(
  address: string,
): TokenIdentityLabel | null {
  const lower = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(lower)) return null;
  const known = KNOWN_TOKENS_BY_ADDRESS[lower];
  if (!known) return null;
  const isForkDai = lower === FORK_DAI_ADDRESS.toLowerCase();
  const isBridgedDai = lower === BRIDGED_DAI_ADDRESS.toLowerCase();
  const isPhex = lower === HEX_ADDRESS.toLowerCase();
  const isEhex = lower === EHEX_ADDRESS.toLowerCase();
  const isForkUsdt = lower === FORK_USDT_ADDRESS.toLowerCase();
  const isBridgedUsdt = lower === USDT_FROM_ETH_ADDRESS.toLowerCase();
  const isBridgedUsdc = lower === USDC_FROM_ETH_ADDRESS.toLowerCase();
  const isForkWeth = lower === FORK_WETH_ADDRESS.toLowerCase();
  const isBridgedWeth = lower === BRIDGED_WETH_ADDRESS.toLowerCase();
  const isEwbtc = lower === EWBTC_ADDRESS.toLowerCase();
  const isPwbtc = lower === PWBTC_ADDRESS.toLowerCase();
  return {
    address: known.address,
    symbol: known.symbol,
    displaySymbol: known.displaySymbol ?? known.symbol,
    origin: known.origin ?? "pulsechain",
    isRealStablecoin: known.isRealStablecoin === true,
    identityNote: known.identityNote ?? known.name,
    warning: known.warning,
    isForkDai,
    isBridgedDai,
    isPhex,
    isEhex,
    isForkUsdt,
    isBridgedUsdt,
    isBridgedUsdc,
    isForkWeth,
    isBridgedWeth,
    isEwbtc,
    isPwbtc,
    // pHEX is the only preferred state-fork exception in the high-value catalog
    ...(isPhex ? { isPreferredStateFork: true as const } : {}),
    standardNote: PRC20_STANDARD_NOTE,
  };
}

/**
 * Compact fields to merge into tool JSON when an address is known.
 * Prefer attaching these over silently treating colliding symbols as equal.
 * Pure / unit-testable.
 */
export function tokenLabelFields(
  address: string,
): Record<string, unknown> | null {
  const label = getTokenIdentityLabel(address);
  if (!label) return null;
  const out: Record<string, unknown> = {
    token_origin: label.origin,
    display_symbol: label.displaySymbol,
    is_real_stablecoin: label.isRealStablecoin,
    identity_note: label.identityNote,
    standard_note: label.standardNote,
  };
  if (label.warning) out.warning = label.warning;
  if (label.isForkDai) {
    out.is_fork_dai = true;
    out.is_pdai = true;
    out.do_not_treat_as_usd_stable = true;
    out.bridged_dai_address = BRIDGED_DAI_ADDRESS;
  }
  if (label.isBridgedDai) {
    out.is_bridged_dai = true;
    out.fork_dai_address = FORK_DAI_ADDRESS;
    out.bridge_url = "https://bridge.pulsechain.com";
  }
  if (label.isPhex) {
    out.is_phex = true;
    out.is_hex_state_fork = true;
    out.is_preferred_state_fork = true;
    out.preferred_hex_exception = true;
    out.ehex_address = EHEX_ADDRESS;
    out.ep_naming_note =
      "pHEX is the preferred HEX on PulseChain (state-fork exception). Distinct from bridged eHEX.";
  }
  if (label.isEhex) {
    out.is_ehex = true;
    out.is_bridged_hex = true;
    out.phex_address = HEX_ADDRESS;
    out.bridge_url = "https://bridge.pulsechain.com";
    out.ep_naming_note =
      "e* = bridged from Ethereum (legitimate). Prefer pHEX for PulseChain-native HEX exposure.";
  }
  if (label.isBridgedUsdc) {
    out.is_bridged_usdc = true;
    out.is_eusdc = true;
    out.bridge_url = "https://bridge.pulsechain.com";
    out.ep_naming_note = "eUSDC: e* = bridged from Ethereum (legitimate).";
  }
  if (label.isForkUsdt) {
    out.is_fork_usdt = true;
    out.do_not_treat_as_usd_stable = true;
    out.bridged_usdt_address = USDT_FROM_ETH_ADDRESS;
  }
  if (label.isBridgedUsdt) {
    out.is_bridged_usdt = true;
    out.is_eusdt = true;
    out.fork_usdt_address = FORK_USDT_ADDRESS;
    out.bridge_url = "https://bridge.pulsechain.com";
    out.ep_naming_note = "eUSDT: e* = bridged from Ethereum (legitimate).";
  }
  if (label.isForkWeth) {
    out.is_fork_weth = true;
    out.bridged_weth_address = BRIDGED_WETH_ADDRESS;
  }
  if (label.isBridgedWeth) {
    out.is_bridged_weth = true;
    out.fork_weth_address = FORK_WETH_ADDRESS;
    out.bridge_url = "https://bridge.pulsechain.com";
  }
  if (label.isEwbtc) {
    out.is_ewbtc = true;
    out.is_bridged_wbtc = true;
    out.pwbtc_address = PWBTC_ADDRESS;
    out.bridge_url = "https://bridge.pulsechain.com";
    out.ep_naming_note =
      "eWBTC: e* = bridged (legitimate). pWBTC at 0x2260… is the bad state-fork copy.";
  }
  if (label.isPwbtc) {
    out.is_pwbtc = true;
    out.is_fork_wbtc = true;
    out.typically_useless_fork = true;
    out.do_not_prefer = true;
    out.ewbtc_address = EWBTC_ADDRESS;
    out.ep_naming_note =
      "pWBTC: p* = state-fork copy (typically useless). Prefer eWBTC 0xb17D….";
  }
  return out;
}

// ---------------------------------------------------------------------------
// PulseX DEX contracts (verified on-chain via eth_call factory()/getPair)
// ---------------------------------------------------------------------------

/** PulseX V1 factory — allPairsLength + getPair verified on rpc.pulsechain.com */
export const PULSEX_V1_FACTORY =
  "0x1715a3E4A142d8b698131108995174F37aEBA10D" as const;

/**
 * PulseX V1 router — factory() returns V1 factory.
 * Deployed by same deployer as PLSX/INC/WPLS/factory.
 */
export const PULSEX_V1_ROUTER =
  "0x98bf93ebf5c380c0e6ae8e192a7e2ae08edacc02" as const;

/** PulseX V2 factory */
export const PULSEX_V2_FACTORY =
  "0x29eA7545DEf87022BAdc76323F373EA1e707C523" as const;

/** PulseX V2 Router02 — scan verified ContractName PulseXRouter02 */
export const PULSEX_V2_ROUTER =
  "0x165C3410fC91EF562C50559f7d2289fEbed552d9" as const;

export const PULSEX_CONTRACTS = {
  v1: {
    factory: PULSEX_V1_FACTORY,
    router: PULSEX_V1_ROUTER,
  },
  v2: {
    factory: PULSEX_V2_FACTORY,
    router: PULSEX_V2_ROUTER,
  },
} as const;

// ---------------------------------------------------------------------------
// Popular contracts map (for MCP resources / address resolution)
// ---------------------------------------------------------------------------

export interface PopularContract {
  name: string;
  address: `0x${string}`;
  category: "token" | "dex" | "system" | "bridge";
  description: string;
}

export const POPULAR_CONTRACTS: PopularContract[] = [
  {
    name: "WPLS",
    address: WPLS_ADDRESS,
    category: "token",
    description: "Wrapped native PLS",
  },
  {
    name: "HEX / pHEX (state fork)",
    address: HEX_ADDRESS,
    category: "token",
    description:
      "HEX state-fork (pHEX) — popular PulseChain-side HEX; not bridged eHEX",
  },
  {
    name: "eHEX (bridged HEX)",
    address: EHEX_ADDRESS,
    category: "token",
    description:
      "HEX bridged from Ethereum via bridge.pulsechain.com — not pHEX",
  },
  {
    name: "PLSX",
    address: PLSX_ADDRESS,
    category: "token",
    description: "PulseX governance/utility token",
  },
  {
    name: "INC",
    address: INC_ADDRESS,
    category: "token",
    description: "PulseX Incentive reward token",
  },
  {
    name: "DAI (bridged)",
    address: BRIDGED_DAI_ADDRESS,
    category: "token",
    description:
      "Bridged DAI — real ~$1 stable via bridge.pulsechain.com (NOT forked pDAI)",
  },
  {
    name: "pDAI (forked DAI)",
    address: FORK_DAI_ADDRESS,
    category: "token",
    description:
      "Forked DAI / pDAI from Ethereum state copy — NOT dollar-stable; do not confuse with bridged DAI",
  },
  {
    name: "eUSDC (bridged USDC)",
    address: USDC_FROM_ETH_ADDRESS,
    category: "token",
    description:
      "eUSDC — USDC bridged from Ethereum (e* = bridged, legitimate)",
  },
  {
    name: "eUSDT (bridged USDT)",
    address: USDT_FROM_ETH_ADDRESS,
    category: "token",
    description:
      "eUSDT — USDT bridged from Ethereum — real Tether stable (NOT forked USDT)",
  },
  {
    name: "fUSDT (forked USDT)",
    address: FORK_USDT_ADDRESS,
    category: "token",
    description:
      "Forked USDT from Ethereum state copy — not the bridged Tether stable",
  },
  {
    name: "WETH (bridged)",
    address: BRIDGED_WETH_ADDRESS,
    category: "token",
    description: "WETH bridged from Ethereum (NOT forked WETH)",
  },
  {
    name: "fWETH (forked WETH)",
    address: FORK_WETH_ADDRESS,
    category: "token",
    description:
      "Forked WETH from Ethereum state copy — not bridged WETH",
  },
  {
    name: "eWBTC (bridged WBTC)",
    address: EWBTC_ADDRESS,
    category: "token",
    description:
      "eWBTC — WBTC bridged from Ethereum (e* = bridged; NOT pWBTC fork)",
  },
  {
    name: "pWBTC (forked WBTC — typically useless)",
    address: PWBTC_ADDRESS,
    category: "token",
    description:
      "pWBTC — state-fork WBTC (p* = typically useless); prefer eWBTC",
  },
  {
    name: "PulseX V1 Factory",
    address: PULSEX_V1_FACTORY,
    category: "dex",
    description: "PulseX V1 UniswapV2-style factory",
  },
  {
    name: "PulseX V1 Router",
    address: PULSEX_V1_ROUTER,
    category: "dex",
    description: "PulseX V1 swap router",
  },
  {
    name: "PulseX V2 Factory",
    address: PULSEX_V2_FACTORY,
    category: "dex",
    description: "PulseX V2 factory",
  },
  {
    name: "PulseX V2 Router",
    address: PULSEX_V2_ROUTER,
    category: "dex",
    description: "PulseX V2 Router02",
  },
  {
    name: "Multicall3",
    address: MULTICALL3_ADDRESS,
    category: "system",
    description: "Multicall3 aggregate3 helper",
  },
];

/** Lowercase address → popular contract entry */
export const POPULAR_CONTRACTS_BY_ADDRESS: Record<string, PopularContract> =
  Object.fromEntries(
    POPULAR_CONTRACTS.map((c) => [c.address.toLowerCase(), c]),
  );

/**
 * Resolve a known symbol (case-insensitive) to token info.
 * - "DAI" → **bridged** DAI only; "PDAI" / "FORK_DAI" → forked pDAI
 * - "HEX" / "PHEX" → state-fork pHEX (preferred HEX exception); "EHEX" → bridged eHEX
 * - "USDC" / "EUSDC" → bridged eUSDC; "USDT" / "EUSDT" → bridged eUSDT
 * - "FUSDT" / "FORK_USDT" → forked USDT
 * - "WETH" → bridged WETH; "FWETH" / "FORK_WETH" → forked WETH
 * - "WBTC" / "EWBTC" → bridged eWBTC; "PWBTC" / "FORK_WBTC" → bad fork pWBTC
 */
export function resolveCoreToken(symbol: string): TokenInfo | undefined {
  const key = symbol.toUpperCase().trim();
  if ((FORK_DAI_SYMBOLS as readonly string[]).includes(key)) {
    return FORK_DAI_TOKEN;
  }
  if ((EHEX_SYMBOLS as readonly string[]).includes(key)) {
    return EHEX_TOKEN;
  }
  if ((PHEX_SYMBOLS as readonly string[]).includes(key)) {
    return CORE_TOKENS.HEX;
  }
  if ((EUSDC_SYMBOLS as readonly string[]).includes(key)) {
    return CORE_TOKENS.USDC;
  }
  if ((EUSDT_SYMBOLS as readonly string[]).includes(key)) {
    return CORE_TOKENS.USDT;
  }
  if ((FORK_USDT_SYMBOLS as readonly string[]).includes(key)) {
    return FORK_USDT_TOKEN;
  }
  if ((FORK_WETH_SYMBOLS as readonly string[]).includes(key)) {
    return FORK_WETH_TOKEN;
  }
  if ((EWBTC_SYMBOLS as readonly string[]).includes(key)) {
    return CORE_TOKENS.WBTC;
  }
  if ((PWBTC_SYMBOLS as readonly string[]).includes(key)) {
    return PWBTC_TOKEN;
  }
  return CORE_TOKENS[key];
}

/**
 * Dual-DAI educational payload for resources / docs embedding.
 * Pure data — agents should never treat pDAI as interchangeable with bridged DAI.
 */
export const DUAL_DAI_GUIDANCE = {
  title: "PulseChain dual DAI: bridged vs forked (pDAI)",
  summary:
    "PulseChain launched as a full-state fork of Ethereum. Many ETH token " +
    "addresses exist on PulseChain as fork copies with different economics. " +
    "Bridged assets via bridge.pulsechain.com are distinct contracts.",
  bridgedDai: {
    address: BRIDGED_DAI_ADDRESS,
    role: "real_stablecoin",
    identityNote: BRIDGED_DAI_IDENTITY,
    warning: BRIDGED_DAI_WARNING,
    bridge: "https://bridge.pulsechain.com",
  },
  forkedDai: {
    address: FORK_DAI_ADDRESS,
    aliases: ["pDAI", "FORK_DAI"],
    role: "state_fork_not_stable",
    identityNote: FORK_DAI_IDENTITY,
    warning: FORK_DAI_WARNING,
  },
  rulesForAgents: [
    "Never choose a DAI by symbol alone — always verify the contract address.",
    "Symbol resolution DAI → bridged 0xefD7… only; pDAI/FORK_DAI → fork 0x6B17….",
    "Do not treat forked pDAI as $1 or as interchangeable liquidity with bridged DAI.",
    "PulseChain tokens are PRC-20; names can match Ethereum ERC-20s without being the same asset.",
    "Real bridged DAI moves via https://bridge.pulsechain.com.",
  ],
  standardNote: PRC20_STANDARD_NOTE,
} as const;

/**
 * Expanded fork-vs-bridged origin guidance (DAI, HEX, USDC, USDT, WBTC, WETH, …).
 * Address always beats symbol. Catalog is incomplete by design.
 * Encodes community e-star/p-star naming + pHEX preferred exception.
 */
export const TOKEN_ORIGIN_GUIDANCE = {
  title: "PulseChain fork copies vs bridged assets",
  summary:
    "PulseChain was a full state fork of Ethereum, so many Ethereum token " +
    "addresses exist as fork copies (PRC-20) with different economics. " +
    "Separately, assets can be bridged from Ethereum via bridge.pulsechain.com " +
    "as new contracts. Community labels: e* = bridged (legitimate), p* = state-fork " +
    "(typically useless) — exception: pHEX is the preferred HEX. " +
    "Symbol collision is common and dangerous — always use addresses. " +
    "Symbol search is discovery-only.",
  bridgeUrl: "https://bridge.pulsechain.com",
  epNamingRules: EP_NAMING_RULES,
  pairs: {
    dai: {
      bridged: {
        address: BRIDGED_DAI_ADDRESS,
        symbols: ["DAI"],
        displaySymbol: "DAI",
        role: "real_stablecoin",
        note: BRIDGED_DAI_IDENTITY,
      },
      stateFork: {
        address: FORK_DAI_ADDRESS,
        symbols: ["pDAI", "PDAI", "FORK_DAI"],
        displaySymbol: "pDAI",
        role: "state_fork_not_stable",
        note: FORK_DAI_IDENTITY,
      },
    },
    hex: {
      stateFork: {
        address: HEX_ADDRESS,
        symbols: ["HEX", "pHEX", "PHEX"],
        displaySymbol: "pHEX",
        role: "preferred_pulsechain_hex",
        preferred: true,
        note: PHEX_IDENTITY,
        exceptionNote:
          "pHEX is the preferred HEX on PulseChain despite being a state-fork (exception to p* = typically useless).",
      },
      bridged: {
        address: EHEX_ADDRESS,
        symbols: ["eHEX", "EHEX"],
        displaySymbol: "eHEX",
        role: "bridged_hex_from_ethereum",
        note: EHEX_IDENTITY,
        knownMajorPair: EHEX_MAJOR_PAIR_ADDRESS,
      },
    },
    usdc: {
      bridged: {
        address: USDC_FROM_ETH_ADDRESS,
        symbols: ["USDC", "eUSDC", "EUSDC"],
        displaySymbol: "eUSDC",
        role: "real_stablecoin",
        note: BRIDGED_USDC_IDENTITY,
        knownMajorPair: EUSDC_MAJOR_PAIR_ADDRESS,
      },
    },
    usdt: {
      bridged: {
        address: USDT_FROM_ETH_ADDRESS,
        symbols: ["USDT", "eUSDT", "EUSDT"],
        displaySymbol: "eUSDT",
        role: "real_stablecoin",
        note: BRIDGED_USDT_IDENTITY,
        knownMajorPair: EUSDT_MAJOR_PAIR_ADDRESS,
      },
      stateFork: {
        address: FORK_USDT_ADDRESS,
        symbols: ["fUSDT", "FUSDT", "FORK_USDT"],
        displaySymbol: "fUSDT",
        role: "state_fork_not_stable",
        note: "Forked USDT — not dollar-equivalent to bridged eUSDT",
      },
    },
    wbtc: {
      bridged: {
        address: EWBTC_ADDRESS,
        symbols: ["WBTC", "eWBTC", "EWBTC"],
        displaySymbol: "eWBTC",
        role: "bridged_wbtc",
        note: EWBTC_IDENTITY,
      },
      stateFork: {
        address: PWBTC_ADDRESS,
        symbols: ["pWBTC", "PWBTC", "FORK_WBTC"],
        displaySymbol: "pWBTC",
        role: "state_fork_typically_useless",
        preferred: false,
        note: PWBTC_IDENTITY,
      },
    },
    weth: {
      bridged: {
        address: BRIDGED_WETH_ADDRESS,
        symbols: ["WETH"],
        displaySymbol: "WETH",
        role: "bridged_wrapped_ether",
        note: "Bridged WETH from Ethereum",
      },
      stateFork: {
        address: FORK_WETH_ADDRESS,
        symbols: ["fWETH", "FWETH", "FORK_WETH"],
        displaySymbol: "fWETH",
        role: "state_fork_weth",
        note: "Forked WETH — not the bridged asset",
      },
    },
  },
  /**
   * Known major pair addresses for address-keyed follow-up only.
   * Never invent as live DexScreener search rows.
   */
  knownMajorPairs: {
    eUSDC: {
      pairAddress: EUSDC_MAJOR_PAIR_ADDRESS,
      tokenAddress: USDC_FROM_ETH_ADDRESS,
      displayName: "eUSDC / bridged DAI major pair (PulseX)",
      preferredTool: "dexscreener_pair" as const,
    },
    eUSDT: {
      pairAddress: EUSDT_MAJOR_PAIR_ADDRESS,
      tokenAddress: USDT_FROM_ETH_ADDRESS,
      displayName: "eUSDT major pair",
      preferredTool: "dexscreener_pair" as const,
    },
    eHEX: {
      pairAddress: EHEX_MAJOR_PAIR_ADDRESS,
      tokenAddress: EHEX_ADDRESS,
      displayName: "eHEX major pair",
      preferredTool: "dexscreener_pair" as const,
    },
  },
  rulesForAgents: [
    ...EP_NAMING_RULES,
    "Address identity always beats symbol on PulseChain.",
    "Symbol DAI → bridged only; PDAI/FORK_DAI → forked pDAI.",
    "Symbol HEX/PHEX → preferred state-fork pHEX; EHEX → bridged eHEX.",
    "Symbol USDC/EUSDC → bridged eUSDC; USDT/EUSDT → bridged eUSDT.",
    "Symbol WBTC/EWBTC → bridged eWBTC; PWBTC/FORK_WBTC → bad fork (typically useless).",
    "Symbol WETH → bridged only; FUSDT/FWETH (and FORK_*) → state forks.",
    "Never treat forked stables as $1 or as interchangeable with bridged stables.",
    "Known major pair addresses are catalog guidance for dexscreener_pair — never invent pair rows from guidance.",
    "This catalog is incomplete — unknown symbols still require address verification.",
    "Tokens are PRC-20; bridge path: https://bridge.pulsechain.com.",
  ],
  residualLimits: [
    "Not every forked or bridged Ethereum token is catalogued (curated high-value only).",
    "Community nicknames (pHEX, eHEX, eUSDC, eUSDT, eWBTC, pDAI, pWBTC) are labels — always show the 0x address.",
    "DexScreener and subgraph may still display raw on-chain symbols (e.g. DAI on fork pools).",
    "Known major pair addresses may lag liquidity migration — verify via address tools.",
  ],
  standardNote: PRC20_STANDARD_NOTE,
  dualDai: DUAL_DAI_GUIDANCE,
} as const;


