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
let app;
let distantServer; // the same app behind a proxy that adds network distance
let distantUrl;

// One-way "distance" added before the app even sees a request. The app's own Server-Timing is
// unaffected, but the client's end-to-end time grows by this much.
const NETWORK_DELAY_MS = 300;

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

  app = createApp({
    transactionsService,
    logger: createSilentLogger(),
    webhookSecret: SECRET,
  });
  server = await listen(app);
  baseUrl = urlOf(server);

  distantServer = await listen((req, res) => setTimeout(() => app(req, res), NETWORK_DELAY_MS));
  distantUrl = urlOf(distantServer);
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await new Promise((done) => distantServer.close(done));
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
    // Every response carried a Server-Timing header, and the server's own time is part of (so never
    // more than) what the client measured end to end.
    expect(result.serverSummary.count).toBe(80);
    expect(result.serverSummary.p95).toBeLessThanOrEqual(result.summary.p95);
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

describe('a client far from the service (network distance is not the server being slow)', () => {
  // Budget with a wide margin on both sides: far above the app's own time (a few ms, even on a
  // busy machine) and below the end-to-end time (>= NETWORK_DELAY_MS).
  const BUDGET_MS = 250;

  it('smoke test: passes on the server-side time and only WARNS about end-to-end time', async () => {
    const result = await runSmokeTest({
      baseUrl: distantUrl,
      secret: SECRET,
      expectedDelaySeconds: 1,
      maxAckMs: BUDGET_MS,
      sequentialRequests: 8,
      concurrentRequests: 2,
      pollIntervalMs: 100,
      log: quietLog,
    });

    const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
    expect(failed).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.checks.some((c) => c.name.startsWith('server-side p95'))).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/end-to-end p95 .*network travel/);
  }, 60_000);

  it('smoke test: --strict-e2e holds the end-to-end time to the budget and fails', async () => {
    const result = await runSmokeTest({
      baseUrl: distantUrl,
      secret: SECRET,
      expectedDelaySeconds: 1,
      maxAckMs: BUDGET_MS,
      strictEndToEnd: true,
      sequentialRequests: 8,
      concurrentRequests: 2,
      pollIntervalMs: 100,
      log: quietLog,
    });

    expect(result.passed).toBe(false);
    const failed = result.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual([expect.stringContaining('end-to-end p95')]);
  }, 60_000);

  it('smoke test: still fails when the SERVER is the slow part', async () => {
    const result = await runSmokeTest({
      baseUrl: distantUrl,
      secret: SECRET,
      expectedDelaySeconds: 1,
      maxAckMs: 0.5, // the app cannot answer in half a millisecond
      sequentialRequests: 4,
      concurrentRequests: 1,
      pollIntervalMs: 100,
      log: quietLog,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name.startsWith('server-side p95')).ok).toBe(false);
  }, 60_000);

  it('load test: gates on server-side time, and --strict-e2e adds the end-to-end gate', async () => {
    const lenient = await runLoadTest({
      baseUrl: distantUrl,
      secret: SECRET,
      connections: 2,
      requests: 10,
      maxP95Ms: BUDGET_MS,
      log: quietLog,
    });
    expect(lenient.passed).toBe(true);
    expect(lenient.summary.p95).toBeGreaterThanOrEqual(NETWORK_DELAY_MS);
    expect(lenient.serverSummary.p95).toBeLessThan(BUDGET_MS);

    const strict = await runLoadTest({
      baseUrl: distantUrl,
      secret: SECRET,
      connections: 2,
      requests: 10,
      maxP95Ms: BUDGET_MS,
      strictEndToEnd: true,
      log: quietLog,
    });
    expect(strict.passed).toBe(false);
  }, 60_000);
});
