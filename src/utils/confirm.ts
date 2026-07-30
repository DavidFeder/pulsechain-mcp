/**
 * Dual-protocol confirmation for agent-wallet write tools.
 *
 * Paths:
 * 1. Legacy / scripts: `confirm=true` tool argument → proceed immediately.
 * 2. Modern MRTR (2026-07-28): missing confirm → `InputRequiredResult` eliciting
 *    a boolean confirm; client retries with `inputResponses` + echoed `requestState`.
 *
 * Security:
 * - `requestState` is HMAC-signed via SDK `createRequestStateCodec` (never raw).
 * - Payload never includes private keys, master keys, or ciphertext.
 * - Payload carries wallet id, intent hash, policy snapshot id, tool, step, exp.
 * - Resume still requires service-layer re-check of AGENT_WALLET_ENABLED, policy,
 *   and simulation before any sign/broadcast (handlers pass confirm=true only after
 *   local resolution; service re-validates independently).
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  isInputRequiredResult,
  type InputRequiredResult,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import { PolicyError } from "./errors.js";
import type { ClientRequestMeta } from "./requestMeta.js";
import type { AgentWalletPolicy } from "../wallet/types.js";

/**
 * Minimal tool context for confirm resolution (avoids importing define.ts).
 * Compatible with ToolHandlerContext from tools/define.
 */
export interface ConfirmHandlerContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mcpCtx?: any;
  client: ClientRequestMeta;
}

/** Stable step marker for confirm elicitations. */
export const CONFIRM_STEP = "awaiting-confirm" as const;

/** Default TTL for confirm requestState (seconds). */
export const CONFIRM_STATE_TTL_SECONDS = 600;

/**
 * Integrity-protected payload sealed into requestState.
 * Never put private keys / master key / ciphertext here (codec is signed, not encrypted).
 */
export interface ConfirmRequestState {
  tool: string;
  step: typeof CONFIRM_STEP;
  /** Agent wallet id when known (create flow may omit). */
  walletId?: string;
  /** SHA-256 hex of canonical intent args (excludes confirm). */
  intentHash: string;
  /** SHA-256 hex of policy snapshot, or "none". */
  policySnapshotId: string;
  /** Unix seconds expiry (also enforced by codec TTL). */
  exp: number;
}

const confirmElicitSchema = z.object({
  confirm: z.boolean(),
});

/** Wire / form schema for boolean confirm elicitation. */
export const CONFIRM_ELICIT_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    confirm: {
      type: "boolean" as const,
      description: "Set true to authorize this agent-wallet write action",
    },
  },
  required: ["confirm"] as string[],
};

export type ConfirmResolution =
  | { confirmed: true; via: "arg" | "mrtr" }
  | { confirmed: false; inputRequired: InputRequiredResult };

/** Process-local HMAC secret (≥32 bytes) for requestState when no env secret is set. */
let processMrtrSecret: string | undefined;

/**
 * HMAC secret for MRTR requestState.
 * Prefer AGENT_WALLET_MRTR_SECRET; never reuse wallet master key as ciphertext key.
 * Falls back to a process-local random secret (valid for single-process round-trips).
 */
export function getMrtrHmacSecret(): string {
  const fromEnv = process.env.AGENT_WALLET_MRTR_SECRET?.trim();
  if (fromEnv && Buffer.byteLength(fromEnv, "utf8") >= 32) {
    return fromEnv;
  }
  if (!processMrtrSecret) {
    processMrtrSecret = randomBytes(32).toString("hex");
  }
  return processMrtrSecret;
}

/** Test helper: reset process secret (does not clear env). */
export function resetMrtrSecretForTests(): void {
  processMrtrSecret = undefined;
}

let cachedCodec: RequestStateCodec<ConfirmRequestState> | undefined;
let cachedCodecKey: string | undefined;

/**
 * Shared requestState codec for confirm flows.
 * Pass `codec.verify` as `ServerOptions.requestState.verify`.
 */
