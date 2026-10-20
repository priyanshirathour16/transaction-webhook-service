import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '#src/app.js';
import { runMigrations } from '#src/infrastructure/database/migrator.js';
import { createInMemoryJobQueue } from '#src/infrastructure/queue/in-memory-job-queue.js';
import { simulateExternalCall } from '#src/modules/transactions/transactions.processor.js';
import { createTransactionsRepository } from '#src/modules/transactions/transactions.repository.js';
import { createTransactionsService } from '#src/modules/transactions/transactions.service.js';
import { createTestPool, resetSchema } from '#tests/helpers/database.js';
import { createSilentLogger } from '#tests/helpers/logger.js';
import { runLoadTest } from '../../../scripts/load-test.js';
import { runSmokeTest } from '../../../scripts/smoke-test.js';

/**
 * The smoke and load scripts are the tools used against the deployed stack, so they are tested
 * here against a real HTTP server running the real app, with signatures enforced and a 1 s
 * processing delay standing in for the production 30 s.
 */
const SECRET = 'integration-secret-value';
let pool;
let server;
let baseUrl;

const quietLog = () => {};

function listen(requestListener) {
  return new Promise((resolveListening) => {
    const instance = createServer(requestListener);
    instance.listen(0, '127.0.0.1', () => resolveListening(instance));
  });
}
const urlOf = (instance) => `http://127.0.0.1:${instance.address().port}`;

beforeAll(async () => {
  pool = await createTestPool(10);
  await resetSchema(pool);
  await runMigrations(pool, resolve('migrations'));

  const queue = createInMemoryJobQueue();
  const transactionsService = createTransactionsService({
    repository: createTransactionsRepository(pool),
    queue,
    processor: simulateExternalCall,
    logger: createSilentLogger(),
    settings: { processDelaySeconds: 1, repairGraceSeconds: 10 },
  });
  queue.subscribe(({ transactionId }) =>
    transactionsService.processTransaction({ transactionId, isFinalAttempt: false }),
  );

  server = await listen(
    createApp({
      transactionsService,
      logger: createSilentLogger(),
      webhookSecret: SECRET,
    }),
  );
  baseUrl = urlOf(server);
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await pool.end();
});

describe('smoke-test script', () => {
  it('passes against a healthy service, covering all four success criteria', async () => {
    const result = await runSmokeTest({
      baseUrl,
      secret: SECRET,
      expectedDelaySeconds: 1,
      pollIntervalMs: 100,
      log: quietLog,
    });

    const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
    expect(failed).toEqual([]);
    expect(result.passed).toBe(true);
    // Sanity: it really ran each section, not just a few checks.
    expect(result.checks.length).toBeGreaterThanOrEqual(20);
    expect(result.latency.count).toBe(35);
  }, 60_000);

  it('detects a service that enforces signatures when no secret is supplied', async () => {
    const result = await runSmokeTest({
      baseUrl,
      expectedDelaySeconds: 1,
      sequentialRequests: 1,
      concurrentRequests: 1,
      pollIntervalMs: 50,
      log: quietLog,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'webhook accepted with 202').ok).toBe(false);
  }, 60_000);

  it('FAILS against a broken service, so a green run actually means something', async () => {
    const broken = await listen((_req, res) => {
      res.statusCode = 500;
      res.end('{"error":"down"}');
    });
    try {
      const result = await runSmokeTest({
        baseUrl: urlOf(broken),
        expectedDelaySeconds: 1,
        sequentialRequests: 2,
        concurrentRequests: 1,
        pollIntervalMs: 20,
        log: quietLog,
      });

      expect(result.passed).toBe(false);
      expect(result.checks.filter((c) => !c.ok).length).toBeGreaterThan(5);
    } finally {
      await new Promise((done) => broken.close(done));
    }
  }, 120_000);

  it('FAILS when the service is unreachable', async () => {
    const closed = await listen(() => {});
    const url = urlOf(closed);
    await new Promise((done) => closed.close(done));

    const result = await runSmokeTest({
      baseUrl: url,
      expectedDelaySeconds: 1,
      sequentialRequests: 1,
      concurrentRequests: 1,
      pollIntervalMs: 20,
      log: quietLog,
    });

    expect(result.passed).toBe(false);
  }, 120_000);
});

describe('load-test script', () => {
  it('sends every request, all accepted, and reports sane statistics', async () => {
    const result = await runLoadTest({
      baseUrl,
      secret: SECRET,
      connections: 4,
      requests: 80,
      log: quietLog,
    });

    expect(result.passed).toBe(true);
    expect(result.statuses).toEqual({ 202: 80 });
    expect(result.summary.count).toBe(80);
    expect(result.summary.p50).toBeLessThanOrEqual(result.summary.p95);
    expect(result.summary.p95).toBeLessThanOrEqual(result.summary.max);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM transactions WHERE transaction_id LIKE 'load_%'",
    );
    expect(rows[0].n).toBe(80); // every unique request created exactly one transaction
  }, 60_000);

  it('fails when requests are rejected', async () => {
    const result = await runLoadTest({
      baseUrl, // no secret supplied → every webhook is rejected with 401
      connections: 2,
      requests: 6,
      log: quietLog,
    });

    expect(result.passed).toBe(false);
    expect(result.statuses).toEqual({ 401: 6 });
  }, 60_000);

  it('fails when the latency budget is exceeded', async () => {
    const result = await runLoadTest({
      baseUrl,
      secret: SECRET,
      connections: 2,
      requests: 10,
      maxP95Ms: 0.0001, // impossible on purpose
      log: quietLog,
    });

    expect(result.passed).toBe(false);
  }, 60_000);
});
