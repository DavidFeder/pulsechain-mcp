/**
 * Configured chain id (369/943) on reports, prepare payloads, health, and resources.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORER_API,
  DEFAULT_PULSEX_SUBGRAPH_V1,
  DEFAULT_PULSEX_SUBGRAPH_V2,
} from "../src/constants.js";
import {
  MAINNET_ONLY_AGGREGATOR_WARNING,
  TESTNET_MAINNET_DEFAULTS_WARNING,
  chainIdForConfig,
  mainnetOnlyAggregatorWarnings,
  networkMismatchForConfig,
} from "../src/data/rpc.js";
import { registerResources } from "../src/resources/index.js";
import { getRegisteredTools, resetToolRegistry } from "../src/tools/define.js";
import { registerChainTools } from "../src/tools/chain/index.js";
import { buildHealth, registerHealthTools } from "../src/tools/health.js";
import { ok } from "../src/utils/result.js";
import { testAppConfig } from "./helpers/appConfig.js";

afterEach(() => {
  resetToolRegistry();
});

function mockToolServer() {
  const handlers = new Map<
    string,
    (args?: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>
  >();
  const server = {
    registerTool: (name: string, ...rest: unknown[]) => {
      const cb = rest[rest.length - 1];
      if (typeof cb === "function") {
        handlers.set(
          name,
          cb as (args?: Record<string, unknown>) => Promise<{
            content: Array<{ type: string; text: string }>;
          }>,
        );
      }
    },
  };
  return { handlers, server };
}

function mockResourceServer() {
  const handlers = new Map<
    string,
    (uri: URL) => Promise<{ contents: Array<{ text: string }> }>
  >();
  const server = {
    registerResource: (
      _name: string,
      uri: string,
      _meta: unknown,
      handler: (uri: URL) => Promise<{ contents: Array<{ text: string }> }>,
    ) => {
      handlers.set(uri, handler);
    },
  };
  return { handlers, server };
}

const testnetDefaults = testAppConfig({
  network: "testnet",
  explorerApi: DEFAULT_EXPLORER_API,
  pulseXSubgraphV1: DEFAULT_PULSEX_SUBGRAPH_V1,
  pulseXSubgraphV2: DEFAULT_PULSEX_SUBGRAPH_V2,
});

const testnetCustomExplorer = testAppConfig({
  network: "testnet",
  explorerApi: "https://scan.v4.testnet.pulsechain.com/api",
  pulseXSubgraphV1: "https://example.test/v1",
  pulseXSubgraphV2: "https://example.test/v2",
});

describe("chainIdForConfig", () => {
  it("returns 369 on mainnet and 943 on testnet", () => {
    expect(chainIdForConfig({ network: "mainnet" })).toBe(369);
    expect(chainIdForConfig({ network: "testnet" })).toBe(943);
  });
});

describe("networkMismatchForConfig", () => {
  it("is absent on normal mainnet even with default explorer/subgraph", () => {
    expect(
      networkMismatchForConfig(
        testAppConfig({
          network: "mainnet",
          explorerApi: DEFAULT_EXPLORER_API,
          pulseXSubgraphV1: DEFAULT_PULSEX_SUBGRAPH_V1,
          pulseXSubgraphV2: DEFAULT_PULSEX_SUBGRAPH_V2,
        }),
      ),
    ).toBeUndefined();
  });

  it("is present on testnet with default mainnet explorer", () => {
    const mismatch = networkMismatchForConfig(testnetDefaults);
    expect(mismatch).toBeDefined();
    expect(mismatch?.explorerApiIsMainnetDefault).toBe(true);
    expect(mismatch?.pulseXSubgraphV1IsMainnetDefault).toBe(true);
    expect(mismatch?.warning).toBe(TESTNET_MAINNET_DEFAULTS_WARNING);
  });

  it("is absent on testnet when explorer and subgraphs are overridden", () => {
    expect(networkMismatchForConfig(testnetCustomExplorer)).toBeUndefined();
  });

  it("is present when testnet explorer is custom but a subgraph is still the mainnet default", () => {
    const mismatch = networkMismatchForConfig(
      testAppConfig({
        network: "testnet",
        explorerApi: "https://scan.v4.testnet.pulsechain.com/api",
        pulseXSubgraphV1: DEFAULT_PULSEX_SUBGRAPH_V1,
        pulseXSubgraphV2: "https://example.test/v2",
      }),
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.explorerApiIsMainnetDefault).toBe(false);
    expect(mismatch?.pulseXSubgraphV1IsMainnetDefault).toBe(true);
  });
});

describe("buildHealth", () => {
  it("stamps configured chain id and omits networkMismatch on mainnet", () => {
    const health = buildHealth(testAppConfig({ network: "mainnet" }));
    expect(health.chainId).toBe(369);
    expect(health.network).toBe("mainnet");
    expect(health.networkMismatch).toBeUndefined();
  });

  it("stamps 943 and networkMismatch on testnet + mainnet explorer defaults", () => {
    const health = buildHealth(testnetDefaults);
    expect(health.chainId).toBe(943);
    expect(health.networkMismatch?.warning).toMatch(/testnet|943/i);
    expect(health.networkMismatch?.explorerApiIsMainnetDefault).toBe(true);
  });
});

describe("pulsechain_health / pulsechain_chain_id tools", () => {
  it("pulsechain_health matches buildHealth on testnet", async () => {
    const { handlers, server } = mockToolServer();
    resetToolRegistry();
    registerHealthTools(server as never, testnetDefaults);
    const fn = handlers.get("pulsechain_health");
    expect(fn).toBeTypeOf("function");
    const res = await fn!({});
    const body = JSON.parse(res.content[0]!.text) as {
      ok: boolean;
      data: ReturnType<typeof buildHealth>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.chainId).toBe(943);
    expect(body.data.networkMismatch).toBeDefined();
  });

  it("pulsechain_chain_id follows config.network", async () => {
    const main = mockToolServer();
    resetToolRegistry();
    registerChainTools(main.server as never, testAppConfig({ network: "mainnet" }));
    const mainRes = await main.handlers.get("pulsechain_chain_id")!({});
    const mainBody = JSON.parse(mainRes.content[0]!.text) as {
      ok: boolean;
      data: { chainId: number };
    };
    expect(mainBody.data.chainId).toBe(369);

    const test = mockToolServer();
    resetToolRegistry();
    registerChainTools(test.server as never, testAppConfig({ network: "testnet" }));
    expect(getRegisteredTools().some((t) => t.name === "pulsechain_chain_id")).toBe(
      true,
    );
    const testRes = await test.handlers.get("pulsechain_chain_id")!({});
    const testBody = JSON.parse(testRes.content[0]!.text) as {
      ok: boolean;
      data: { chainId: number };
    };
    expect(testBody.data.chainId).toBe(943);
  });
});

describe("pulsechain://chain/config resource", () => {
  it("chainId follows config.network; mismatch only on testnet defaults", async () => {
    const main = mockResourceServer();
    registerResources(main.server as never, testAppConfig({ network: "mainnet" }));
    const mainJson = JSON.parse(
      (
        await main.handlers.get("pulsechain://chain/config")!(
          new URL("pulsechain://chain/config"),
        )
      ).contents[0]!.text,
    ) as {
      chainId: number;
      networkMismatch?: unknown;
      active: { network: string; chainId: number };
    };
    expect(mainJson.chainId).toBe(369);
    expect(mainJson.active.chainId).toBe(369);
    expect(mainJson.networkMismatch).toBeUndefined();

    const test = mockResourceServer();
    registerResources(test.server as never, testnetDefaults);
    const testJson = JSON.parse(
      (
        await test.handlers.get("pulsechain://chain/config")!(
          new URL("pulsechain://chain/config"),
        )
      ).contents[0]!.text,
    ) as {
      chainId: number;
      networkMismatch?: { warning: string };
      active: { chainId: number };
    };
    expect(testJson.chainId).toBe(943);
    expect(testJson.active.chainId).toBe(943);
    expect(testJson.networkMismatch?.warning).toMatch(/mainnet defaults/i);

    const aliasJson = JSON.parse(
      (
        await test.handlers.get("pulsechain://network")!(
          new URL("pulsechain://network"),
        )
      ).contents[0]!.text,
    ) as { chainId: number; networkMismatch?: unknown };
    expect(aliasJson.chainId).toBe(943);
    expect(aliasJson.networkMismatch).toBeDefined();
  });
});

describe("mainnet-only aggregators", () => {
  it("warns on testnet and stays silent on mainnet", () => {
    expect(mainnetOnlyAggregatorWarnings({ network: "mainnet" })).toBeUndefined();
    expect(mainnetOnlyAggregatorWarnings({ network: "testnet" })).toEqual([
      MAINNET_ONLY_AGGREGATOR_WARNING,
    ]);
    expect(MAINNET_ONLY_AGGREGATOR_WARNING).toMatch(/mainnet-only|369/i);
    expect(MAINNET_ONLY_AGGREGATOR_WARNING).toMatch(/943|testnet/i);

    const wrapped = ok(
      { chainId: 369, source: "piteas" },
      mainnetOnlyAggregatorWarnings({ network: "testnet" }),
    );
    expect(wrapped.data.chainId).toBe(369);
    expect(wrapped.warnings).toEqual([MAINNET_ONLY_AGGREGATOR_WARNING]);
  });
});