/**
 * Agent wallet types.
 * Private keys are never stored in plaintext and never appear in tool responses.
 */

export interface EncryptedBlob {
  /** AES-256-GCM ciphertext (hex) */
  ciphertext: string;
  /** 12-byte IV (hex) */
  iv: string;
  /** Auth tag (hex) */
  tag: string;
  /** KDF salt (hex); present when master key is passphrase-derived */
  salt?: string;
  /** How the AES key was obtained from AGENT_WALLET_MASTER_KEY */
  kdf: "raw-hex" | "scrypt";
  /** Algorithm id for future-proofing */
  alg: "aes-256-gcm";
  /**
   * Private-key AAD binding version.
   * - omitted: legacy blob; decrypt with no `setAAD` (pre-binding on-disk wallets)
   * - `1`: AES-GCM AAD is UTF-8 `${walletId}:${address.toLowerCase()}`
   *
   * Cipher remains `aes-256-gcm` for both. Unknown versions fail closed at decrypt.
   */
  aadVersion?: 1;
}

/**
 * Per-wallet policy record (v0.1.38+ operator-trust).
 *
 * Hard controls at send time: `enabled` and `killed` only.
 * Legacy fields (maxPls*, allowlists, notional caps) remain for storage /
 * display / spend accounting but are NOT hard send gates.
 */
export interface AgentWalletPolicy {
  /**
   * When false, all signing is rejected (soft disable).
   * Kill switch sets enabled=false and killed=true.
   */
  enabled: boolean;
  /** Hard kill — signing blocked until set_agent_policy re-enables and clears killed. */
  killed: boolean;
  /** Legacy display / spend accounting field — not a hard gate (v0.1.38+) */
  maxPlsPerTx: number;
  /** Legacy display / spend accounting field — not a hard gate (v0.1.38+) */
  maxPlsDaily: number;
  /**
   * Legacy contract allowlist field (not a hard gate as of v0.1.38).
   */
  contractAllowlist: `0x${string}`[];
  /**
   * Legacy destination filter field (not a hard gate as of v0.1.38).
   */
  tokenAllowlist: `0x${string}`[];
  /**
   * Legacy time-box for allowlist display (not a hard gate as of v0.1.38).
   */
  allowlistExpiresAt?: string | null;
  /**
   * Legacy per-destination native PLS display caps (not a hard gate).
   */
  tokenSpendCaps: Record<string, number>;
  /**
   * Optional per-destination max **native PLS** spent per UTC day.
   * Keys: lowercase 0x addresses. Tracked via tokenDailySpend ledger.
   * This is NOT an ERC-20 amount cap — see `erc20NotionalCaps`.
   */
  tokenDailyCaps: Record<string, number>;
  /**
   * Optional per-token max **raw** amount per transaction (token smallest units).
   * Keys: lowercase token contract addresses, or `"native"` for native-in legs
   * (ETH-in swaps, WETH9 deposit). Values: non-negative integer decimal strings
   * (decimals are NOT resolved — e.g. 1e18 raw for 1 token with 18 decimals).
   * Applied when calldata is reliably decoded: ERC-20 transfer/transferFrom/approve,
   * WETH9 deposit/withdraw, router exact-in/out + fee-supporting, addLiquidity
   * desired amounts, and one-level multicall inners (amounts **summed per token**).
   * removeLiquidity notes LP shares only (underlyings not invented). Empty map = no caps.
   */
  /** Legacy per-token raw amount map (not a hard gate as of v0.1.38). */
  erc20NotionalCaps: Record<string, string>;
  /**
   * Legacy flag (not a hard gate as of v0.1.38). Calldata decode remains advisory.
   */
  requireDecodableCalldata: boolean;
  /** Legacy field; native transfers are allowed under operator-trust when enabled. */
  allowNativeTransfers: boolean;
}

