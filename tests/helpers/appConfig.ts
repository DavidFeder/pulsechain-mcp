import type { AppConfig } from "../../src/types.js";

/**
 * Minimal AppConfig for unit tests (multi-RPC aware).
 */
export function testAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const rpcUrl = overrides.rpcUrl ?? "https://rpc.pulsechain.com";
  const rpcUrls = overrides.rpcUrls ?? [rpcUrl];
  return {
    rpcUrl: overrides.rpcUrl ?? rpcUrls[0]!,
    rpcUrls,
    network: overrides.network ?? "mainnet",
    explorerApi:
      overrides.explorerApi ?? "https://api.scan.pulsechain.com/api",
    pulseXSubgraphV1:
      overrides.pulseXSubgraphV1 ?? "https://example.com/subgraph/v1",
    pulseXSubgraphV2:
      overrides.pulseXSubgraphV2 ?? "https://example.com/subgraph/v2",
    agentWalletEnabled: overrides.agentWalletEnabled ?? false,
    agentWalletMasterKey: overrides.agentWalletMasterKey,
    agentWalletDir: overrides.agentWalletDir ?? "./data/wallets-test",
    agentWalletMultiprocStrict: overrides.agentWalletMultiprocStrict ?? false,
    httpTransportPort: overrides.httpTransportPort,
    logLevel: overrides.logLevel ?? "error",
    httpTimeoutMs: overrides.httpTimeoutMs ?? 5_000,
  };
}
