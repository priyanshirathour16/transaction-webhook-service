import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '#src/infrastructure/database/migrator.js';
import { createInMemoryJobQueue } from '#src/infrastructure/queue/in-memory-job-queue.js';
import { createTransactionsRepository } from '#src/modules/transactions/transactions.repository.js';
import { createTransactionsService } from '#src/modules/transactions/transactions.service.js';
import { createTestPool, resetSchema } from '#tests/helpers/database.js';
import { createRecordingLogger } from '#tests/helpers/logger.js';

const payload = {
  transactionId: 'txn_abc123def456',
  sourceAccount: 'acc_user_789',
  destinationAccount: 'acc_merchant_456',
  amount: 1500,
  currency: 'INR',
};

/** @type {import('pg').Pool} */
let pool;
let queue;
let logger;
let processorCalls;
let processorImpl;
let service;

function buildService(overrides = {}) {
  queue = createInMemoryJobQueue();
  logger = createRecordingLogger();
  processorCalls = [];
  processorImpl = async () => {};
  service = createTransactionsService({
    repository: createTransactionsRepository(pool),
    queue,
    processor: async (txn) => {
      processorCalls.push(txn.transactionId);
      await processorImpl(txn);
    },
    logger,
    settings: { processDelaySeconds: 30, repairGraceSeconds: 10, ...overrides },
  });
}

const row = async (id = payload.transactionId) =>
  (await pool.query('SELECT * FROM transactions WHERE transaction_id = $1', [id])).rows[0];
const count = async () =>
  Number((await pool.query('SELECT count(*) FROM transactions')).rows[0].count);
const events = (level) =>
  logger.records.filter((r) => r.level === level).map((r) => r.fields.event);

beforeAll(async () => {
  pool = await createTestPool(10);
  await resetSchema(pool);
  await runMigrations(pool, resolve('migrations'));
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE transactions');
  buildService();
});

describe('receiveWebhook', () => {
  it('stores a new transaction and queues one job delayed by 30 s', async () => {
    const result = await service.receiveWebhook(payload);

    expect(result).toEqual({ duplicate: false });
    expect(queue.messages).toEqual([{ transactionId: payload.transactionId, delaySeconds: 30 }]);
    const stored = await row();
    expect(stored).toMatchObject({ status: 'PROCESSING', processed_at: null, currency: 'INR' });
    expect(stored.enqueued_at).not.toBeNull();
    expect(Number(stored.amount)).toBe(1500);
  });

  it('treats a repeat as a no-op: no error, no second row, no second job', async () => {
    await service.receiveWebhook(payload);
    const second = await service.receiveWebhook(payload);

    expect(second).toEqual({ duplicate: true });
    expect(await count()).toBe(1);
    expect(queue.messages).toHaveLength(1);
    expect(events('info')).toContain('webhook.duplicate');
  });

  it('50 simultaneous identical webhooks produce exactly one row and one job', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => service.receiveWebhook(payload)),
    );

    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(49);
    expect(await count()).toBe(1);
    expect(queue.messages).toHaveLength(1);
  });

  it('keeps the first payload when the same id arrives with different data, and warns', async () => {
    await service.receiveWebhook(payload);
    await service.receiveWebhook({
      ...payload,
      destinationAccount: 'acc_other',
      amount: 9999,
      currency: 'USD',
    });

    const stored = await row();
    expect(Number(stored.amount)).toBe(1500);
    expect(stored.currency).toBe('INR');
    const mismatch = logger.records.find((r) => r.fields.event === 'webhook.payload_mismatch');
    expect(mismatch.level).toBe('warn');
    expect(mismatch.fields.fields).toEqual(['destination_account', 'amount', 'currency']);
  });

  it('logs through the request-scoped logger when one is supplied', async () => {
    const requestLogger = createRecordingLogger();

    await service.receiveWebhook(payload, { logger: requestLogger });

    expect(requestLogger.records).toEqual([
      expect.objectContaining({
        level: 'info',
        fields: expect.objectContaining({
          event: 'webhook.accepted',
          transaction_id: payload.transactionId,
        }),
      }),
    ]);
    expect(logger.records).toHaveLength(0); // nothing went to the default logger
  });

  it('preserves decimal amounts exactly', async () => {
    await service.receiveWebhook({ ...payload, transactionId: 'txn_dec', amount: 150.5 });
    expect((await row('txn_dec')).amount).toBe('150.5000');
  });

  describe('when the queue is down', () => {
    it('rejects (so the caller can answer 5xx) but keeps the transaction stored', async () => {
      queue.failNextSend(new Error('SQS unavailable'));

      await expect(service.receiveWebhook(payload)).rejects.toThrow('SQS unavailable');

      const stored = await row();
      expect(stored.status).toBe('PROCESSING');
      expect(stored.enqueued_at).toBeNull();
      expect(queue.messages).toHaveLength(0);
    });

    it("the sender's retry repairs the missing job, exactly once", async () => {
      buildService({ repairGraceSeconds: 0 });
      queue.failNextSend(new Error('SQS unavailable'));
      await expect(service.receiveWebhook(payload)).rejects.toThrow();

      const retry = await service.receiveWebhook(payload);
      const another = await service.receiveWebhook(payload);

      expect(retry).toEqual({ duplicate: true });
      expect(another).toEqual({ duplicate: true });
      expect(queue.messages).toEqual([{ transactionId: payload.transactionId, delaySeconds: 30 }]);
      expect((await row()).enqueued_at).not.toBeNull();
      expect(events('warn')).toContain('webhook.reenqueued');
    });

    it('a duplicate inside the grace window does not race the original request', async () => {
      queue.failNextSend(new Error('SQS unavailable'));
      await expect(service.receiveWebhook(payload)).rejects.toThrow();

      await service.receiveWebhook(payload); // default grace is 10 s; row is brand new

      expect(queue.messages).toHaveLength(0); // left to the reconciler / a later retry
    });
  });
});

