import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/types.js";
import {
  PULSEX_V2_ROUTER,
  WPLS_ADDRESS,
  HEX_ADDRESS,
  PLSX_ADDRESS,
} from "../src/constants.js";
import {
  applySlippageBps,
  buildSwapPath,
  isNativeTokenRef,
  normalizeAbi,
  normalizeArgs,
  parseAmountIn,
  resolveTokenAddress,
  routerAddressForVersion,
  PREPARE_UNSIGNED_WARNING,
  PREPARE_SWAP_WARNINGS,
} from "../src/tools/chain/operations.js";

const baseConfig: AppConfig = {
  rpcUrl: "https://rpc.pulsechain.com",
  rpcUrls: ["https://rpc.pulsechain.com"],
  network: "mainnet",
  explorerApi: "https://api.scan.pulsechain.com/api",
  pulseXSubgraphV1: "https://example.com/v1",
  pulseXSubgraphV2: "https://example.com/v2",
  agentWalletEnabled: false,
  agentWalletMasterKey: undefined,
  agentWalletDir: "./data/wallets",
  agentWalletMultiprocStrict: false,
  maxPlsPerTx: 100,
  maxPlsDaily: 1000,
  httpTransportPort: undefined,
  logLevel: "info",
  httpTimeoutMs: 5000,
};

describe("chain pure helpers", () => {
  it("resolves core symbols and native sentinels", () => {
    expect(resolveTokenAddress("WPLS").toLowerCase()).toBe(
      WPLS_ADDRESS.toLowerCase(),
    );
    expect(resolveTokenAddress("hex").toLowerCase()).toBe(
      HEX_ADDRESS.toLowerCase(),
    );
    expect(resolveTokenAddress("PLS").toLowerCase()).toBe(
      WPLS_ADDRESS.toLowerCase(),
    );
    expect(isNativeTokenRef("native")).toBe(true);
    expect(isNativeTokenRef(WPLS_ADDRESS)).toBe(false);
  });

  it("builds path with WPLS hop", () => {
    const path = buildSwapPath(HEX_ADDRESS, PLSX_ADDRESS);
    expect(path).toHaveLength(3);
    expect(path[1]!.toLowerCase()).toBe(WPLS_ADDRESS.toLowerCase());
  });

  it("builds direct path when WPLS is endpoint", () => {
    const path = buildSwapPath("WPLS", "HEX");
    expect(path).toHaveLength(2);
  });

  it("parses amountIn and applies slippage", () => {
    expect(parseAmountIn("1000000000000000000")).toBe(10n ** 18n);
    expect(() => parseAmountIn("1.5")).toThrow(/integer/);
    // 1% of 10_000 = 100 removed → 9900
    expect(applySlippageBps(10_000n, 100)).toBe(9900n);
    expect(applySlippageBps(10_000n, 50)).toBe(9950n);
  });

  it("normalizes ABI and args", () => {
    const abi = normalizeAbi([
      "function balanceOf(address) view returns (uint256)",
    ]);
    expect(Array.isArray(abi)).toBe(true);
    expect(normalizeArgs([1, "0xabc"])).toEqual([1, "0xabc"]);
    expect(normalizeArgs("[1,2]")).toEqual([1, 2]);
    expect(normalizeArgs(undefined)).toEqual([]);
  });

  it("selects router by version", () => {
    expect(routerAddressForVersion("v2").toLowerCase()).toBe(
      PULSEX_V2_ROUTER.toLowerCase(),
    );
  });
});

