/**
 * Local development server: the real app + real Postgres, with the in-memory queue standing in
 * for SQS (delayed delivery to the same processing code the worker Lambda uses).
 *
 *   npm run db:up && npm run migrate && npm run dev
 *
 * Tip: set PROCESS_DELAY_SECONDS=5 in .env for quicker feedback.
 */
import { existsSync } from 'node:fs';
import { createApp } from '#src/app.js';
import { parseConfig } from '#src/config/env.js';
import { LOG_EVENT } from '#src/constants/log-events.js';
import { buildContainer } from '#src/container.js';
import { closePool } from '#src/infrastructure/database/postgres-pool.js';
import { getLogger } from '#src/infrastructure/logging/logger.js';

const RECONCILE_INTERVAL_MS = 30_000;

if (existsSync('.env')) process.loadEnvFile('.env');

const config = parseConfig({ ...process.env, QUEUE_DRIVER: 'memory' });
const { queue, transactionsService } = buildContainer(config);
const logger = getLogger();
const port = Number(process.env.PORT ?? 3000);

// Deliver queued jobs to the same processing code the worker Lambda runs.
queue.subscribe(
  ({ transactionId, receiveCount }) =>
    transactionsService
      .processTransaction({
        transactionId,
        isFinalAttempt: receiveCount >= config.MAX_RECEIVE_COUNT,
      })
      .catch(() => undefined), // already logged by the service; a real queue would retry
);

// The in-memory queue forgets everything on restart; the reconciler re-queues what it dropped.
const reconcile = () =>
  transactionsService
    .reenqueueStuck({
      olderThanSeconds: config.RECONCILE_AFTER_SECONDS,
      retryingOlderThanSeconds: config.RECONCILE_RETRYING_AFTER_SECONDS,
      limit: config.RECONCILE_BATCH_SIZE,
    })
    .catch((err) => logger.error({ err }, 'reconcile failed'));
reconcile();
const reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);

const app = createApp({
  transactionsService,
  logger,
  webhookSecret: config.WEBHOOK_SECRET,
});

const server = await new Promise((resolve, reject) => {
  const listening = app.listen(port, '0.0.0.0', () => resolve(listening));
  listening.once('error', reject);
});
logger.info({
  event: LOG_EVENT.DEV_SERVER_LISTENING,
  port,
  process_delay_seconds: config.PROCESS_DELAY_SECONDS,
});

function shutdown() {
  clearInterval(reconcileTimer);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
