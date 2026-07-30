/**
 * Secure agent wallet subsystem.
 * Private keys: AES-256-GCM at rest, never returned in tool results or logs.
 */

export {
  encryptSecret,
  decryptSecret,
  encryptPrivateKey,
  decryptPrivateKey,
  isRawHexKey,
  resolveAesKey,
  generateWalletId,
  generateProposalId,
  safeEqualHex,
} from "./crypto.js";

export {
  evaluatePolicy,
  assertPolicyAllows,
  mergePolicy,
  normalizeDailySpend,
  normalizeTokenDailySpend,
  normalizePolicy,
  normalizeErc20NotionalCapMap,
  isAllowlistExpired,
  effectiveContractAllowlist,
  utcDateString,
  isEmptyData,
  type PolicyEvalInput,
} from "./policy.js";

export {
  buildTxReviewSummary,
  buildProposalReviewSummary,
  buildAgentIntentView,
  formatConfirmPrompt,
  categorizeDenyReason,
  POLICY_BACKSTOP_NOTE,
  LEGACY_CAPS_DISPLAY_ONLY_NOTE,
  PULSECHAIN_GAS_OPERATOR_NOTE,
  PLS_VALUE_VS_GAS_HINT,
  WALLET_TX_ORDER_HINT,
  LAB_TX_ORDER_HINT,
  SAFE_USAGE_PATTERN,
  type TxReviewSummary,
  type DecisionReason,
  type ReviewTokenMovement,
  type BuildTxReviewSummaryInput,
  type AgentIntentView,
  type AgentGuidance,
  type DecodeKnowledge,
} from "./reviewSummary.js";

export {
  computeApproxFeePls,
  enrichSimulationWithApproxFee,
  FEE_ESTIMATE_NOTE,
  type ApproxFeePlsResult,
  type FeeBasis,
} from "./feeEstimate.js";

export {
  inspectTokenNotional,
  TOKEN_NOTIONAL_SELECTORS,
  encodeMulticallBytes,
  encodeAggregate3,
  type TokenNotionalInspection,
  type TokenMovement,
  type TokenNotionalConfidence,
  type TokenNotionalPattern,
} from "./tokenNotional.js";

export {
  parsePlsToWei,
  normalizePlsDecimal,
  weiToPlsDecimal,
  weiToPlsNumber,
  getSpendWei,
  addSpendWei,
  normalizeDailySpendWei,
  capPlsToWei,
} from "./value.js";

export { withWalletLock, resetWalletLocksForTests } from "./lock.js";

export {
  ensureWalletDir,
  saveWalletRecord,
  loadWalletRecord,
  listWalletRecords,
  saveProposal,
  loadProposal,
  appendAudit,
  readAuditLog,
  atomicWriteJson,
  persistBroadcastBarrier,
  persistProposalExecuted,
  fsyncPathBestEffort,
} from "./store.js";

export {
  WALLET_DIR_OWNER_FILENAME,
  claimWalletDirOwnership,
  ensureWalletDirClaimed,
  readOwnerMarker,
  writeOwnerMarker,
  parseOwnerRecord,
  isPidAlive,
  getProcessOwnerId,
  resetWalletDirOwnershipForTests,
  clearOwnerMarker,
  buildWalletDirOwnershipStatusView,
  type WalletDirOwner,
  type OwnershipResult,
  type OwnershipStatus,
  type MultiprocRiskLevel,
  type WalletDirOwnershipStatusView,
} from "./owner.js";

export {
  createAgentWallet,
  getAgentWalletInfo,
  listAgentWallets,
  setAgentPolicy,
  killSwitch,
  revokeAgentWallet,
  proposeAgentTx,
  executeAgentTx,
  transferPls,
  agentWalletSystemStatus,
  buildOperatorAtAGlance,
  auditPolicyDeny,
  assertProposalExecutable,
  isProposalNonRetryableForSend,
  mergeSpendIntoWalletRecord,
  completePostBroadcastSettlement,
  settleInterruptedBroadcast,
  setTestBroadcast,
  type TxProposalWithReview,
  type OperatorAtAGlance,
  type OperatorPolicyPosture,
} from "./service.js";

export type {
  EncryptedBlob,
  AgentWalletPolicy,
  AgentWalletRecord,
  AgentWalletPublicInfo,
  DailySpendLedger,
  TxProposal,
  TxProposalRequest,
  PolicyCheckResult,
  TokenNotionalPolicyView,
  SimulationResult,
  AuditEntry,
} from "./types.js";

export {
  DEFAULT_POLICY,
  PROPOSAL_TTL_MS,
  AGENT_WALLET_ENABLE_WARNING,
  TOKEN_ALLOWLIST_SEMANTICS,
  MULTIPROC_POSTURE_SUMMARY,
  MULTIPROC_RECOMMENDED_MODEL,
  MULTIPROC_MODE_MEANINGS,
  APPLIED_SPEND_PROPOSAL_IDS_CAP,
} from "./types.js";
