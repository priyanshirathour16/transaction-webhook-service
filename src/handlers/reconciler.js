import { LOG_EVENT } from '#src/constants/log-events.js';
import { getContainer } from '#src/container.js';
import { getLogger } from '#src/infrastructure/logging/logger.js';

/**
 * Scheduled self-healing (EventBridge): re-queues transactions that were stored but never queued,
 * or whose queue message went missing. Re-queuing is always safe because processing is
 * idempotent. Its regular database activity also keeps a free Supabase project from pausing.
 *
 * Throws if any re-queue failed, so the failure shows up in the function's error metric (and
 * alarm); the next run retries those rows anyway.
 *
 * @param {{
 *   transactionsService: Pick<import('#src/modules/transactions/transactions.service.js').TransactionsService, 'reenqueueStuck'>,
 *   logger: import('pino').Logger,
 *   olderThanSeconds: number,
 *   retryingOlderThanSeconds?: number,
 *   batchSize: number,
 * }} deps
 */
export function createReconcilerHandler({
  transactionsService,
  logger,
  olderThanSeconds,
  retryingOlderThanSeconds,
  batchSize,
}) {
  return async () => {
    const result = await transactionsService.reenqueueStuck({
      olderThanSeconds,
      retryingOlderThanSeconds,
      limit: batchSize,
    });
    logger.info({ event: LOG_EVENT.RECONCILER_RUN, ...result });

    if (result.reenqueued < result.found) {
      throw new Error(`Re-queued ${result.reenqueued} of ${result.found} stuck transactions`);
    }
    return result;
  };
}

/** @type {ReturnType<typeof createReconcilerHandler> | undefined} */
let instance;

export const handler = (event, context) => {
  if (!instance) {
    const { config, transactionsService } = getContainer();
    instance = createReconcilerHandler({
      transactionsService,
      logger: getLogger(),
      olderThanSeconds: config.RECONCILE_AFTER_SECONDS,
      retryingOlderThanSeconds: config.RECONCILE_RETRYING_AFTER_SECONDS,
      batchSize: config.RECONCILE_BATCH_SIZE,
    });
  }
  return instance(event, context);
};