export function getConfirmStateCodec(): RequestStateCodec<ConfirmRequestState> {
  const key = getMrtrHmacSecret();
  if (!cachedCodec || cachedCodecKey !== key) {
    cachedCodec = createRequestStateCodec<ConfirmRequestState>({
      key,
      ttlSeconds: CONFIRM_STATE_TTL_SECONDS,
    });
    cachedCodecKey = key;
  }
  return cachedCodec;
}

/** Test helper: drop cached codec so secret changes take effect. */
export function resetConfirmCodecForTests(): void {
  cachedCodec = undefined;
  cachedCodecKey = undefined;
}

/** Canonical JSON for stable hashing (sorted object keys). */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    // JSON.stringify(undefined) yields undefined (not a string).
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Hash of action-relevant tool args (excludes confirm and undefined).
 * Used to bind requestState to a specific intent.
 */
export function computeIntentHash(
  tool: string,
  args: Record<string, unknown>,
): string {
  const { confirm: _c, ...rest } = args;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) cleaned[k] = v;
  }
  return sha256Hex(`${tool}:${stableStringify(cleaned)}`);
}

/** Policy snapshot id for requestState (never embeds raw policy secrets). */
export function policySnapshotId(
  policy: AgentWalletPolicy | null | undefined,
): string {
  if (!policy || typeof policy !== "object") return "none";
  return sha256Hex(stableStringify(policy)).slice(0, 32);
}

function readMcpReq(ctx?: ConfirmHandlerContext): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputResponses?: any;
  requestState?: unknown;
} {
  const mcpReq = ctx?.mcpCtx?.mcpReq;
  if (!mcpReq || typeof mcpReq !== "object") return {};
  return mcpReq as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputResponses?: any;
    requestState?: unknown;
  };
}

/**
 * Whether to prefer MRTR InputRequiredResult over a static PolicyError.
 * True when SDK request context is present (modern dual path / shim) or a
 * resume already carries inputResponses / requestState.
 */
export function clientSupportsMrtr(ctx?: ConfirmHandlerContext): boolean {
  if (!ctx) return false;
  const mcpReq = readMcpReq(ctx);
  if (mcpReq.inputResponses !== undefined || mcpReq.requestState !== undefined) {
    return true;
  }
  if (ctx.client.protocolVersion === "2026-07-28") return true;
  // Any live SDK tool callback context can complete MRTR (or legacyShim).
  if (ctx.mcpCtx !== undefined && ctx.mcpCtx !== null) return true;
  return false;
}

/**
 * Read verified ConfirmRequestState from ctx when available.
 * Prefer SDK accessor (post-verify seam); fall back to codec.verify on raw string.
 */
