import { LOG_EVENT } from '#src/constants/log-events.js';
import { PROCESS_OUTCOME, TRANSACTION_STATUS } from './transactions.constants.js';
import { toPublicTransaction } from './transactions.mapper.js';

/**
 * @typedef {object} TransactionsServiceSettings
 * @property {number} processDelaySeconds   Delay before a new transaction is processed (30).
 * @property {number} repairGraceSeconds    A duplicate younger than this is assumed to be racing the
 *                                          original request, so it does not trigger a re-enqueue.
 */

/** @typedef {ReturnType<typeof createTransactionsService>} TransactionsService */

/** Names of the fields that differ between a stored transaction and a replayed webhook. */
function findPayloadDifferences(existing, incoming) {
  const differences = [];
  if (existing.sourceAccount !== incoming.sourceAccount) differences.push('source_account');
  if (existing.destinationAccount !== incoming.destinationAccount) {
    differences.push('destination_account');
  }
  if (Number(existing.amount) !== Number(incoming.amount)) differences.push('amount');
  if (existing.currency !== incoming.currency) differences.push('currency');
  return differences;
}

/**
 * Business rules for webhook ingestion, background processing and recovery.
 * Depends only on ports (repository, queue, processor, logger) so it is testable without AWS.
 *
 * @param {{
 *   repository: ReturnType<typeof import('./transactions.repository.js').createTransactionsRepository>,
 *   queue: import('#src/infrastructure/queue/job-queue.js').JobQueue,
 *   processor: (txn: import('./transactions.repository.js').Transaction) => Promise<void>,
 *   logger: import('pino').Logger,
 *   settings: TransactionsServiceSettings,
 * }} deps
 */
export function createTransactionsService({ repository, queue, processor, logger, settings }) {
  /** Queue first, then record it: if recording fails the duplicate message is harmless. */
  async function enqueue(transactionId, delaySeconds) {
    await queue.send({ transactionId, delaySeconds });
    await repository.markEnqueued(transactionId);
  }

  return {
    /**
     * Accepts a webhook. Durable before it returns: the row is committed, then the job is queued.
     * Throws if the job could not be queued so the caller answers 5xx and the sender retries;
     * the retry (or the reconciler) repairs the missing message.
     *
     * @param {import('./transactions.repository.js').NewTransaction} payload
     * @param {{ logger?: import('pino').Logger }} [context]  Request-scoped logger, so the
     *        service's log lines carry the same request_id as the access log.
     * @returns {Promise<{ duplicate: boolean }>}
     */
    async receiveWebhook(payload, context = {}) {
      const log = (context.logger ?? logger).child({ transaction_id: payload.transactionId });
      const { inserted, transaction } = await repository.insertIfAbsent(payload);

      if (inserted) {
        await enqueue(payload.transactionId, settings.processDelaySeconds);
        log.info({ event: LOG_EVENT.WEBHOOK_ACCEPTED }, 'webhook accepted');
        return { duplicate: false };
      }

      const differences = findPayloadDifferences(transaction, payload);
      if (differences.length > 0) {
        // First write wins. Never overwrite a financial record because of a replay.
        log.warn(
          { event: LOG_EVENT.WEBHOOK_PAYLOAD_MISMATCH, fields: differences },
          'duplicate id, different payload',
        );
      }

      const neverEnqueued =
        transaction.status === TRANSACTION_STATUS.PROCESSING && transaction.enqueuedAt === null;
      if (neverEnqueued && transaction.ageSeconds >= settings.repairGraceSeconds) {
        // An earlier attempt stored the row but failed to queue it: heal it now.
        await enqueue(payload.transactionId, settings.processDelaySeconds);
        log.warn(
          { event: LOG_EVENT.WEBHOOK_REENQUEUED },
          'duplicate webhook repaired a missing queue message',
        );
      } else {
        log.info({ event: LOG_EVENT.WEBHOOK_DUPLICATE }, 'duplicate webhook ignored');
      }
      return { duplicate: true };
    },

    /**
     * Query endpoint shape: an array (empty when unknown).
     * @param {string} transactionId
     */
    async getTransaction(transactionId) {
      const transaction = await repository.findById(transactionId);
      return transaction ? [toPublicTransaction(transaction)] : [];
    },

    /**
     * Worker entry point; safe under at-least-once delivery and concurrent duplicates.
     * Retryable errors are rethrown so the queue redelivers; on the final attempt the row is
     * marked FAILED first (and the error is still rethrown so the message lands in the DLQ).
     *
     * @param {{ transactionId: string, isFinalAttempt: boolean }} job
     * @returns {Promise<'processed' | 'already_done'>}
     */
    async processTransaction({ transactionId, isFinalAttempt }) {
      const log = logger.child({ transaction_id: transactionId });
      try {
        const outcome = await repository.processWithLock(transactionId, processor);
        log.info({
          event:
            outcome === PROCESS_OUTCOME.PROCESSED
              ? LOG_EVENT.TXN_PROCESSED
              : LOG_EVENT.TXN_ALREADY_DONE,
        });
        return outcome;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await repository.recordFailure(transactionId, message, { final: isFinalAttempt });
        log.error(
          { event: isFinalAttempt ? LOG_EVENT.TXN_FAILED : LOG_EVENT.TXN_RETRY, err },
          'transaction processing failed',
        );
        throw err;
      }
    },

    /**
     * Reconciler: re-queue transactions whose message was never sent or has gone missing.
     * Always safe — processing is idempotent — so duplicates cost nothing.
     *
     * @param {{ olderThanSeconds: number, retryingOlderThanSeconds?: number, limit: number }} opts
     *        `retryingOlderThanSeconds` applies to transactions already attempted at least once
     *        (their message is still cycling through queue retries). Defaults to `olderThanSeconds`.
     * @returns {Promise<{ found: number, reenqueued: number }>}
     */
    async reenqueueStuck({ olderThanSeconds, retryingOlderThanSeconds = olderThanSeconds, limit }) {
      const stuck = await repository.findStuck({
        olderThanSeconds,
        retryingOlderThanSeconds,
        limit,
      });

      let reenqueued = 0;
      for (const transaction of stuck) {
        try {
          await enqueue(transaction.transactionId, 0);
          reenqueued += 1;
          logger.warn({
            event: LOG_EVENT.RECONCILER_REENQUEUED,
            transaction_id: transaction.transactionId,
          });
        } catch (err) {
          // Keep going: one bad row must not block the rest. It is retried on the next run.
          logger.error({
            event: LOG_EVENT.RECONCILER_ENQUEUE_FAILED,
            transaction_id: transaction.transactionId,
            err,
          });
        }
      }
      return { found: stuck.length, reenqueued };
    },
  };
}
