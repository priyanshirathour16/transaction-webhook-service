import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '#tests/helpers/logger.js';
import { createApp } from '#src/app.js';
import { createApiHandler } from '#src/handlers/api.js';

const logger = createSilentLogger();

const secret = 'lambda-secret-value';
const body = JSON.stringify({
  transaction_id: 'txn_abc123def456',
  source_account: 'acc_user_789',
  destination_account: 'acc_merchant_456',
  amount: 1500,
  currency: 'INR',
});

/** A Lambda Function URL (payload format 2.0) event. */
function functionUrlEvent({ method, path, headers = {}, body: payload, base64 = false }) {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'abc.lambda-url.ap-south-1.on.aws', ...headers },
    requestContext: {
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
    },
    body:
      payload === undefined
        ? undefined
        : base64
          ? Buffer.from(payload).toString('base64')
          : payload,
    isBase64Encoded: base64,
  };
}

function setup() {
  const transactionsService = {
    receiveWebhook: vi.fn().mockResolvedValue({ duplicate: false }),
    getTransaction: vi.fn().mockResolvedValue([]),
  };
  const warmUp = vi.fn().mockResolvedValue(undefined);
  const createExpressApp = vi.fn(() =>
    createApp({ transactionsService, logger, webhookSecret: secret, now: () => new Date(0) }),
  );
  return {
    transactionsService,
    warmUp,
    createExpressApp,
    handler: createApiHandler(createExpressApp, warmUp),
  };
}

describe('API Lambda handler (Function URL events)', () => {
  it('serves the health check', async () => {
    const { handler } = setup();
    const res = await handler(functionUrlEvent({ method: 'GET', path: '/' }), {});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'HEALTHY',
      current_time: '1970-01-01T00:00:00.000Z',
    });
  });

  it('verifies the signature against the exact bytes delivered by Lambda', async () => {
    const { handler, transactionsService } = setup();
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const res = await handler(
      functionUrlEvent({
        method: 'POST',
        path: '/v1/webhooks/transactions',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature },
        body,
      }),
      {},
    );
    expect(res.statusCode).toBe(202);
    expect(transactionsService.receiveWebhook).toHaveBeenCalledTimes(1);
  });

  it('decodes base64 bodies before verifying (isBase64Encoded: true)', async () => {
    const { handler, transactionsService } = setup();
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const res = await handler(
      functionUrlEvent({
        method: 'POST',
        path: '/v1/webhooks/transactions',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': signature },
        body,
        base64: true,
      }),
      {},
    );
    expect(res.statusCode).toBe(202);
    expect(transactionsService.receiveWebhook).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad signature with 401', async () => {
    const { handler, transactionsService } = setup();
    const res = await handler(
      functionUrlEvent({
        method: 'POST',
        path: '/v1/webhooks/transactions',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': 'ab'.repeat(32) },
        body,
      }),
      {},
    );
    expect(res.statusCode).toBe(401);
    expect(transactionsService.receiveWebhook).not.toHaveBeenCalled();
  });

  it('builds the app once and reuses it across warm invocations', async () => {
    const { handler, createExpressApp } = setup();
    await handler(functionUrlEvent({ method: 'GET', path: '/' }), {});
    await handler(functionUrlEvent({ method: 'GET', path: '/' }), {});
    expect(createExpressApp).toHaveBeenCalledTimes(1);
  });

  it('answers the scheduled warm-up ping by opening the DB connection, not as an HTTP request', async () => {
    const { handler, warmUp, createExpressApp } = setup();
    const result = await handler({ source: 'aws.events', 'detail-type': 'Scheduled Event' }, {});
    expect(result).toEqual({ warmed: true });
    expect(warmUp).toHaveBeenCalledTimes(1);
    expect(createExpressApp).toHaveBeenCalledTimes(1);
  });
});
