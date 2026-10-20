import { PROCESS_OUTCOME, TRANSACTION_STATUS } from './transactions.constants.js';
import { TransactionNotFoundError } from './transactions.errors.js';

/**
 * @typedef {object} Transaction
 * @property {string} transactionId
 * @property {string} sourceAccount
 * @property {string} destinationAccount
 * @property {string} amount            Exact decimal as a string (numeric column) — never a float.
 * @property {string} currency
 * @property {'PROCESSING' | 'PROCESSED' | 'FAILED'} status
 * @property {Date} createdAt
 * @property {Date | null} enqueuedAt
 * @property {Date | null} processedAt
 * @property {number} attempts
 * @property {string | null} lastError
 * @property {number} ageSeconds        Seconds since creation, measured by the DB clock.
 */

/**
 * @typedef {object} NewTransaction
 * @property {string} transactionId
 * @property {string} sourceAccount
 * @property {string} destinationAccount
 * @property {number | string} amount
 * @property {string} currency
 */

// Every query returns the same column set so mapping stays in one place.
const COLUMNS = `
  transaction_id, source_account, destination_account, amount::text AS amount, currency, status,
  created_at, enqueued_at, processed_at, attempts, last_error,
  extract(epoch FROM (now() - created_at))::float8 AS age_seconds`;

/** @returns {Transaction} */
function mapRow(row) {
  return {
    transactionId: row.transaction_id,
    sourceAccount: row.source_account,
    destinationAccount: row.destination_account,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    enqueuedAt: row.enqueued_at,
    processedAt: row.processed_at,
    attempts: row.attempts,
    lastError: row.last_error,
    ageSeconds: row.age_seconds,
  };
}

/**
 * All SQL lives here. Uses only unnamed statements (required by Supabase transaction pooling).
 * @param {import('pg').Pool} pool
 */
export function createTransactionsRepository(pool) {
  return {
    /**
     * Idempotent create. `ON CONFLICT DO NOTHING` makes the primary key the arbiter, so concurrent
     * duplicates are safe across any number of Lambda instances.
     * @param {NewTransaction} txn
     * @returns {Promise<{ inserted: boolean, transaction: Transaction }>}
     */
    async insertIfAbsent(txn) {
      const insert = await pool.query(
        `INSERT INTO transactions (transaction_id, source_account, destination_account, amount, currency)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (transaction_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [txn.transactionId, txn.sourceAccount, txn.destinationAccount, txn.amount, txn.currency],
      );
      if (insert.rowCount === 1) return { inserted: true, transaction: mapRow(insert.rows[0]) };

      const existing = await this.findById(txn.transactionId);
      if (!existing) {
        // Conflict reported but row not visible: only possible if it was deleted in between.
        throw new TransactionNotFoundError(txn.transactionId);
      }
      return { inserted: false, transaction: existing };
    },

    /**
     * @param {string} transactionId
     * @returns {Promise<Transaction | null>}
     */
    async findById(transactionId) {
      const result = await pool.query(
        `SELECT ${COLUMNS} FROM transactions WHERE transaction_id = $1`,
        [transactionId],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    /** Records that a queue message exists for this transaction. @param {string} transactionId */
    async markEnqueued(transactionId) {
      await pool.query(
        `UPDATE transactions SET enqueued_at = now()
         WHERE transaction_id = $1 AND status = 'PROCESSING'`,
        [transactionId],
      );
    },

    /**
     * Rows still in flight whose last enqueue (or creation, if never enqueued) is older than the
     * threshold — i.e. the message was never sent or has gone missing.
     *
     * A row that has already been attempted (`attempts > 0`) has a message that is actively cycling
     * through SQS retries, so it gets the longer `retryingOlderThanSeconds` threshold; otherwise
     * the reconciler would add duplicate messages and extra DLQ entries for a failing transaction.
     *
     * @param {{ olderThanSeconds: number, retryingOlderThanSeconds: number, limit: number }} opts
     * @returns {Promise<Transaction[]>}
     */
    async findStuck({ olderThanSeconds, retryingOlderThanSeconds, limit }) {
      const result = await pool.query(
        `SELECT ${COLUMNS} FROM transactions
         WHERE status = 'PROCESSING'
           AND COALESCE(enqueued_at, created_at)
               < now() - make_interval(secs => CASE WHEN attempts = 0 THEN $1::float8 ELSE $2::float8 END)
         ORDER BY created_at
         LIMIT $3`,
        [olderThanSeconds, retryingOlderThanSeconds, limit],
      );
      return result.rows.map(mapRow);
    },

    /**
     * Runs `work` while holding a row lock, then marks the transaction PROCESSED in the same DB
     * transaction. Concurrent / duplicate deliveries queue up on the lock and then see the final
     * status, so `work` takes effect at most once per successful commit.
     * If `work` throws, everything rolls back and the error propagates.
     *
     * @param {string} transactionId
     * @param {(txn: Transaction) => Promise<void>} work
     * @returns {Promise<'processed' | 'already_done'>}
     */
    async processWithLock(transactionId, work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query(
          `SELECT ${COLUMNS} FROM transactions WHERE transaction_id = $1 FOR UPDATE`,
          [transactionId],
        );
        if (locked.rowCount === 0) throw new TransactionNotFoundError(transactionId);

        const txn = mapRow(locked.rows[0]);
        // Only a finished transaction is skipped. A FAILED one is retried: the only way a message
        // reaches it is a DLQ redrive after a fix, which must not be silently discarded.
        if (txn.status === TRANSACTION_STATUS.PROCESSED) {
          await client.query('COMMIT');
          return PROCESS_OUTCOME.ALREADY_DONE;
        }

        await work(txn);
        await client.query(
          `UPDATE transactions
           SET status = 'PROCESSED', processed_at = now(), attempts = attempts + 1, last_error = NULL
           WHERE transaction_id = $1`,
          [transactionId],
        );
        await client.query('COMMIT');
        return PROCESS_OUTCOME.PROCESSED;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    /**
     * Bookkeeping after a failed attempt (runs outside the rolled-back transaction).
     * `final` flips the row to FAILED; otherwise it stays PROCESSING so the retry can claim it.
     * @param {string} transactionId
     * @param {string} message
     * @param {{ final: boolean }} opts
     */
    async recordFailure(transactionId, message, { final }) {
      await pool.query(
        `UPDATE transactions
         SET attempts = attempts + 1,
             last_error = $2,
             status = CASE WHEN $3::boolean THEN 'FAILED' ELSE status END
         WHERE transaction_id = $1 AND status IN ('PROCESSING', 'FAILED')`,
        [transactionId, message.slice(0, 1000), final],
      );
    },
  };
}