describe('getTransaction', () => {
  it('returns the documented array shape', async () => {
    await service.receiveWebhook(payload);

    const result = await service.getTransaction(payload.transactionId);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      transaction_id: 'txn_abc123def456',
      source_account: 'acc_user_789',
      destination_account: 'acc_merchant_456',
      amount: 1500,
      currency: 'INR',
      status: 'PROCESSING',
      processed_at: null,
    });
    expect(new Date(result[0].created_at).toISOString()).toBe(result[0].created_at);
  });

  it('returns an empty array for an unknown id', async () => {
    expect(await service.getTransaction('txn_missing')).toEqual([]);
  });
});

describe('processTransaction', () => {
  beforeEach(async () => {
    await service.receiveWebhook(payload);
  });
  const job = (isFinalAttempt = false) => ({
    transactionId: payload.transactionId,
    isFinalAttempt,
  });

  it('marks the transaction PROCESSED and stamps processed_at', async () => {
    expect(await service.processTransaction(job())).toBe('processed');

    const stored = await row();
    expect(stored.status).toBe('PROCESSED');
    expect(stored.processed_at).toBeInstanceOf(Date);
    expect(stored.attempts).toBe(1);
    expect(processorCalls).toEqual([payload.transactionId]);

    const [view] = await service.getTransaction(payload.transactionId);
    expect(view.status).toBe('PROCESSED');
    expect(view.processed_at).not.toBeNull();
  });

  it('is idempotent: redelivery does not run the processor again', async () => {
    await service.processTransaction(job());
    const firstProcessedAt = (await row()).processed_at;

    expect(await service.processTransaction(job())).toBe('already_done');

    expect(processorCalls).toHaveLength(1);
    expect((await row()).processed_at).toEqual(firstProcessedAt);
  });

  it('concurrent deliveries run the processor exactly once', async () => {
    processorImpl = () => new Promise((done) => setTimeout(done, 50));

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => service.processTransaction(job())),
    );

    expect(outcomes.filter((o) => o === 'processed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already_done')).toHaveLength(4);
    expect(processorCalls).toHaveLength(1);
  });

  it('on a retryable failure: rethrows, rolls back, stays PROCESSING for the retry', async () => {
    processorImpl = async () => {
      throw new Error('gateway timeout');
    };

    await expect(service.processTransaction(job())).rejects.toThrow('gateway timeout');

    const stored = await row();
    expect(stored).toMatchObject({ status: 'PROCESSING', processed_at: null, attempts: 1 });
    expect(stored.last_error).toBe('gateway timeout');
    expect(events('error')).toContain('txn.retry');

    processorImpl = async () => {};
    expect(await service.processTransaction(job())).toBe('processed');
    expect((await row()).last_error).toBeNull();
  });

  it('on the final attempt: marks FAILED and still rethrows so the message reaches the DLQ', async () => {
    processorImpl = async () => {
      throw new Error('permanent failure');
    };

    await expect(service.processTransaction(job(true))).rejects.toThrow('permanent failure');

    expect(await row()).toMatchObject({ status: 'FAILED', processed_at: null });
    expect(events('error')).toContain('txn.failed');
    expect((await service.getTransaction(payload.transactionId))[0].status).toBe('FAILED');
  });

  it('rejects an unknown transaction so the message is retried, not silently dropped', async () => {
    await expect(
      service.processTransaction({ transactionId: 'txn_ghost', isFinalAttempt: false }),
    ).rejects.toThrow(/not found/);
  });
});

