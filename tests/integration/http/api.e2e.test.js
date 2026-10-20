import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '#src/app.js';
import { sendRequest } from '#tests/helpers/http.js';
import { runMigrations } from '#src/infrastructure/database/migrator.js';
import { createInMemoryJobQueue } from '#src/infrastructure/queue/in-memory-job-queue.js';
import { simulateExternalCall } from '#src/modules/transactions/transactions.processor.js';
import { createTransactionsRepository } from '#src/modules/transactions/transactions.repository.js';
import { createTransactionsService } from '#src/modules/transactions/transactions.service.js';
import { createTestPool, resetSchema } from '#tests/helpers/database.js';
import { createRecordingLogger } from '#tests/helpers/logger.js';

/**
 * Whole stack except SQS: HTTP app → service → Postgres, with the in-memory queue delivering
 * to the same processing code the worker uses. The 30 s delay is shortened to 0 for speed;
 * the delay value itself is asserted on the queue message.
 */
const webhook = {
  transaction_id: 'txn_abc123def456',
  source_account: 'acc_user_789',
  destination_account: 'acc_merchant_456',
  amount: 150.5,
  currency: 'USD',
};

let pool;
let app;
let queue;

async function build(delaySeconds) {
  queue = createInMemoryJobQueue();
  const service = createTransactionsService({
    repository: createTransactionsRepository(pool),
    queue,
    processor: simulateExternalCall,
    logger: createRecordingLogger(),
    settings: { processDelaySeconds: delaySeconds, repairGraceSeconds: 10 },
  });
  queue.subscribe(({ transactionId }) =>
    service.processTransaction({ transactionId, isFinalAttempt: false }),
  );
  app = createApp({ transactionsService: service, logger: createRecordingLogger() });
}

const post = (payload) =>
  sendRequest(app, { method: 'POST', url: '/v1/webhooks/transactions', payload });
const get = (id) => sendRequest(app, { method: 'GET', url: `/v1/transactions/${id}` });

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

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
});