export async function readVerifiedConfirmState(
  ctx?: ConfirmHandlerContext,
): Promise<ConfirmRequestState | undefined> {
  if (!ctx?.mcpCtx) return undefined;
  const mcpReq = ctx.mcpCtx.mcpReq;
  if (!mcpReq) return undefined;

  // Typed accessor after ServerOptions.requestState.verify
  if (typeof mcpReq.requestState === "function") {
    try {
      const decoded = await mcpReq.requestState() as ConfirmRequestState | string | undefined;
      if (decoded && typeof decoded === "object" && decoded.step === CONFIRM_STEP) {
        return decoded;
      }
      // Accessor may still return raw string if verify not configured
      if (typeof decoded === "string") {
        return await getConfirmStateCodec().verify(decoded, ctx.mcpCtx);
      }
    } catch {
      return undefined;
    }
  }

  const raw = mcpReq.requestState;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      return await getConfirmStateCodec().verify(raw, ctx.mcpCtx);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface ResolveConfirmOptions {
  tool: string;
  message: string;
  args: Record<string, unknown>;
  ctx?: ConfirmHandlerContext;
  walletId?: string;
  /** Precomputed policy snapshot id; defaults to "none". */
  policySnapshotId?: string;
}

/**
 * Resolve confirmation for a wallet write tool.
 *
 * @returns confirmed:true when arg or MRTR accept is true and state matches
 * @returns confirmed:false + inputRequired when client supports MRTR
 * @throws PolicyError when confirm missing and client cannot complete MRTR
 */
export async function resolveConfirm(
  options: ResolveConfirmOptions,
): Promise<ConfirmResolution> {
  const {
    tool,
    message,
    args,
    ctx,
    walletId,
    policySnapshotId: snap = "none",
  } = options;

  // Path 1: explicit tool argument (legacy / scripts / dual).
  if (args.confirm === true) {
    return { confirmed: true, via: "arg" };
  }

  const intentHash = computeIntentHash(tool, args);
  const mcpReq = readMcpReq(ctx);

  // Path 2: MRTR resume — accepted elicitation content.
  const accepted = acceptedContent(
    mcpReq.inputResponses,
    "confirm",
    confirmElicitSchema,
  );
  if (accepted?.confirm === true) {
    const state = await readVerifiedConfirmState(ctx);
    if (!state) {
      throw new PolicyError(
        `Write tool "${tool}" received confirm via inputResponses but ` +
          `requestState is missing, expired, or failed integrity verification. ` +
          `Re-issue the tool call to obtain a fresh confirmation challenge.`,
      );
    }
    if (state.tool !== tool || state.step !== CONFIRM_STEP) {
      throw new PolicyError(
        `Write tool "${tool}" requestState tool/step mismatch (forgery rejected).`,
      );
    }
    if (state.intentHash !== intentHash) {
      throw new PolicyError(
        `Write tool "${tool}" intent changed after confirmation challenge ` +
          `(requestState intentHash mismatch). Re-issue the tool call.`,
      );
    }
    if (walletId && state.walletId && state.walletId !== walletId) {
      throw new PolicyError(
        `Write tool "${tool}" walletId mismatch in requestState (forgery rejected).`,
      );
    }
    if (state.policySnapshotId !== snap && snap !== "none") {
      // Policy changed since challenge — force re-confirm.
      // Fall through to re-issue InputRequired if MRTR, else error.
    } else if (state.exp > 0 && state.exp * 1000 < Date.now()) {
      throw new PolicyError(
        `Write tool "${tool}" confirmation requestState expired. Re-issue the tool call.`,
      );
    } else {
      return { confirmed: true, via: "mrtr" };
    }
  }

  // Path 3: prefer MRTR InputRequiredResult when client can complete a round-trip.
  if (clientSupportsMrtr(ctx)) {
    const exp = Math.floor(Date.now() / 1000) + CONFIRM_STATE_TTL_SECONDS;
    const payload: ConfirmRequestState = {
      tool,
      step: CONFIRM_STEP,
      walletId,
      intentHash,
      policySnapshotId: snap,
      exp,
    };
    // Never mint secrets into state (payload is public-but-signed).
    const requestState = await getConfirmStateCodec().mint(payload, ctx?.mcpCtx);
    return {
      confirmed: false,
      inputRequired: inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message,
            requestedSchema: CONFIRM_ELICIT_JSON_SCHEMA,
          }),
        },
        requestState,
      }),
    };
  }

  // Path 4: backward-compatible static error for non-MRTR clients.
  throw new PolicyError(
    `Write tool "${tool}" requires explicit confirmation (fail closed). ` +
      `Pass confirm=true after reviewing amounts, recipient, and policy — or use a modern ` +
      `MRTR client that completes the confirmation elicitation (InputRequiredResult). ` +
      `Private keys are never returned.`,
  );
}

/** Type guard for handler return of InputRequiredResult. */
export function isConfirmInputRequired(
  value: ConfirmResolution | unknown,
): value is { confirmed: false; inputRequired: InputRequiredResult } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ConfirmResolution).confirmed === false &&
    isInputRequiredResult((value as { inputRequired?: unknown }).inputRequired)
  );
}

/**
 * Helper for wallet handlers: resolve confirm or return InputRequiredResult.
 * When confirmed, returns true so callers can proceed with service confirm=true.
 */
export async function requireConfirmOrInput(
  options: ResolveConfirmOptions,
): Promise<true | InputRequiredResult> {
  const resolution = await resolveConfirm(options);
  if (resolution.confirmed) return true;
  return resolution.inputRequired;
}
