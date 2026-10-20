/**
 * The "business" step run for each transaction after the queue delay. In a real system this is
 * the external API call (settlement, ledger update, notification...). It must be safe to retry:
 * the repository only commits PROCESSED after it resolves, and a failure triggers a queue retry.
 *
 * The assessment's 30 s wait is provided by the SQS delay, so this stub returns immediately.
 *
 * @param {import('./transactions.repository.js').Transaction} _txn
 * @returns {Promise<void>}
 */
export async function simulateExternalCall(_txn) {
  // Intentionally empty: swap in the real integration here.
}
