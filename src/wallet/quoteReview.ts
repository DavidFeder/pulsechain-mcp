/**
 * Stamp a Piteas quote onto a wallet proposal so review does not depend
 * on decoding the aggregator router selector.
 * Advisory only — never a send gate and never rewrites calldata.
 */

import { PITEAS_ROUTER } from "../data/piteas.js";
import { AppError } from "../utils/errors.js";
import type {
  AggregatorQuoteReview,
  AggregatorQuoteReviewInput,
} from "./types.js";

/** Quotes older than this are marked stale. Execute is still allowed. */
export const QUOTE_STALE_AFTER_SEC = 120;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const INT_RE = /^\d+$/;

function requireInt(value: string, field: string): string {
  const trimmed = value.trim();
  if (!INT_RE.test(trimmed)) {
    throw new AppError(
      `quoteReview.${field} must be a decimal integer string (token smallest units)`,
      "VALIDATION_ERROR",
    );
  }
  return trimmed;
}

function requireTokenRef(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.toUpperCase() === "PLS") return "PLS";
  if (!ADDRESS_RE.test(trimmed)) {
    throw new AppError(
      `quoteReview.${field} must be a 0x address or PLS`,
      "VALIDATION_ERROR",
    );
  }
  return trimmed;
}

/**
 * Validate and fill defaults for a caller-supplied Piteas quote stamp.
 * Throws VALIDATION_ERROR when the object is present but unusable.
 */
export function normalizeAggregatorQuoteReview(
  input: AggregatorQuoteReviewInput,
  nowMs: number = Date.now(),
): AggregatorQuoteReview {
  if (!input || input.source !== "piteas") {
    throw new AppError(
      'quoteReview.source must be "piteas"',
      "VALIDATION_ERROR",
    );
  }

  let quotedAt: string;
  if (input.quotedAt === undefined || input.quotedAt.trim() === "") {
    quotedAt = new Date(nowMs).toISOString();
  } else {
    const parsed = Date.parse(input.quotedAt);
    if (!Number.isFinite(parsed)) {
      throw new AppError(
        "quoteReview.quotedAt must be an ISO timestamp",
        "VALIDATION_ERROR",
      );
    }
    if (parsed > nowMs + 120_000) {
      throw new AppError(
        "quoteReview.quotedAt is too far in the future",
        "VALIDATION_ERROR",
      );
    }
    quotedAt = new Date(parsed).toISOString();
  }

  let router = PITEAS_ROUTER;
  if (input.router !== undefined && input.router.trim() !== "") {
    if (!ADDRESS_RE.test(input.router.trim())) {
      throw new AppError(
        "quoteReview.router must be a 0x address",
        "VALIDATION_ERROR",
      );
    }
    router = input.router.trim() as typeof PITEAS_ROUTER;
  }

  if (
    input.recipient !== undefined &&
    input.recipient.trim() !== "" &&
    !ADDRESS_RE.test(input.recipient.trim())
  ) {
    throw new AppError(
      "quoteReview.recipient must be a 0x address",
      "VALIDATION_ERROR",
    );
  }

  if (
    input.allowedSlippage !== undefined &&
    (!Number.isFinite(input.allowedSlippage) ||
      input.allowedSlippage < 0 ||
      input.allowedSlippage > 100)
  ) {
    throw new AppError(
      "quoteReview.allowedSlippage must be between 0 and 100",
      "VALIDATION_ERROR",
    );
  }

  const review: AggregatorQuoteReview = {
    source: "piteas",
    quotedAt,
    tokenIn: requireTokenRef(input.tokenIn, "tokenIn"),
    tokenOut: requireTokenRef(input.tokenOut, "tokenOut"),
    amountIn: requireInt(input.amountIn, "amountIn"),
    amountOut: requireInt(input.amountOut, "amountOut"),
    router,
    sellingNativePls: input.sellingNativePls === true,
  };
  if (input.amountOutMin !== undefined && input.amountOutMin.trim() !== "") {
    review.amountOutMin = requireInt(input.amountOutMin, "amountOutMin");
  }
  if (input.recipient && input.recipient.trim() !== "") {
    review.recipient = input.recipient.trim();
  }
  if (input.routeSignature && input.routeSignature.trim() !== "") {
    review.routeSignature = input.routeSignature.trim().slice(0, 500);
  }
  if (input.allowedSlippage !== undefined) {
    review.allowedSlippage = input.allowedSlippage;
  }
  return review;
}

/** Whole seconds since quotedAt. Never negative. */
export function quoteAgeSec(quotedAt: string, nowMs: number = Date.now()): number {
  const parsed = Date.parse(quotedAt);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}