describe("pulsex quote / prepare_swap (mocked public client)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../src/data/rpc.js");
    vi.doUnmock("../src/data/index.js");
  });

  it("quotes getAmountsOut via mocked readContract", async () => {
    const amountIn = 10n ** 18n;
    const amountOut = 5n * 10n ** 17n;
    const readContract = vi.fn(async () => [amountIn, amountOut] as const);

    const mockClient = { readContract };

    vi.doMock("../src/data/rpc.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/rpc.js")>(
        "../src/data/rpc.js",
      );
      return {
        ...actual,
        getPublicClient: () => mockClient,
      };
    });

    // operations imports getPublicClient from data/index which re-exports rpc
    vi.doMock("../src/data/index.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/data/index.js")
      >("../src/data/index.js");
      return {
        ...actual,
        getPublicClient: () => mockClient,
        getFeeData: async () => ({
          gasPriceWei: "1000000000",
          maxFeePerGas: "2000000000",
          maxPriorityFeePerGas: "1000000000",
        }),
        estimateGas: async () => ({ gasEstimate: "210000" }),
      };
    });

    const { opPulsexQuote } = await import("../src/tools/chain/operations.js");

    const quote = await opPulsexQuote(
      baseConfig,
      {
        tokenIn: WPLS_ADDRESS,
        tokenOut: HEX_ADDRESS,
        amountIn: amountIn.toString(),
        version: "v2",
      },
      mockClient as never,
    );

    expect(quote.amountIn).toBe(amountIn.toString());
    expect(quote.amountOut).toBe(amountOut.toString());
    expect(quote.amounts).toEqual([amountIn.toString(), amountOut.toString()]);
    expect(quote.router.toLowerCase()).toBe(PULSEX_V2_ROUTER.toLowerCase());
    expect(quote.path).toHaveLength(2);
    expect(readContract).toHaveBeenCalled();
    const call = readContract.mock.calls[0]![0] as {
      functionName: string;
      address: string;
    };
    expect(call.functionName).toBe("getAmountsOut");
    expect(call.address.toLowerCase()).toBe(PULSEX_V2_ROUTER.toLowerCase());
  });

  it("prepares unsigned swapExactTokensForTokens calldata", async () => {
    const amountIn = 10n ** 18n;
    const amountMid = 2n * 10n ** 18n;
    const amountOut = 3n * 10n ** 17n;
    const readContract = vi.fn(async () => [
      amountIn,
      amountMid,
      amountOut,
    ] as const);

    const mockClient = { readContract };

    // Mock estimateGas / fee data used by prepare_swap
    vi.doMock("../src/data/index.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/data/index.js")
      >("../src/data/index.js");
      return {
        ...actual,
        getPublicClient: () => mockClient,
        getFeeData: async () => ({
          gasPriceWei: "1000000000",
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
        }),
        estimateGas: async () => ({ gasEstimate: "350000" }),
      };
    });

    // Re-import operations — pass mock client directly so quote path is covered
    const ops = await import("../src/tools/chain/operations.js");

    // Patch estimateGas path by mocking at module level is flaky with partial re-import;
    // use client for quote; estimate may fail soft → gas null which is ok.
    const prepared = await ops.opPrepareSwap(
      baseConfig,
      {
        tokenIn: HEX_ADDRESS,
        tokenOut: PLSX_ADDRESS,
        amountIn: amountIn.toString(),
        recipient: "0x0000000000000000000000000000000000000001",
        version: "v2",
        slippageBps: 100,
      },
      mockClient as never,
    );

    expect(prepared.signed).toBe(false);
    expect(prepared.broadcast).toBe(false);
    expect(prepared.functionName).toBe("swapExactTokensForTokens");
    expect(prepared.unsignedTransaction.to.toLowerCase()).toBe(
      PULSEX_V2_ROUTER.toLowerCase(),
    );
    expect(prepared.unsignedTransaction.data.startsWith("0x")).toBe(true);
    expect(prepared.unsignedTransaction.value).toBe("0");
    // 1% slippage on amountOut
    expect(prepared.amountOutMin).toBe(
      applySlippageBps(amountOut, 100).toString(),
    );
    expect(prepared.suggestedApprove).not.toBeNull();
    expect(prepared.suggestedApprove?.spender.toLowerCase()).toBe(
      PULSEX_V2_ROUTER.toLowerCase(),
    );
    expect(prepared.warnings.some((w) => w.includes("UNSIGNED"))).toBe(true);
    expect(PREPARE_SWAP_WARNINGS.length).toBeGreaterThan(0);
    expect(PREPARE_UNSIGNED_WARNING).toMatch(/never signs/i);
  });

  it("prepares native-in swapExactETHForTokens with value", async () => {
    const amountIn = 10n ** 18n;
    const amountOut = 100n;
    const readContract = vi.fn(async () => [amountIn, amountOut] as const);
    const mockClient = { readContract };

    const { opPrepareSwap } = await import("../src/tools/chain/operations.js");

    const prepared = await opPrepareSwap(
      baseConfig,
      {
        tokenIn: "PLS",
        tokenOut: HEX_ADDRESS,
        amountIn: amountIn.toString(),
        recipient: "0x0000000000000000000000000000000000000002",
        nativeIn: true,
        slippageBps: 0,
      },
      mockClient as never,
    );

    expect(prepared.functionName).toBe("swapExactETHForTokens");
    expect(prepared.unsignedTransaction.value).toBe(amountIn.toString());
    expect(prepared.suggestedApprove).toBeNull();
    expect(prepared.amountOutMin).toBe(amountOut.toString());
  });
});