export interface DailySpendLedger {
  /** UTC date YYYY-MM-DD */
  date: string;
  /**
   * Display / backward-compat PLS sum for the day (may be approximate for huge values).
   * Prefer `spentWei` for policy math.
   */
  spentPls: number;
  /**
   * Source of truth: native PLS spent today in wei (decimal integer string).
   * Absent on legacy records — migrated via getSpendWei / normalizeDailySpendWei.
   */
  spentWei?: string;
}

/** Max retained proposal ids for idempotent spend merge (crash recovery). */
export const APPLIED_SPEND_PROPOSAL_IDS_CAP = 500;

export interface AgentWalletRecord {
  id: string;
  address: `0x${string}`;
  createdAt: string;
  /** AES-GCM encrypted private key material — never exported to tools */
  encryptedKey: EncryptedBlob;
  policy: AgentWalletPolicy;
  dailySpend: DailySpendLedger;
  /**
   * Per-destination daily spend (lowercase address → ledger).
   * Used with policy.tokenDailyCaps.
   */
  tokenDailySpend: Record<string, DailySpendLedger>;
  /**
   * Proposal ids whose native spend was already merged into daily ledgers.
   * Enables idempotent post-broadcast settlement after a crash between barrier
   * and `executed` without double-counting. Capped (oldest dropped).
   */
  appliedSpendProposalIds?: string[];
  label?: string;
}

/** Public view returned by tools (no secrets). */
export interface AgentWalletPublicInfo {
  id: string;
  address: `0x${string}`;
  createdAt: string;
  label?: string;
  policy: AgentWalletPolicy;
  dailySpend: DailySpendLedger;
  tokenDailySpend: Record<string, DailySpendLedger>;
  /** True when allowlist time-box has expired (contracts denied). */
  allowlistExpired?: boolean;
  /**
   * Operator-trust: policy.maxPlsPerTx / maxPlsDaily and dailySpend ledgers are
   * display-only compatibility fields — not hard send gates.
   */
  legacyCapsDisplayOnly: true;
  /** Short note so agents do not treat maxPls* as enforceable backstops. */
  legacyCapsNote: string;
  balanceWei?: string;
  balancePls?: string;
}

/** Shared OT note for list/info public wallet surfaces (H2). */
export const LEGACY_CAPS_DISPLAY_ONLY_NOTE =
  "Legacy maxPlsPerTx / maxPlsDaily / dailySpend are display-only under " +
  "operator-trust. They do not hard-block sends. Funding the agent is authorization.";

export interface TxProposalRequest {
  walletId: string;
  to: `0x${string}`;
  /**
   * Native value in PLS. Prefer plain decimal strings for exact fractions;
   * numbers are accepted for integers and simple JSON decimals.
   */
  valuePls?: number | string;
  /** Optional calldata hex */
  data?: `0x${string}`;
  /** Optional gas limit override */
  gas?: string;
}

export interface SimulationResult {
  attempted: boolean;
  ok: boolean;
  /** Gas units from estimateGas (when available). */
  gasEstimate?: string;
  /**
   * Best-effort approximate fee in PLS (gas units × fee-market maxFee/gasPrice).
   * Approximate and fee-market dependent — not a hard limit and never a deny reason.
   */
  estimatedFeePlsApprox?: number;
  /** Same fee in wei as decimal integer string (when computed). */
  estimatedFeeWeiApprox?: string;
  /** Which fee field was used: maxFeePerGas | gasPrice | none */
  feeBasis?: "maxFeePerGas" | "gasPrice" | "none";
  /** Short honesty note for operators/agents */
  feeEstimateNote?: string;
  ethCallOk?: boolean;
  error?: string;
}

