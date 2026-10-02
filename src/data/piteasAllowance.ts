/**
 * Allowance hint for a prepared Piteas swap. Does not broadcast an approve.
 */

import { encodeFunctionData, erc20Abi } from "viem";
import { PITEAS_ROUTER, type PiteasPrepareResult } from "./piteas.js";
import { readErc20Allowance } from "./multicall.js";
import type { AppConfig } from "../types.js";

export interface PiteasSuggestedApprove {
  to: string;
  data: string;
  value: "0";
  spender: string;
  amount: string;
  note: string;
}

export interface PiteasAllowanceHint {
  status: "sufficient" | "insufficient" | "not_applicable" | "skipped" | "unknown";
  allowanceSufficient: boolean | null;
  token?: string;
  owner?: string;
  spender: string;
  allowanceRaw?: string;
  amountInRaw?: string;
  suggestedApprove: PiteasSuggestedApprove | null;
  note: string;
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function suggestedApprove(
  token: string,
  amount: string,
): PiteasSuggestedApprove {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [PITEAS_ROUTER, BigInt(amount)],
  });
  return {
    to: token,
    data,
    value: "0",
    spender: PITEAS_ROUTER,
    amount,
    note: "Submit this approve before the swap if allowance is insufficient. Not auto-broadcast.",
  };
}

/**
 * Read the owner's ERC-20 allowance for the Piteas router.
 * Native PLS sells skip the read. Missing owner skips the read.
 * RPC failure becomes status "unknown" and does not fail the prepare.
 */
export async function buildPiteasAllowanceHint(
  config: AppConfig,
  prepared: Extract<PiteasPrepareResult, { ok: true }>,
  owner: string | undefined,
  readAllowance: typeof readErc20Allowance = readErc20Allowance,
): Promise<PiteasAllowanceHint> {
  const spender = PITEAS_ROUTER;
  if (prepared.review.sellingNativePls) {
    return {
      status: "not_applicable",
      allowanceSufficient: true,
      spender,
      suggestedApprove: null,
      note: "Selling native PLS does not need an ERC-20 allowance.",
    };
  }

  const token = prepared.review.tokenIn;
  const amountIn = prepared.review.amountIn;
  if (!owner || !ADDRESS_RE.test(owner)) {
    return {
      status: "skipped",
      allowanceSufficient: null,
      token,
      spender,
      amountInRaw: amountIn,
      suggestedApprove: null,
      note: "Pass owner (the address that holds the token) to check allowance against the Piteas router.",
    };
  }
  if (!ADDRESS_RE.test(token) || !/^\d+$/.test(amountIn)) {
    return {
      status: "unknown",
      allowanceSufficient: null,
      token,
      owner,
      spender,
      suggestedApprove: null,
      note: "Token in or amount in is not an address/integer, so allowance was not read.",
    };
  }

  try {
    const read = await readAllowance(config, token, owner, spender);
    const allowance = BigInt(read.allowanceRaw);
    const need = BigInt(amountIn);
    const sufficient = allowance >= need;
    return {
      status: sufficient ? "sufficient" : "insufficient",
      allowanceSufficient: sufficient,
      token,
      owner,
      spender,
      allowanceRaw: read.allowanceRaw,
      amountInRaw: amountIn,
      suggestedApprove: sufficient ? null : suggestedApprove(token, amountIn),
      note: sufficient
        ? "Allowance covers amountIn. Still re-check if another spend lands first."
        : "Allowance is below amountIn. Propose suggestedApprove as its own transaction before the swap.",
    };
  } catch (err) {
    return {
      status: "unknown",
      allowanceSufficient: null,
      token,
      owner,
      spender,
      amountInRaw: amountIn,
      suggestedApprove: suggestedApprove(token, amountIn),
      note:
        "Could not read allowance (" +
        (err instanceof Error ? err.message : "RPC error") +
        "). suggestedApprove is included so you can send it if the swap would revert. Not auto-broadcast.",
    };
  }
}