describe('reenqueueStuck (reconciler)', () => {
  const backdate = (id, enqueuedSecondsAgo) =>
    pool.query(
      `UPDATE transactions
       SET created_at = now() - make_interval(secs => $2),
           enqueued_at = now() - make_interval(secs => $2)
       WHERE transaction_id = $1`,
      [id, enqueuedSecondsAgo],
    );

  it('re-queues only in-flight rows whose last enqueue is old enough', async () => {
    await service.receiveWebhook({ ...payload, transactionId: 'txn_fresh' });
    await service.receiveWebhook({ ...payload, transactionId: 'txn_stuck' });
    await service.receiveWebhook({ ...payload, transactionId: 'txn_done' });
    await service.processTransaction({ transactionId: 'txn_done', isFinalAttempt: false });
    await backdate('txn_stuck', 600);
    await backdate('txn_done', 600);
    queue.messages.length = 0;

    const result = await service.reenqueueStuck({ olderThanSeconds: 120, limit: 100 });

    expect(result).toEqual({ found: 1, reenqueued: 1 });
    expect(queue.messages).toEqual([{ transactionId: 'txn_stuck', delaySeconds: 0 }]);

    // Its enqueued_at was refreshed, so the next run leaves it alone.
    expect(await service.reenqueueStuck({ olderThanSeconds: 120, limit: 100 })).toEqual({
      found: 0,
      reenqueued: 0,
    });
  });

  it('picks up a row that was stored but never queued', async () => {
    queue.failNextSend(new Error('SQS unavailable'));
    await expect(service.receiveWebhook(payload)).rejects.toThrow();
    await pool.query(
      "UPDATE transactions SET created_at = now() - interval '10 minutes' WHERE transaction_id = $1",
      [payload.transactionId],
    );

    const result = await service.reenqueueStuck({ olderThanSeconds: 120, limit: 100 });

    expect(result).toEqual({ found: 1, reenqueued: 1 });
    expect(queue.messages).toEqual([{ transactionId: payload.transactionId, delaySeconds: 0 }]);
  });

  it('continues past a failing enqueue and retries it on the next run', async () => {
    await service.receiveWebhook({ ...payload, transactionId: 'txn_a' });
    await service.receiveWebhook({ ...payload, transactionId: 'txn_b' });
    await backdate('txn_a', 600);
    await backdate('txn_b', 600);
    queue.messages.length = 0;
    queue.failNextSend(new Error('throttled'));

    const result = await service.reenqueueStuck({ olderThanSeconds: 120, limit: 100 });

    expect(result).toEqual({ found: 2, reenqueued: 1 });
    expect(events('error')).toContain('reconciler.enqueue_failed');
  });

  it('leaves a transaction alone while its message is still cycling through SQS retries', async () => {
    await service.receiveWebhook(payload);
    await backdate(payload.transactionId, 600);
    await pool.query('UPDATE transactions SET attempts = 2 WHERE transaction_id = $1', [
      payload.transactionId,
    ]);
    queue.messages.length = 0;
    const opts = { olderThanSeconds: 120, retryingOlderThanSeconds: 1800, limit: 100 };

    // 10 minutes old: stuck for a never-attempted row, but not for one that has been retrying.
    expect(await service.reenqueueStuck(opts)).toEqual({ found: 0, reenqueued: 0 });
    expect(queue.messages).toHaveLength(0);

    // Once it exceeds the longer threshold the message is presumed lost.
    await backdate(payload.transactionId, 3600);
    expect(await service.reenqueueStuck(opts)).toEqual({ found: 1, reenqueued: 1 });
  });

  it('respects the batch limit', async () => {
    for (const id of ['txn_1', 'txn_2', 'txn_3']) {
      await service.receiveWebhook({ ...payload, transactionId: id });
      await backdate(id, 600);
    }
    queue.messages.length = 0;

    const result = await service.reenqueueStuck({ olderThanSeconds: 120, limit: 2 });

    expect(result).toEqual({ found: 2, reenqueued: 2 });
  });
});