/** How token-notional inspection affected a policy check (transparent to tools). */
export interface TokenNotionalPolicyView {
  considered: boolean;
  confidence: "high" | "low" | "none";
  pattern: string;
  reliable: boolean;
  riskRelevant: boolean;
  knownPulsexRouter: boolean;
  /** True when outer multicall was expanded one level. */
  multicallExpanded: boolean;
  innerCallCount?: number;
  innerUnreliableCount?: number;
  movements: Array<{
    token: string;
    amountRaw: string;
    role: string;
    recipient?: string;
    spender?: string;
    from?: string;
    path?: string[];
    fromMulticall?: boolean;
    multicallIndex?: number;
  }>;
  notes: string[];
  /** Cap comparisons applied (when erc20NotionalCaps hit a decoded token). */
  capsApplied: Array<{
    token: string;
    amountRaw: string;
    capRaw: string;
    withinCap: boolean;
  }>;
  /** True when requireDecodableCalldata denied unknown/unreliable calldata. */
  requireDecodableCalldata: boolean;
}

export interface PolicyCheckResult {
  allowed: boolean;
  reasons: string[];
  isContractInteraction: boolean;
  destinationIsContract: boolean;
  /** Display PLS for the proposed value (from wei). */
  valuePls: number;
  /** Exact proposed value in wei (decimal string). */
  valueWei?: string;
  projectedDailySpend: number;
  /** Projected daily spend in wei (decimal string). */
  projectedDailySpendWei?: string;
  remainingDaily: number;
  remainingDailyWei?: string;
  /**
   * Always true under operator-trust: remainingDaily / maxPls* are display-only
   * accounting against stored legacy fields — not hard send gates.
   */
  legacyCapsDisplayOnly: true;
  allowlistExpired: boolean;
  /** Token-notional inspection + how caps / fail-closed applied. */
  tokenNotional?: TokenNotionalPolicyView;
}

export interface TxProposal {
  id: string;
  walletId: string;
  from: `0x${string}`;
  to: `0x${string}`;
  valueWei: string;
  valuePls: number;
  data: `0x${string}`;
  /**
   * Chain id sealed at propose time (PulseChain mainnet 369 / testnet 943).
   * Execute refuses if this is missing (legacy on-disk proposals) or does
   * not match live `chainIdForConfig(config)`. Optional only for load of
   * pre-seal JSON — new proposals always persist it.
   */
  chainId?: number;
  /**
   * Network name sealed at propose time (`config.network`). Part of confirm
   * intent; execute also refuses when present and mismatched. Missing on
   * legacy proposals.
   */
  network?: "mainnet" | "testnet";
  createdAt: string;
  expiresAt: string;
  simulation: SimulationResult;
  policyCheck: PolicyCheckResult;
  /**
   * Proposal lifecycle (send path is fail-closed once non-pending):
   * - pending — not yet sent; only status that may broadcast
   * - broadcasting — chain accepted (txHash set); local spend may be incomplete; NOT re-broadcastable
   * - executed — barrier + spend merge + final status durable
   * - rejected / expired — terminal, not sendable
   *
   * Re-execute refuses broadcasting/executed and any proposal with txHash.
   * Interrupted broadcasting can be locally settled via settleInterruptedBroadcast
   * (no second broadcast; spend merge is idempotent per proposal id).
   */
  status: "pending" | "broadcasting" | "executed" | "rejected" | "expired";
  /** Set at post-broadcast barrier; presence alone blocks re-broadcast. */
  txHash?: `0x${string}`;
  /** ISO time when broadcasting+txHash barrier was persisted (operator recovery). */
  broadcastAcceptedAt?: string;
}

export interface AuditEntry {
  ts: string;
  action:
    | "create_wallet"
    | "set_policy"
    | "propose_tx"
    | "execute_tx"
    | "transfer_pls"
    | "kill_switch"
    | "revoke"
    | "policy_deny"
    | "confirm_deny"
    /** Chain accepted; barrier written (txHash durable). */
    | "broadcast_accepted"
    /** Local spend merge + executed (may be recovery settle). */
    | "broadcast_settled";
  walletId: string;
  address?: string;
  to?: string;
  valuePls?: number;
  txHash?: string;
  proposalId?: string;
  ok: boolean;
  detail?: string;
}

