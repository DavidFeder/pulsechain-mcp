/**
 * Per-wallet async mutex for wallet-record mutations and sign/broadcast paths.
 *
 * Serializes concurrent execute_agent_tx / transfer_pls / kill_switch /
 * set_agent_policy / get_agent_wallet_info day-roll saves for the same walletId
 * within a single Node process so two overlapping calls cannot both pass the
 * same daily-cap snapshot, double-execute the same proposal, or last-write-wins
 * a stale full record over a kill or tightened policy.
 *
 * Process-local only — sharing AGENT_WALLET_DIR across multiple MCP processes
 * remains unsafe without external locking (see docs/SECURITY.md).
 */

const chainByWallet = new Map<string, Promise<void>>();

/** Test helper: drop lock chains (in-flight work is not cancelled). */
export function resetWalletLocksForTests(): void {
  chainByWallet.clear();
}

/**
 * Run `fn` exclusively for `walletId` (FIFO queue per wallet).
 */
export async function withWalletLock<T>(
  walletId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!walletId || typeof walletId !== "string") {
    throw new Error("withWalletLock requires a walletId");
  }

  const prev = chainByWallet.get(walletId) ?? Promise.resolve();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Next waiter awaits our release
  chainByWallet.set(
    walletId,
    prev.then(() => held).catch(() => held),
  );

  await prev.catch(() => undefined);

  try {
    return await fn();
  } finally {
    release();
  }
}
