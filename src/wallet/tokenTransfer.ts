/**
 * ERC-20 transfer proposals. Builds calldata and runs the normal
 * propose → review path. Does not broadcast.
 */

import { encodeFunctionData, erc20Abi, parseUnits, type Hex } from "viem";
import {
  KNOWN_TOKENS_BY_ADDRESS,
  resolveCoreToken,
  type TokenInfo,
} from "../constants.js";
import { getErc20Metadata } from "../data/multicall.js";
import type { AppConfig } from "../types.js";
import { AppError } from "../utils/errors.js";
import { assertAddress, isAddress } from "../utils/safety.js";
import { proposeAgentTx, type TxProposalWithReview } from "./service.js";

const HUMAN_AMOUNT_RE = /^\d+(\.\d+)?$/;

export interface ProposeTokenTransferRequest {
  walletId: string;
  /** 0x address or explicit catalog symbol (USDL, LOAN, DAI, …). */
  token: string;
  to: string;
  /** Human units, for example "1.5". Mutually exclusive with amountRaw. */
  amount?: string;
  /** Smallest units as a decimal integer string. Mutually exclusive with amount. */
  amountRaw?: string;
}

function knownByAddress(address: string): TokenInfo | undefined {
  return KNOWN_TOKENS_BY_ADDRESS[address.toLowerCase()];
}

/**
 * Resolve an explicit symbol or address. Unknown tickers are rejected so
 * USDL/LOAN cannot be reached through lookalike names.
 */
export function resolveTransferToken(token: string): {
  address: `0x${string}`;
  decimals?: number;
  symbol?: string;
} {
  const raw = token.trim();
  if (isAddress(raw)) {
    const address = assertAddress(raw);
    const known = knownByAddress(address);
    return {
      address,
      decimals: known?.decimals,
      symbol: known?.displaySymbol ?? known?.symbol,
    };
  }
  const resolved = resolveCoreToken(raw);
  if (!resolved) {
    throw new AppError(
      `Unknown token "${token}". Pass a 0x address, or an explicit catalog symbol ` +
        `(USDL and LOAN are Liquid Loans symbols — not aliases of DAI, USD, or eUSDC).`,
      "VALIDATION_ERROR",
    );
  }
  return {
    address: resolved.address,
    decimals: resolved.decimals,
    symbol: resolved.displaySymbol ?? resolved.symbol,
  };
}

function amountToRaw(
  amount: string | undefined,
  amountRaw: string | undefined,
  decimals: number,
): bigint {
  const hasHuman = amount !== undefined && amount.trim() !== "";
  const hasRaw = amountRaw !== undefined && amountRaw.trim() !== "";
  if (hasHuman === hasRaw) {
    throw new AppError(
      "Pass exactly one of amount (human units) or amountRaw (smallest units)",
      "VALIDATION_ERROR",
    );
  }
  if (hasRaw) {
    const rawText = amountRaw!.trim();
    if (!/^\d+$/.test(rawText) || rawText === "0") {
      throw new AppError(
        "amountRaw must be a positive decimal integer string",
        "VALIDATION_ERROR",
      );
    }
    return BigInt(rawText);
  }
  const human = amount!.trim();
  if (!HUMAN_AMOUNT_RE.test(human) || human === "0") {
    throw new AppError(
      'amount must be a plain positive decimal such as "1" or "0.5" (no scientific notation)',
      "VALIDATION_ERROR",
    );
  }
  try {
    const raw = parseUnits(human, decimals);
    if (raw <= 0n) {
      throw new AppError("amount must be greater than zero", "VALIDATION_ERROR");
    }
    return raw;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      err instanceof Error
        ? `Could not parse amount "${human}" with ${decimals} decimals: ${err.message}`
        : `Could not parse amount "${human}"`,
      "VALIDATION_ERROR",
    );
  }
}

/**
 * Simulate and store an ERC-20 `transfer` proposal. The caller executes it
 * with execute_agent_tx after reading reviewSummary.
 */
export async function proposeTokenTransfer(
  config: AppConfig,
  req: ProposeTokenTransferRequest,
): Promise<TxProposalWithReview & { token: `0x${string}`; amountRaw: string; symbol?: string }> {
  const token = resolveTransferToken(req.token);
  const recipient = assertAddress(req.to);
  let decimals = token.decimals;
  if (decimals === undefined) {
    const meta = await getErc20Metadata(config, token.address);
    decimals = meta.decimals;
  }
  const raw = amountToRaw(req.amount, req.amountRaw, decimals);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [recipient, raw],
  });
  const proposal = await proposeAgentTx(config, {
    walletId: req.walletId,
    to: token.address,
    valuePls: 0,
    data: data as Hex,
  });
  return {
    ...proposal,
    token: token.address,
    amountRaw: raw.toString(),
    symbol: token.symbol,
  };
}
