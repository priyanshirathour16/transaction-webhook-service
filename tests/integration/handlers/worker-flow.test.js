import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createReconcilerHandler } from '#src/handlers/reconciler.js';
import { createWorkerHandler } from '#src/handlers/worker.js';
import { runMigrations } from '#src/infrastructure/database/migrator.js';
import { createInMemoryJobQueue } from '#src/infrastructure/queue/in-memory-job-queue.js';
import { encodeJobMessage } from '#src/infrastructure/queue/job-message.js';
import { createTransactionsRepository } from '#src/modules/transactions/transactions.repository.js';
import { createTransactionsService } from '#src/modules/transactions/transactions.service.js';
import { createTestPool, resetSchema } from '#tests/helpers/database.js';
import { createRecordingLogger } from '#tests/helpers/logger.js';

const MAX_RECEIVE_COUNT = 5;
const payload = {
  transactionId: 'txn_abc123def456',
  sourceAccount: 'acc_user_789',
  destinationAccount: 'acc_merchant_456',
  amount: 1500,
  currency: 'INR',
};

let pool;
let queue;
let logger;
let processor;
let service;
let worker;

/**
 * Minimal SQS stand-in: redelivers records the handler reports as failed, with an increasing
 * ApproximateReceiveCount, and moves a message to `dlq` once it has used up its receives.
 * (Real SQS adds visibility-timeout waits, which don't change the logic being tested.)
 */
async function deliver(messages, { startingReceiveCount = 1 } = {}) {
  const dlq = [];
  let inFlight = messages.map((m, i) => ({
    ...m,
    messageId: `msg-${i}`,
    receives: startingReceiveCount - 1,
  }));
  while (inFlight.length > 0) {
    const batch = [];
    for (const m of inFlight) {
      if (m.receives >= MAX_RECEIVE_COUNT) dlq.push(m);
      else batch.push(m);
    }
    if (batch.length === 0) break;
    for (const m of batch) m.receives += 1;
    const { batchItemFailures } = await worker({
      Records: batch.map((m) => ({
        messageId: m.messageId,
        body: m.body,
        attributes: { ApproximateReceiveCount: String(m.receives) },
      })),
    });
    const failed = new Set(batchItemFailures.map((f) => f.itemIdentifier));
    inFlight = batch.filter((m) => failed.has(m.messageId));
  }
  return { dlq };
}

const row = async (id = payload.transactionId) =>
  (await pool.query('SELECT * FROM transactions WHERE transaction_id = $1', [id])).rows[0];
const job = (transactionId = payload.transactionId) => ({ body: encodeJobMessage(transactionId) });

beforeAll(async () => {
  pool = await createTestPool(5);
  await resetSchema(pool);
  await runMigrations(pool, resolve('migrations'));
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE transactions');
  queue = createInMemoryJobQueue();
  logger = createRecordingLogger();
  processor = async () => {};
  service = createTransactionsService({
    repository: createTransactionsRepository(pool),
    queue,
    processor: (txn) => processor(txn),
    logger,
    settings: { processDelaySeconds: 30, repairGraceSeconds: 10 },
  });
  worker = createWorkerHandler({
    transactionsService: service,
    logger,
    maxReceiveCount: MAX_RECEIVE_COUNT,
  });
  await service.receiveWebhook(payload);
});

describe('worker + real service + Postgres', () => {
  it('processes a delivered message and finishes the transaction', async () => {
    const { dlq } = await deliver([job()]);

    expect(dlq).toEqual([]);
    expect(await row()).toMatchObject({ status: 'PROCESSED', attempts: 1 });
  });

  it('survives SQS at-least-once delivery: the same message twice is harmless', async () => {
    let calls = 0;
    processor = async () => {
      calls += 1;
    };

    await deliver([job(), job()]);

    expect(calls).toBe(1);
    expect((await row()).status).toBe('PROCESSED');
  });

  it('retries a transient failure and succeeds on a later attempt', async () => {
    let attempt = 0;
    processor = async () => {
      attempt += 1;
      if (attempt < 3) throw new Error('gateway timeout');
    };

    const { dlq } = await deliver([job()]);

    expect(dlq).toEqual([]);
    expect(attempt).toBe(3);
    expect(await row()).toMatchObject({ status: 'PROCESSED', last_error: null });
  });

  it('a poison transaction is tried 5 times, marked FAILED, then dead-lettered', async () => {
    let attempts = 0;
    processor = async () => {
      attempts += 1;
      throw new Error('account closed');
    };

    const { dlq } = await deliver([job()]);

    expect(attempts).toBe(MAX_RECEIVE_COUNT);
    expect(dlq).toHaveLength(1);
    expect(await row()).toMatchObject({
      status: 'FAILED',
      processed_at: null,
      attempts: MAX_RECEIVE_COUNT,
      last_error: 'account closed',
    });
    expect((await service.getTransaction(payload.transactionId))[0].status).toBe('FAILED');
  });

  it('a DLQ redrive after the fix completes the FAILED transaction', async () => {
    processor = async () => {
      throw new Error('bug in processor');
    };
    const { dlq } = await deliver([job()]);
    expect((await row()).status).toBe('FAILED');

    processor = async () => {}; // the fix is deployed
    // Redrive: the DLQ message goes back to the main queue and is delivered afresh.
    const redrive = await deliver(dlq.map((m) => ({ body: m.body })));

    expect(redrive.dlq).toEqual([]);
    expect(await row()).toMatchObject({ status: 'PROCESSED', last_error: null });
    expect((await row()).processed_at).toBeInstanceOf(Date);
  });

  it('one poison message does not hold back the healthy ones in the same batch', async () => {
    await service.receiveWebhook({ ...payload, transactionId: 'txn_good' });
    processor = async (txn) => {
      if (txn.transactionId === payload.transactionId) throw new Error('bad');
    };

    const { dlq } = await deliver([job(), job('txn_good')]);

    expect(dlq).toHaveLength(1);
    expect((await row('txn_good')).status).toBe('PROCESSED');
    expect((await row()).status).toBe('FAILED');
  });

  it('a message for a missing transaction is retried then dead-lettered, never silently dropped', async () => {
    const { dlq } = await deliver([job('txn_ghost')]);
    expect(dlq).toHaveLength(1);
  });
});

describe('reconciler + worker: no transaction is lost', () => {
  it('recovers a transaction whose queue message was lost, end to end', async () => {
    // The webhook stored the row and a message was "sent", but the message vanished.
    await pool.query(
      "UPDATE transactions SET created_at = now() - interval '10 minutes', enqueued_at = now() - interval '10 minutes'",
    );
    queue.messages.length = 0;

    const reconcile = createReconcilerHandler({
      transactionsService: service,
      logger,
      olderThanSeconds: 120,
      batchSize: 100,
    });
    expect(await reconcile({ source: 'aws.events' })).toEqual({ found: 1, reenqueued: 1 });

    // The re-queued message flows through the worker like any other.
    await deliver(queue.messages.map((m) => job(m.transactionId)));
    expect((await row()).status).toBe('PROCESSED');

    // And a second run finds nothing to do.
    expect(await reconcile({ source: 'aws.events' })).toEqual({ found: 0, reenqueued: 0 });
  });
});