export const DEFAULT_POLICY = (
  maxPlsPerTx: number,
  maxPlsDaily: number,
): AgentWalletPolicy => ({
  enabled: true,
  killed: false,
  maxPlsPerTx,
  maxPlsDaily,
  contractAllowlist: [],
  tokenAllowlist: [],
  allowlistExpiresAt: null,
  tokenSpendCaps: {},
  tokenDailyCaps: {},
  erc20NotionalCaps: {},
  requireDecodableCalldata: false,
  allowNativeTransfers: true,
});

/** Proposal TTL (ms) — short-lived to limit replay window */
export const PROPOSAL_TTL_MS = 15 * 60 * 1000;

/** Loud warning when agent wallets are enabled (config / status). */
export const AGENT_WALLET_ENABLE_WARNING =
  "SECURITY WARNING: AGENT_WALLET_ENABLED=true — this process can SIGN and " +
  "BROADCAST with funded agent EOAs. This is operator-trust mode (v0.1.38+): " +
  "funding the agent is authorization. There is no hard spend-cap or " +
  "deny-by-default allowlist safety backstop. Keep AGENT_WALLET_MASTER_KEY secret; " +
  "lose it and encrypted wallets are unrecoverable. Prefer kill_switch / revoke if " +
  "compromised. Private keys stay AES-256-GCM encrypted at rest and are never " +
  "returned in tool responses. Wallet locks are process-local only — do not share " +
  "AGENT_WALLET_DIR across multiple MCP processes (see docs/SECURITY.md). " +
  "AGENT_WALLET_MULTIPROC_STRICT defaults to true when wallets are enabled " +
  "(unset/empty). Explicit false or 0 is warn-only opt-out. Strict is not a " +
  "distributed lock; shared AGENT_WALLET_DIR is still not multi-writer-safe.";

/**
 * Legacy field semantics (storage/display only; not a hard gate as of v0.1.38).
 */
export const TOKEN_ALLOWLIST_SEMANTICS =
  "Legacy fields (tokenAllowlist, contractAllowlist, maxPls*, erc20NotionalCaps) may " +
  "still be stored for compatibility but are NOT hard send gates in operator-trust mode. " +
  "Funding the agent is authorization; kill_switch remains an emergency operator control.";

/**
 * Operator-facing multiproc posture (not a distributed lock).
 * Surfaced on agent_wallet_status, operatorAtAGlance, and startup logs.
 */
export const MULTIPROC_POSTURE_SUMMARY =
  "Shared AGENT_WALLET_DIR is NOT multi-writer-safe. " +
  "Ownership marker detects another live PID; locks remain process-local only " +
  "(NOT a distributed lock — MULTIPROC_STRICT is not cross-process serialization). " +
  "Recommended model: one MCP process → one unique AGENT_WALLET_DIR. " +
  "Wallets-on default (env unset/empty): strict-fail-closed. " +
  "Explicit AGENT_WALLET_MULTIPROC_STRICT=false or 0 is warn-only " +
  "(multiProcessRisk=true, writes STILL ALLOWED — easy to miss). " +
  "Strict still is not a distributed lock and still not multi-writer-safe if you keep sharing the dir.";

/** Short recommended operating model for operators and status payloads. */
export const MULTIPROC_RECOMMENDED_MODEL =
  "one process → one unique AGENT_WALLET_DIR";

/**
 * Explicit warn-only vs strict meanings for status / operatorAtAGlance.
 */
export const MULTIPROC_MODE_MEANINGS =
  "warn-only (explicit AGENT_WALLET_MULTIPROC_STRICT=false or 0): shared-dir risk is LOUD but writes still proceed. " +
  "strict-fail-closed is the wallets-on default when the env is unset or empty " +
  "(research-only unset stays false / warn-only). " +
  "Neither mode is a distributed lock; only unique dirs are multi-instance safe.";