describe('success criteria', () => {
  it('1. single transaction: 202 now, PROCESSING, then PROCESSED with processed_at', async () => {
    await build(0);
    const accepted = await post(webhook);
    expect(accepted.statusCode).toBe(202);

    const processed = await waitFor(async () => {
      const res = await get(webhook.transaction_id);
      return res.json()[0].status === 'PROCESSED' ? res.json()[0] : null;
    });

    expect(processed).toMatchObject({
      transaction_id: 'txn_abc123def456',
      source_account: 'acc_user_789',
      destination_account: 'acc_merchant_456',
      amount: 150.5,
      currency: 'USD',
      status: 'PROCESSED',
    });
    expect(new Date(processed.processed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(processed.created_at).getTime(),
    );
  });

  it('1b. is PROCESSING with processed_at null until the delayed job runs', async () => {
    await build(30); // the job is queued 30 s out and never runs inside this test
    await post(webhook);

    const [txn] = (await get(webhook.transaction_id)).json();
    expect(txn).toMatchObject({ status: 'PROCESSING', processed_at: null });
    expect(queue.messages).toEqual([{ transactionId: webhook.transaction_id, delaySeconds: 30 }]);
  });

  it('2. duplicates: 30 simultaneous identical webhooks → all 202, one transaction, one job', async () => {
    await build(30);
    const responses = await Promise.all(Array.from({ length: 30 }, () => post(webhook)));

    expect(responses.map((r) => r.statusCode)).toEqual(Array(30).fill(202));
    expect(responses.filter((r) => r.json().duplicate === false)).toHaveLength(1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM transactions');
    expect(rows[0].n).toBe(1);
    expect(queue.messages).toHaveLength(1);
  });

  it('2b. a duplicate sent after processing does not reprocess or change the record', async () => {
    await build(0);
    await post(webhook);
    const first = await waitFor(async () => {
      const [txn] = (await get(webhook.transaction_id)).json();
      return txn.status === 'PROCESSED' ? txn : null;
    });

    const again = await post(webhook);
    expect(again.statusCode).toBe(202);
    expect(again.json().duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 100));

    const [after] = (await get(webhook.transaction_id)).json();
    expect(after.processed_at).toBe(first.processed_at);
    expect(queue.messages).toHaveLength(1);
  });

  it('3. stays fast while the background workers are busy', async () => {
    // Mirrors the deployment: each Lambda container owns ONE database connection and serves one
    // request at a time, while workers run in other containers with their own connections.
    const apiPool = await createTestPool(1);
    const workerPool = await createTestPool(5);
    try {
      const apiQueue = createInMemoryJobQueue();
      const apiService = createTransactionsService({
        repository: createTransactionsRepository(apiPool),
        queue: apiQueue,
        processor: simulateExternalCall,
        logger: createRecordingLogger(),
        settings: { processDelaySeconds: 30, repairGraceSeconds: 10 },
      });
      const loadApp = createApp({
        transactionsService: apiService,
        logger: createRecordingLogger(),
      });
      const workerService = createTransactionsService({
        repository: createTransactionsRepository(workerPool),
        queue: createInMemoryJobQueue(),
        processor: () => new Promise((done) => setTimeout(done, 20)), // a slow "external API"
        logger: createRecordingLogger(),
        settings: { processDelaySeconds: 30, repairGraceSeconds: 10 },
      });

      // Background load: 300 queued transactions drained by 5 concurrent workers.
      const backlog = Array.from({ length: 300 }, (_, i) => `txn_backlog_${i}`);
      await pool.query(
        `INSERT INTO transactions (transaction_id, source_account, destination_account, amount, currency)
         SELECT 'txn_backlog_' || n, 'a', 'b', 1, 'INR' FROM generate_series(0, 299) AS n`,
      );
      const next = backlog[Symbol.iterator]();
      const drain = async () => {
        for (let step = next.next(); !step.done; step = next.next()) {
          await workerService.processTransaction({
            transactionId: step.value,
            isFinalAttempt: false,
          });
        }
      };
      const background = Promise.all(Array.from({ length: 5 }, drain));

      const timings = [];
      for (let i = 0; i < 100; i += 1) {
        const started = performance.now();
        const res = await sendRequest(loadApp, {
          method: 'POST',
          url: '/v1/webhooks/transactions',
          payload: { ...webhook, transaction_id: `txn_load_${i}` },
        });
        timings.push(performance.now() - started);
        expect(res.statusCode).toBe(202);
      }
      await background;

      timings.sort((a, b) => a - b);
      const p95 = timings[Math.floor(timings.length * 0.95) - 1];
      expect(p95).toBeLessThan(500);
      const { rows } = await pool.query(
        "SELECT count(*) FILTER (WHERE status = 'PROCESSED')::int AS done FROM transactions WHERE transaction_id LIKE 'txn_backlog_%'",
      );
      expect(rows[0].done).toBe(300); // the load really was processed meanwhile
    } finally {
      await apiPool.end();
      await workerPool.end();
    }
  }, 30_000);

  it('3b. accepts a burst of 100 simultaneous distinct webhooks without error', async () => {
    await build(30);
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) => post({ ...webhook, transaction_id: `txn_burst_${i}` })),
    );
    expect(responses.every((r) => r.statusCode === 202)).toBe(true);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM transactions');
    expect(rows[0].n).toBe(100);
    expect(queue.messages).toHaveLength(100);
  });

  it('4. reliability: queue outage → 500 but nothing lost; reconciler recovers it', async () => {
    await build(0);
    queue.failNextSend(new Error('SQS unavailable'));

    const failed = await post(webhook);
    expect(failed.statusCode).toBe(500);
    const [stored] = (await get(webhook.transaction_id)).json();
    expect(stored.status).toBe('PROCESSING'); // durable even though the ack failed

    await pool.query(
      "UPDATE transactions SET created_at = now() - interval '10 minutes' WHERE transaction_id = $1",
      [webhook.transaction_id],
    );
    const service = createTransactionsService({
      repository: createTransactionsRepository(pool),
      queue,
      processor: simulateExternalCall,
      logger: createRecordingLogger(),
      settings: { processDelaySeconds: 0, repairGraceSeconds: 10 },
    });
    expect(await service.reenqueueStuck({ olderThanSeconds: 120, limit: 10 })).toEqual({
      found: 1,
      reenqueued: 1,
    });

    await waitFor(async () => (await get(webhook.transaction_id)).json()[0].status === 'PROCESSED');
  });
});

describe('queries', () => {
  it('returns 404 for an unknown transaction', async () => {
    await build(0);
    const res = await get('txn_unknown');
    expect(res.statusCode).toBe(404);
  });
});
