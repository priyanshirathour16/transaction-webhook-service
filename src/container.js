import { SQSClient } from '@aws-sdk/client-sqs';
import { getConfig } from '#src/config/env.js';
import { getPool } from '#src/infrastructure/database/postgres-pool.js';
import { getLogger } from '#src/infrastructure/logging/logger.js';
import { createInMemoryJobQueue } from '#src/infrastructure/queue/in-memory-job-queue.js';
import { createSqsJobQueue } from '#src/infrastructure/queue/sqs-job-queue.js';
import { simulateExternalCall } from '#src/modules/transactions/transactions.processor.js';
import { createTransactionsRepository } from '#src/modules/transactions/transactions.repository.js';
import { createTransactionsService } from '#src/modules/transactions/transactions.service.js';

/** @type {ReturnType<typeof buildContainer> | undefined} */
let container;

/** Composition root: the only place concrete adapters are chosen. */
export function buildContainer(config = getConfig()) {
  const queue =
    config.QUEUE_DRIVER === 'sqs'
      ? createSqsJobQueue({ client: new SQSClient({}), queueUrl: config.QUEUE_URL })
      : createInMemoryJobQueue();

  const transactionsService = createTransactionsService({
    repository: createTransactionsRepository(getPool()),
    queue,
    processor: simulateExternalCall,
    logger: getLogger(),
    settings: {
      processDelaySeconds: config.PROCESS_DELAY_SECONDS,
      repairGraceSeconds: config.REPAIR_GRACE_SECONDS,
    },
  });

  return { config, queue, transactionsService };
}

/** Built once per Lambda container and reused by every warm invocation. */
export function getContainer() {
  container ??= buildContainer();
  return container;
}