describe("balance helpers with mocked multicall/rpc", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../src/data/index.js");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("opGetBalance formats native balance", async () => {
    vi.doMock("../src/data/index.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/data/index.js")
      >("../src/data/index.js");
      return {
        ...actual,
        getNativeBalance: async () => ({
          address: "0x0000000000000000000000000000000000000001",
          balanceWei: "1000000000000000000",
          balancePls: "1",
        }),
      };
    });

    const { opGetBalance } = await import("../src/tools/chain/operations.js");
    const result = await opGetBalance(
      baseConfig,
      "0x0000000000000000000000000000000000000001",
    );
    expect(result.symbol).toBe("PLS");
    expect(result.balancePls).toBe("1");
    expect(result.chainId).toBe(369);
  });

  it("opGetTokenBalance returns metadata + balance", async () => {
    vi.doMock("../src/data/index.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/data/index.js")
      >("../src/data/index.js");
      return {
        ...actual,
        getErc20Metadata: async () => ({
          address: PLSX_ADDRESS,
          name: "PulseX",
          symbol: "PLSX",
          decimals: 18,
        }),
        batchErc20Balances: async () => [
          {
            token: PLSX_ADDRESS,
            owner: "0x0000000000000000000000000000000000000001",
            balanceRaw: "5000000000000000000",
            decimals: 18,
          },
        ],
      };
    });

    const { opGetTokenBalance } = await import(
      "../src/tools/chain/operations.js"
    );
    const result = await opGetTokenBalance(
      baseConfig,
      "0x0000000000000000000000000000000000000001",
      "PLSX",
    );
    expect(result.symbol).toBe("PLSX");
    expect(result.balanceFormatted).toBe("5");
    expect(result.token.toLowerCase()).toBe(PLSX_ADDRESS.toLowerCase());
  });

  it("opGetPortfolio defaults to core tokens", async () => {
    vi.doMock("../src/data/index.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/data/index.js")
      >("../src/data/index.js");
      return {
        ...actual,
        getNativeBalance: async () => ({
          address: "0x0000000000000000000000000000000000000001",
          balanceWei: "0",
          balancePls: "0",
        }),
        batchErc20Balances: async (
          _cfg: AppConfig,
          owner: string,
          tokens: string[],
        ) =>
          tokens.map((t) => ({
            token: t as `0x${string}`,
            owner: owner as `0x${string}`,
            balanceRaw: "0",
            decimals: 18,
            symbol: "X",
            name: "X",
            balanceFormatted: "0",
          })),
      };
    });

    const { opGetPortfolio, defaultCoreTokenAddresses } = await import(
      "../src/tools/chain/operations.js"
    );
    const result = await opGetPortfolio(
      baseConfig,
      "0x0000000000000000000000000000000000000001",
    );
    expect(result.native?.symbol).toBe("PLS");
    expect(result.tokens.length).toBe(defaultCoreTokenAddresses().length);
  });

  it("opGetPortfolio preserves WPLS/HEX holdings and HEX decimals=8", async () => {
    const owner = "0x0000000000000000000000000000000000000001";
    const wplsRaw = "104417099522848420979364";
    const hexRaw = "150000000"; // 1.5 HEX @ 8 decimals

    vi.doMock("../src/data/index.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/data/index.js")
      >("../src/data/index.js");
      return {
        ...actual,
        getNativeBalance: async () => ({
          address: owner,
          balanceWei: "1000000000000000000",
          balancePls: "1",
        }),
        // Simulate the pre-fix bug surface: wrong decimals + real balances
        batchErc20Balances: async (
          _cfg: AppConfig,
          _owner: string,
          tokens: string[],
        ) =>
          tokens.map((t) => {
            const lower = t.toLowerCase();
            if (lower === WPLS_ADDRESS.toLowerCase()) {
              return {
                token: t as `0x${string}`,
                owner: owner as `0x${string}`,
                balanceRaw: wplsRaw,
                decimals: 18,
                symbol: "WPLS",
                name: "Wrapped Pulse",
                balanceFormatted: "104417.099522848420979364",
              };
            }
            if (lower === HEX_ADDRESS.toLowerCase()) {
              return {
                token: t as `0x${string}`,
                owner: owner as `0x${string}`,
                balanceRaw: hexRaw,
                // Bug: multicall defaulted to 18 — portfolio must force HEX=8
                decimals: 18,
                symbol: "HEX",
                name: "HEX",
                balanceFormatted: "0.00000000015", // wrong if 18 decimals
              };
            }
            return {
              token: t as `0x${string}`,
              owner: owner as `0x${string}`,
              balanceRaw: "0",
              decimals: 18,
              symbol: "X",
              name: "X",
              balanceFormatted: "0",
            };
          }),
      };
    });

    const { opGetPortfolio } = await import("../src/tools/chain/operations.js");
    const result = await opGetPortfolio(baseConfig, owner, [
      WPLS_ADDRESS,
      HEX_ADDRESS,
    ]);

    const wpls = result.tokens.find(
      (t) => t.token.toLowerCase() === WPLS_ADDRESS.toLowerCase(),
    )!;
    const hex = result.tokens.find(
      (t) => t.token.toLowerCase() === HEX_ADDRESS.toLowerCase(),
    )!;

    expect(wpls.balanceRaw).toBe(wplsRaw);
    expect(wpls.balanceRaw).not.toBe("0");
    expect(hex.balanceRaw).toBe(hexRaw);
    expect(hex.balanceRaw).not.toBe("0");
    expect(hex.decimals).toBe(8);
    expect(hex.balanceFormatted).toBe("1.5");
    // displaySymbol for state-fork HEX is pHEX (origin clarity)
    expect(hex.knownSymbol).toBe("pHEX");
  });
});

