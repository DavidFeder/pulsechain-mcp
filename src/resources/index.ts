import type { McpServer } from "@modelcontextprotocol/server";
import {
  CORE_TOKENS,
  DEFAULT_EXPLORER_API,
  DEFAULT_EXPLORER_UI,
  DEFAULT_PULSEX_SUBGRAPH_V1,
  DEFAULT_PULSEX_SUBGRAPH_V2,
  DEFAULT_RPC_URL,
  DEFAULT_RPC_URLS,
  DUAL_DAI_GUIDANCE,
  EHEX_TOKEN,
  EP_NAMING_RULES,
  FORK_DAI_TOKEN,
  FORK_USDT_TOKEN,
  FORK_WETH_TOKEN,
  PWBTC_TOKEN,
  MULTICALL3_ADDRESS,
  POPULAR_CONTRACTS,
  PULSECHAIN_CHAIN_ID,
  PULSECHAIN_NATIVE_DECIMALS,
  PULSECHAIN_NATIVE_SYMBOL,
  PULSEX_CONTRACTS,
  RO_RESEARCH_GUIDANCE,
  SERVER_NAME,
  SERVER_VERSION,
  TOKEN_ORIGIN_GUIDANCE,
} from "../constants.js";
import { getRpcStatusSnapshot } from "../data/rpc.js";
import type { AppConfig } from "../types.js";

/**
 * Register static MCP resources:
 * - pulsechain://tokens/core
 * - pulsechain://contracts/popular
 * - pulsechain://chain/config
 * - pulsechain://network (legacy alias of chain summary)
 * - pulsechain://guidance/ro-research (agent RO preference card)
 */
export function registerResources(server: McpServer, config: AppConfig): void {
  server.registerResource(
    "pulsechain-ro-research-guidance",
    "pulsechain://guidance/ro-research",
    {
      description:
        "Read-only research preference card: address-first identity, e*/p* naming + pHEX exception, " +
        "DexScreener discovery-only, price/quote tool preference. No secrets.",
      mimeType: "application/json",
    },
    async (uri) => {
      const body = {
        ...RO_RESEARCH_GUIDANCE,
        epNamingRules: EP_NAMING_RULES,
        knownMajorPairs: TOKEN_ORIGIN_GUIDANCE.knownMajorPairs,
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        agentWalletEnabled: config.agentWalletEnabled,
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    },
  );
  // Canonical chain config resource (no secrets — public endpoints only)
  server.registerResource(
    "pulsechain-chain-config",
    "pulsechain://chain/config",
    {
      description:
        "PulseChain chain id, native token, default RPC/explorer/subgraph URLs, and active server config (no secrets)",
      mimeType: "application/json",
    },
    async (uri) => {
      const body = {
        name: "PulseChain",
        chainId: PULSECHAIN_CHAIN_ID,
        native: {
          symbol: PULSECHAIN_NATIVE_SYMBOL,
          decimals: PULSECHAIN_NATIVE_DECIMALS,
        },
        defaults: {
          rpcUrl: DEFAULT_RPC_URL,
          rpcUrls: [...DEFAULT_RPC_URLS],
          explorerApi: DEFAULT_EXPLORER_API,
          explorerUi: DEFAULT_EXPLORER_UI,
          subgraphs: {
            pulsexV1: DEFAULT_PULSEX_SUBGRAPH_V1,
            pulsexV2: DEFAULT_PULSEX_SUBGRAPH_V2,
          },
          multicall3: MULTICALL3_ADDRESS,
          pulsex: PULSEX_CONTRACTS,
        },
        active: {
          network: config.network,
          rpcUrl: config.rpcUrl,
          rpcUrls: config.rpcUrls,
          explorerApi: config.explorerApi,
          subgraphs: {
            pulsexV1: config.pulseXSubgraphV1,
            pulsexV2: config.pulseXSubgraphV2,
          },
          agentWalletEnabled: config.agentWalletEnabled,
          // Deliberately omit AGENT_WALLET_MASTER_KEY and wallet dir contents
        },
        server: { name: SERVER_NAME, version: SERVER_VERSION },
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    },
  );

  // Legacy alias for clients that discovered pulsechain://network first
  server.registerResource(
    "pulsechain-network",
    "pulsechain://network",
    {
      description:
        "PulseChain network metadata and server config summary (see also pulsechain://chain/config)",
      mimeType: "application/json",
    },
    async (uri) => {
      const body = {
        name: "PulseChain",
        chainId: PULSECHAIN_CHAIN_ID,
        nativeSymbol: PULSECHAIN_NATIVE_SYMBOL,
        network: config.network,
        rpcUrl: config.rpcUrl,
        rpcUrls: config.rpcUrls,
        explorerApi: config.explorerApi,
        subgraphs: {
          pulsexV1: config.pulseXSubgraphV1,
          pulsexV2: config.pulseXSubgraphV2,
        },
        agentWalletEnabled: config.agentWalletEnabled,
        server: { name: SERVER_NAME, version: SERVER_VERSION },
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    },
  );

  // Multi-RPC status / health (public URLs only — no secrets)
  server.registerResource(
    "pulsechain-rpc-status",
    "pulsechain://rpc/status",
    {
      description:
        "Configured RPC endpoint list, active URL, and basic health/cooldown status (failover observability)",
      mimeType: "application/json",
    },
    async (uri) => {
      const body = getRpcStatusSnapshot({
        urls: config.rpcUrls,
        network: config.network,
        primaryRpcUrl: config.rpcUrl,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "pulsechain-tokens",
    "pulsechain://tokens/core",
    {
      description:
        "Core PulseChain token addresses (WPLS, HEX/pHEX, PLSX, INC, bridged DAI/eUSDC/eUSDT/eWBTC/WETH) " +
        "plus fork-vs-bridged guidance (pDAI, eHEX, pWBTC, forked USDT/WETH). e*/p* naming; address beats symbol.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              // Top-level core symbols kept for backward-compatible consumers
              ...CORE_TOKENS,
              forkedDaiNotInCoreDefaults: FORK_DAI_TOKEN,
              ehexBridgedNotInCoreDefaults: EHEX_TOKEN,
              forkedUsdtNotInCoreDefaults: FORK_USDT_TOKEN,
              forkedWethNotInCoreDefaults: FORK_WETH_TOKEN,
              pwbtcForkNotInCoreDefaults: PWBTC_TOKEN,
              dualDaiGuidance: DUAL_DAI_GUIDANCE,
              tokenOriginGuidance: TOKEN_ORIGIN_GUIDANCE,
              note:
                "Address identity always beats symbol. e* = bridged (legitimate); p* = state-fork " +
                "(typically useless) except pHEX preferred. DAI/USDC/USDT/WBTC/WETH = bridged; " +
                "PDAI/PWBTC/FUSDT/FWETH = state forks; HEX/PHEX = preferred pHEX; EHEX = bridged HEX. " +
                "Symbol search is discovery-only. Tokens are PRC-20.",
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "pulsechain-contracts",
    "pulsechain://contracts/popular",
    {
      description:
        "Popular PulseChain contracts (tokens, PulseX routers/factories, multicall)",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              popular: POPULAR_CONTRACTS,
              pulsex: PULSEX_CONTRACTS,
              multicall3: MULTICALL3_ADDRESS,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}
