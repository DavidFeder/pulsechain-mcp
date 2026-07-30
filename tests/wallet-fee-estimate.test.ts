/**
 * v0.1.39: approx PLS fee from gas units × fee market (non-blocking).
 * Drives shipped computeApproxFeePls + enrichSimulationWithApproxFee + reviewSummary.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  computeApproxFeePls,
  enrichSimulationWithApproxFee,
  FEE_ESTIMATE_NOTE,
} from "../src/wallet/feeEstimate.js";
import { buildTxReviewSummary } from "../src/wallet/reviewSummary.js";
import { evaluatePolicy } from "../src/wallet/policy.js";
import { DEFAULT_POLICY } from "../src/wallet/types.js";
import { parsePlsToWei } from "../src/wallet/value.js";
import type { AppConfig } from "../src/types.js";
import * as rpc from "../src/data/rpc.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeApproxFeePls (shipped pure)", () => {
  it("computes PLS fee from gas units × maxFeePerGas", () => {
    // 21000 gas * 1e14 wei/gas = 2.1e18 wei = 2.1 PLS
    const r = computeApproxFeePls({
      gasEstimate: "21000",
      maxFeePerGas: "100000000000000", // 1e14
      gasPriceWei: "1",
    });
    expect(r.feeBasis).toBe("maxFeePerGas");
    expect(r.estimatedFeeWeiApprox).toBe((21000n * 100000000000000n).toString());
    expect(r.estimatedFeePlsApprox).toBeCloseTo(2.1, 5);
    expect(r.feeEstimateNote).toMatch(/Approximate|fee-market/i);
    expect(r.feeEstimateNote).toContain(FEE_ESTIMATE_NOTE.slice(0, 20));
  });

  it("falls back to gasPrice when maxFee missing", () => {
    const r = computeApproxFeePls({
      gasEstimate: "21000",
      maxFeePerGas: null,
      gasPriceWei: "100000000000000",
    });
    expect(r.feeBasis).toBe("gasPrice");
    expect(r.estimatedFeePlsApprox).toBeCloseTo(2.1, 5);
  });

  it("returns none without blocking when inputs missing", () => {
    const r = computeApproxFeePls({ gasEstimate: undefined });
    expect(r.feeBasis).toBe("none");
    expect(r.estimatedFeePlsApprox).toBeUndefined();
    expect(r.feeEstimateNote).toMatch(/Approximate/i);
  });

  it("returns none on invalid bigint strings without throwing", () => {
    const r = computeApproxFeePls({
      gasEstimate: "not-a-number",
      maxFeePerGas: "1",
    });
    expect(r.feeBasis).toBe("none");
    expect(r.estimatedFeePlsApprox).toBeUndefined();
  });
});

describe("enrichSimulationWithApproxFee (shipped, fee failure non-blocking)", () => {
  const cfg: AppConfig = {
    rpcUrl: "https://rpc.pulsechain.com",
    rpcUrls: ["https://rpc.pulsechain.com"],
    network: "mainnet",
    explorerApi: "https://api.scan.pulsechain.com/api",
    pulseXSubgraphV1: "https://example.com/v1",
    pulseXSubgraphV2: "https://example.com/v2",
    agentWalletEnabled: true,
    agentWalletMasterKey: "a".repeat(64),
    agentWalletDir: "/tmp/unused",
    agentWalletMultiprocStrict: false,
    maxPlsPerTx: 100,
    maxPlsDaily: 1000,
    httpTransportPort: undefined,
    logLevel: "error",
    httpTimeoutMs: 5000,
  };

  it("attaches approx fee when fee market available", async () => {
    vi.spyOn(rpc, "getFeeData").mockResolvedValue({
      gasPriceWei: "50000000000000",
      maxFeePerGas: "100000000000000",
      maxPriorityFeePerGas: "1000000000",
    });
    const out = await enrichSimulationWithApproxFee(cfg, {
      attempted: true,
      ok: true,
      gasEstimate: "21000",
    });
    expect(out.ok).toBe(true);
    expect(out.gasEstimate).toBe("21000");
    expect(out.feeBasis).toBe("maxFeePerGas");
    expect(out.estimatedFeePlsApprox).toBeCloseTo(2.1, 5);
    expect(out.feeEstimateNote).toMatch(/Approximate/i);
  });

  it("fee market failure does not flip ok or remove gasEstimate", async () => {
    vi.spyOn(rpc, "getFeeData").mockRejectedValue(new Error("rpc down"));
    const out = await enrichSimulationWithApproxFee(cfg, {
      attempted: true,
      ok: true,
      gasEstimate: "21000",
    });
    expect(out.ok).toBe(true);
    expect(out.gasEstimate).toBe("21000");
    expect(out.feeBasis).toBe("none");
    expect(out.estimatedFeePlsApprox).toBeUndefined();
  });
});

describe("reviewSummary carries fee + display-only cap labels", () => {
  it("surfaces estimatedFeePlsApprox and legacyCapsDisplayOnly on allow path", () => {
    const valueWei = parsePlsToWei(1);
    const check = evaluatePolicy({
      policy: DEFAULT_POLICY(100, 1000),
      dailySpend: {
        date: new Date().toISOString().slice(0, 10),
        spentPls: 0,
        spentWei: "0",
      },
      to: "0x00000000000000000000000000000000000000f1",
      valueWei,
      valuePls: 1,
      data: "0x",
      destinationIsContract: false,
    });
    expect(check.allowed).toBe(true);
    expect(check.legacyCapsDisplayOnly).toBe(true);

    const summary = buildTxReviewSummary({
      to: "0x00000000000000000000000000000000000000f1",
      valueWei: valueWei.toString(),
      valuePls: 1,
      data: "0x",
      policyCheck: check,
      simulation: {
        attempted: true,
        ok: true,
        gasEstimate: "21000",
        estimatedFeePlsApprox: 7.5,
        estimatedFeeWeiApprox: "7500000000000000000",
        feeBasis: "maxFeePerGas",
        feeEstimateNote: FEE_ESTIMATE_NOTE,
      },
      context: "propose",
    });

    expect(summary.decision).toBe("allow");
    expect(summary.remainingDailyIsDisplayOnly).toBe(true);
    expect(summary.legacyCapsDisplayOnly).toBe(true);
    expect(summary.legacyCapsNote).toMatch(/display-only/i);
    expect(summary.simulation?.gasEstimate).toBe("21000");
    expect(summary.simulation?.estimatedFeePlsApprox).toBe(7.5);
    expect(summary.simulation?.feeBasis).toBe("maxFeePerGas");
    expect(summary.simulation?.feeEstimateNote).toMatch(/Approximate/i);
  });
});
