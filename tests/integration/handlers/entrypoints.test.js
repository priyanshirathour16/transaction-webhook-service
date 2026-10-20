import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '#src/infrastructure/database/migrator.js';
import { createTestPool, getTestDatabaseUrl, resetSchema } from '#tests/helpers/database.js';

/**
 * The real Lambda entry points (`handler` exports), wired by the real container from environment
 * variables, talking to real Postgres. Only the queue is the in-memory stand-in for SQS.
 */
let pool;
let apiHandler;
let workerHandler;
let reconcilerHandler;
let closeAppPool;

const functionUrlEvent = (method, path, body) => ({
  version: '2.0',
  rawPath: path,
  rawQueryString: '',
  headers: { host: 'x.lambda-url.ap-south-1.on.aws', 'content-type': 'application/json' },
  requestContext: {
    http: { method, path, protocol: 'HTTP/1.1', sourceIp: '1.1.1.1', userAgent: 't' },
  },
  body,
  isBase64Encoded: false,
});

const webhook = {
  transaction_id: 'txn_entrypoint_1',
  source_account: 'acc_user_789',
  destination_account: 'acc_merchant_456',
  amount: 150.5,
  currency: 'USD',
};

beforeAll(async () => {
  pool = await createTestPool();
  await resetSchema(pool);
  await runMigrations(pool, resolve('migrations'));

  vi.resetModules();
  vi.stubEnv('DATABASE_URL', getTestDatabaseUrl());
  vi.stubEnv('DB_SSL', 'disable');
  vi.stubEnv('QUEUE_DRIVER', 'memory');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('WEBHOOK_SECRET', undefined);
  ({ handler: apiHandler } = await import('#src/handlers/api.js'));
  ({ handler: workerHandler } = await import('#src/handlers/worker.js'));
  ({ handler: reconcilerHandler } = await import('#src/handlers/reconciler.js'));
  ({ closePool: closeAppPool } = await import('#src/infrastructure/database/postgres-pool.js'));
});

afterAll(async () => {
  await closeAppPool?.();
  vi.unstubAllEnvs();
  await pool.end();
});

describe('Lambda entry points wired from environment variables', () => {
  it('api: serves the health check without touching the database', async () => {
    const res = await apiHandler(functionUrlEvent('GET', '/'), {});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('HEALTHY');
  });

  it('api: accepts a webhook and stores it as PROCESSING', async () => {
    const accepted = await apiHandler(
      functionUrlEvent('POST', '/v1/webhooks/transactions', JSON.stringify(webhook)),
      {},
    );
    expect(accepted.statusCode).toBe(202);

    const status = await apiHandler(
      functionUrlEvent('GET', '/v1/transactions/txn_entrypoint_1'),
      {},
    );
    expect(JSON.parse(status.body)[0]).toMatchObject({ status: 'PROCESSING', processed_at: null });
  });

  it('api: the scheduled warm-up ping opens the database connection', async () => {
    expect(await apiHandler({ source: 'aws.events' }, {})).toEqual({ warmed: true });
  });

  it('worker: processes an SQS record using settings from the environment', async () => {
    const result = await workerHandler(
      {
        Records: [
          {
            messageId: 'm1',
            body: JSON.stringify({ transaction_id: 'txn_entrypoint_1' }),
            attributes: { ApproximateReceiveCount: '1' },
          },
        ],
      },
      { getRemainingTimeInMillis: () => 20_000 },
    );
    expect(result).toEqual({ batchItemFailures: [] });

    const status = await apiHandler(
      functionUrlEvent('GET', '/v1/transactions/txn_entrypoint_1'),
      {},
    );
    expect(JSON.parse(status.body)[0].status).toBe('PROCESSED');
  });

  it('worker: reports a record it cannot process instead of throwing', async () => {
    const result = await workerHandler({
      Records: [
        {
          messageId: 'm2',
          body: JSON.stringify({ transaction_id: 'txn_missing' }),
          attributes: { ApproximateReceiveCount: '1' },
        },
      ],
    });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
  });

  it('reconciler: runs against the database and finds nothing stuck', async () => {
    expect(await reconcilerHandler({ source: 'aws.events' }, {})).toEqual({
      found: 0,
      reenqueued: 0,
    });
  });
});
