/**
 * Best-effort approximate PLS fee from gas units × fee market.
 * Pure math helpers + optional RPC enrichment. Never a hard gate.
 */

import type { AppConfig } from "../types.js";
import { getFeeData } from "../data/rpc.js";
import { weiToPlsNumber } from "./value.js";
import type { SimulationResult } from "./types.js";

export const FEE_ESTIMATE_NOTE =
  "Approximate PLS fee from gas units × current fee market (maxFeePerGas preferred, " +
  "else gasPrice). Fee-market dependent and not a hard limit; omission never blocks send.";

export type FeeBasis = "maxFeePerGas" | "gasPrice" | "none";

export interface ApproxFeePlsResult {
  estimatedFeePlsApprox?: number;
  estimatedFeeWeiApprox?: string;
  feeBasis: FeeBasis;
  feeEstimateNote: string;
}

/**
 * Pure: gas units × per-gas price (wei) → approx fee fields.
 * Returns feeBasis "none" when inputs are missing/invalid (never throws).
 */
export function computeApproxFeePls(params: {
  gasEstimate?: string;
  maxFeePerGas?: string | null;
  gasPriceWei?: string | null;
}): ApproxFeePlsResult {
  const note = FEE_ESTIMATE_NOTE;
  try {
    if (!params.gasEstimate) {
      return { feeBasis: "none", feeEstimateNote: note };
    }
    const gas = BigInt(params.gasEstimate);
    if (gas <= 0n) {
      return { feeBasis: "none", feeEstimateNote: note };
    }
    let perGas: bigint | undefined;
    let basis: FeeBasis = "none";
    if (params.maxFeePerGas) {
      const v = BigInt(params.maxFeePerGas);
      if (v > 0n) {
        perGas = v;
        basis = "maxFeePerGas";
      }
    }
    if (perGas === undefined && params.gasPriceWei) {
      const v = BigInt(params.gasPriceWei);
      if (v > 0n) {
        perGas = v;
        basis = "gasPrice";
      }
    }
    if (perGas === undefined) {
      return { feeBasis: "none", feeEstimateNote: note };
    }
    const feeWei = gas * perGas;
    return {
      estimatedFeeWeiApprox: feeWei.toString(),
      estimatedFeePlsApprox: weiToPlsNumber(feeWei),
      feeBasis: basis,
      feeEstimateNote: note,
    };
  } catch {
    return { feeBasis: "none", feeEstimateNote: note };
  }
}

/**
 * Best-effort: attach approx PLS fee onto a simulation result using live fee data.
 * Never throws; fee failure leaves gasEstimate alone and does not flip ok/deny.
 */
export async function enrichSimulationWithApproxFee(
  config: AppConfig,
  simulation: SimulationResult,
): Promise<SimulationResult> {
  if (!simulation.gasEstimate) {
    return {
      ...simulation,
      feeBasis: simulation.feeBasis ?? "none",
      feeEstimateNote: simulation.feeEstimateNote ?? FEE_ESTIMATE_NOTE,
    };
  }
  try {
    const fees = await getFeeData(config);
    const approx = computeApproxFeePls({
      gasEstimate: simulation.gasEstimate,
      maxFeePerGas: fees.maxFeePerGas,
      gasPriceWei: fees.gasPriceWei,
    });
    return {
      ...simulation,
      estimatedFeePlsApprox: approx.estimatedFeePlsApprox,
      estimatedFeeWeiApprox: approx.estimatedFeeWeiApprox,
      feeBasis: approx.feeBasis,
      feeEstimateNote: approx.feeEstimateNote,
    };
  } catch {
    return {
      ...simulation,
      feeBasis: "none",
      feeEstimateNote: FEE_ESTIMATE_NOTE,
    };
  }
}