describe("prepare_transaction shape (mocked fee/gas)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../src/data/index.js");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns unsigned transaction envelope with chainId and warnings", async () => {
    vi.doMock("../src/data/index.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/data/index.js")
      >("../src/data/index.js");
      return {
        ...actual,
        estimateGas: async () => ({ gasEstimate: "21000" }),
        getFeeData: async () => ({
          gasPriceWei: "1500000000",
          maxFeePerGas: "2000000000",
          maxPriorityFeePerGas: "1000000000",
        }),
      };
    });

    const { opPrepareTransaction, PREPARE_UNSIGNED_WARNING } = await import(
      "../src/tools/chain/operations.js"
    );

    const prepared = await opPrepareTransaction(baseConfig, {
      to: "0x0000000000000000000000000000000000000001",
      value: "1000000000000000000",
      data: "0x",
      from: "0x0000000000000000000000000000000000000002",
    });

    expect(prepared.signed).toBe(false);
    expect(prepared.broadcast).toBe(false);
    expect(prepared.unsignedTransaction.chainId).toBe(369);
    expect(prepared.unsignedTransaction.to.toLowerCase()).toBe(
      "0x0000000000000000000000000000000000000001",
    );
    expect(prepared.unsignedTransaction.value).toBe("1000000000000000000");
    expect(prepared.unsignedTransaction.valuePls).toBe("1");
    expect(prepared.unsignedTransaction.data).toBe("0x");
    expect(prepared.unsignedTransaction.from?.toLowerCase()).toBe(
      "0x0000000000000000000000000000000000000002",
    );
    expect(prepared.unsignedTransaction.gas).toBe("21000");
    expect(prepared.unsignedTransaction.gasPrice).toBe("1500000000");
    expect(prepared.warnings).toContain(PREPARE_UNSIGNED_WARNING);
    expect(prepared.warnings.some((w) => /unsigned|never signs/i.test(w))).toBe(
      true,
    );
  });

  it("accepts explicit gas and omits estimate path", async () => {
    vi.doMock("../src/data/index.js", async () => {
      const actual = await vi.importActual<
        typeof import("../src/data/index.js")
      >("../src/data/index.js");
      return {
        ...actual,
        estimateGas: vi.fn(async () => {
          throw new Error("should not be called");
        }),
        getFeeData: async () => ({
          gasPriceWei: null,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
        }),
      };
    });

    const { opPrepareTransaction } = await import(
      "../src/tools/chain/operations.js"
    );
    const prepared = await opPrepareTransaction(baseConfig, {
      to: "0x0000000000000000000000000000000000000001",
      gas: "50000",
    });
    expect(prepared.unsignedTransaction.gas).toBe("50000");
    expect(prepared.unsignedTransaction.value).toBe("0");
  });
});

describe("registerChainTools exports interactive names", () => {
  it("registers get_balance, pulsex_quote, prepare_swap, etc.", async () => {
    const tools: string[] = [];
    const server = {
      registerTool: (name: string) => {
        tools.push(name);
      },
    };

    const { registerChainTools } = await import(
      "../src/tools/chain/index.js"
    );
    const { resetToolRegistry } = await import("../src/tools/define.js");
    resetToolRegistry();
    registerChainTools(server as never, baseConfig);

    const expected = [
      "get_balance",
      "get_token_balance",
      "get_portfolio",
      "get_transaction",
      "get_transaction_history",
      "get_gas_price",
      "estimate_gas",
      "get_block",
      "read_contract",
      "prepare_transaction",
      "pulsex_quote",
      "prepare_swap",
    ];
    for (const name of expected) {
      expect(tools).toContain(name);
    }
  });
});
