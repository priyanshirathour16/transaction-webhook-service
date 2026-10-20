import { LOG_EVENT } from '#src/constants/log-events.js';
import { getContainer } from '#src/container.js';
import { getLogger } from '#src/infrastructure/logging/logger.js';
import { decodeJobMessage } from '#src/infrastructure/queue/job-message.js';

// Stop starting new records when this little time is left; the rest are handed back to SQS.
const MIN_REMAINING_MS = 2_000;

/**
 * SQS-triggered worker. Reports failures per record (`batchItemFailures`), so a bad message never
 * forces its healthy neighbours to be redelivered. Requires `ReportBatchItemFailures` on the
 * event source mapping. A record that keeps failing is retried by SQS and, after the queue's
 * `maxReceiveCount`, moved to the dead-letter queue.
 *
 * Records are processed one at a time: each holds the single pooled DB connection for its
 * duration, and this keeps per-container load on the database predictable.
 *
 * @param {{
 *   transactionsService: Pick<import('#src/modules/transactions/transactions.service.js').TransactionsService, 'processTransaction'>,
 *   logger: import('pino').Logger,
 *   maxReceiveCount: number,
 * }} deps
 */
export function createWorkerHandler({ transactionsService, logger, maxReceiveCount }) {
  return async (event, context) => {
    const records = event?.Records ?? [];
    /** @type {{ itemIdentifier: string }[]} */
    const batchItemFailures = [];
    const hasTimeLeft = () =>
      (context?.getRemainingTimeInMillis?.() ?? Infinity) > MIN_REMAINING_MS;

    for (const record of records) {
      const messageId = record.messageId;

      if (!hasTimeLeft()) {
        logger.warn({ event: LOG_EVENT.WORKER_OUT_OF_TIME, message_id: messageId });
        batchItemFailures.push({ itemIdentifier: messageId });
        continue;
      }

      let transactionId;
      try {
        ({ transactionId } = decodeJobMessage(record.body));
      } catch (err) {
        // A poison message can never succeed; report it so SQS routes it to the DLQ after its retries.
        logger.error({ event: LOG_EVENT.WORKER_MALFORMED_MESSAGE, message_id: messageId, err });
        batchItemFailures.push({ itemIdentifier: messageId });
        continue;
      }

      const receiveCount = Number(record.attributes?.ApproximateReceiveCount ?? 1);
      try {
        await transactionsService.processTransaction({
          transactionId,
          isFinalAttempt: receiveCount >= maxReceiveCount,
        });
      } catch {
        // The service has already logged the cause and updated the row; just hand it back to SQS.
        batchItemFailures.push({ itemIdentifier: messageId });
      }
    }

    return { batchItemFailures };
  };
}

/** @type {ReturnType<typeof createWorkerHandler> | undefined} */
let instance;

export const handler = (event, context) => {
  if (!instance) {
    const { config, transactionsService } = getContainer();
    instance = createWorkerHandler({
      transactionsService,
      logger: getLogger(),
      maxReceiveCount: config.MAX_RECEIVE_COUNT,
    });
  }
  return instance(event, context);
};
