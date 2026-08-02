import type { SubgraphSwap } from "../../../data/index.js";
import { labelSubgraphSwapRow } from "../helpers.js";
import { LARGE_SWAP_USD_FLOOR, TRANSFER_EVENT_TOPIC0 } from "./constants.js";
import { asRecord, numberOrNull, stringOrNull } from "./math.js";

export function mapRecentSwaps(swaps: SubgraphSwap[]): Array<Record<string, unknown>> {
  return swaps.map((swap) => {
    const labeled = labelSubgraphSwapRow(swap);
    return {
      id: labeled.id,
      timestamp: stringOrNull(labeled.timestamp),
      transactionHash: labeled.transaction?.id ?? null,
      sender: labeled.sender ?? null,
      to: labeled.to ?? null,
      amountUsd: numberOrNull(labeled.amountUSD),
      amount0In: stringOrNull(labeled.amount0In),
      amount1In: stringOrNull(labeled.amount1In),
      amount0Out: stringOrNull(labeled.amount0Out),
      amount1Out: stringOrNull(labeled.amount1Out),
      pair: labeled.pair ?? null,
    };
  });
}

export function selectLargeSwaps(
  swaps: Array<Record<string, unknown>>,
  tokenAddress: string,
  requestedWhaleThreshold: string | null,
): Array<Record<string, unknown>> {
  const threshold = numberOrNull(requestedWhaleThreshold);
  return swaps
    .map((swap) => {
      const amountUsd = numberOrNull(swap.amountUsd);
      const tokenAmount = tokenAmountFromSwap(swap, tokenAddress);
      const reasons: string[] = [];
      if (amountUsd !== null && amountUsd >= LARGE_SWAP_USD_FLOOR) {
        reasons.push(`amountUsd>=${LARGE_SWAP_USD_FLOOR}`);
      }
      if (
        threshold !== null &&
        tokenAmount !== null &&
        tokenAmount >= threshold
      ) {
        reasons.push("whaleThreshold");
      }
      return {
        swap,
        reasons,
        tokenAmount,
      };
    })
    .filter((row) => row.reasons.length > 0)
    .map((row) => ({
      ...row.swap,
      tokenAmount: row.tokenAmount,
      largeBy: row.reasons,
    }));
}

export function tokenAmountFromSwap(
  swap: Record<string, unknown>,
  tokenAddress: string,
): number | null {
  const pair = swap.pair as
    | {
        token0?: { id?: string };
        token1?: { id?: string };
      }
    | null
    | undefined;
  const token = tokenAddress.toLowerCase();
  if (pair?.token0?.id?.toLowerCase() === token) {
    return Math.max(
      numberOrNull(swap.amount0In) ?? 0,
      numberOrNull(swap.amount0Out) ?? 0,
    );
  }
  if (pair?.token1?.id?.toLowerCase() === token) {
    return Math.max(
      numberOrNull(swap.amount1In) ?? 0,
      numberOrNull(swap.amount1Out) ?? 0,
    );
  }
  return null;
}

export function mapRecentTransfers(raw: unknown, limit: number): Array<Record<string, unknown>> {
  const rows = explorerRows(raw);
  if (rows.length === 0) return [];
  return rows.slice(0, limit).map((row) => {
    const rec = asRecord(row);
    const token = asRecord(rec.token);
    const topics = Array.isArray(rec.topics) ? rec.topics.map(String) : [];
    const fromTopic = topics[1];
    const toTopic = topics[2];
    const logValueRaw =
      typeof rec.data === "string" && rec.data.startsWith("0x")
        ? hexToDecimalString(rec.data)
        : null;
    return {
      hash: stringOrNull(rec.hash ?? rec.transactionHash ?? rec.transaction_hash),
      blockNumber: stringOrNull(rec.blockNumber ?? rec.block_number),
      timestamp: stringOrNull(rec.timeStamp ?? rec.timestamp),
      from: stringOrNull(rec.from ?? addressFromTopic(fromTopic)),
      to: stringOrNull(rec.to ?? addressFromTopic(toTopic)),
      valueRaw: stringOrNull(rec.value ?? logValueRaw),
      tokenName: stringOrNull(rec.tokenName ?? token.name),
      tokenSymbol: stringOrNull(rec.tokenSymbol ?? token.symbol),
      tokenDecimal: stringOrNull(rec.tokenDecimal ?? token.decimals),
      method: topics[0]?.toLowerCase() === TRANSFER_EVENT_TOPIC0
        ? "erc20_transfer_log"
        : "explorer_token_transfer_row",
    };
  });
}


export function explorerRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const rec = asRecord(raw);
  if (Array.isArray(rec.result)) return rec.result;
  if (Array.isArray(rec.items)) return rec.items;
  return [];
}

export function hexToDecimalString(hex: string): string | null {
  if (!/^0x[a-fA-F0-9]*$/.test(hex)) return null;
  try {
    return BigInt(hex).toString();
  } catch {
    return null;
  }
}

export function addressFromTopic(topic: unknown): string | null {
  const value = stringOrNull(topic)?.toLowerCase();
  if (!value || !/^0x[a-f0-9]{64}$/.test(value)) return null;
  return `0x${value.slice(-40)}`;
}
