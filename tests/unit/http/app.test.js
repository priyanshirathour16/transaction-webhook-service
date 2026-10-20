import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '#tests/helpers/logger.js';
import { createApp } from '#src/app.js';
import { sendRequest } from '#tests/helpers/http.js';

const valid = {
  transaction_id: 'txn_abc123def456',
  source_account: 'acc_user_789',
  destination_account: 'acc_merchant_456',
  amount: 1500,
  currency: 'INR',
};

const silentLogger = createSilentLogger();

let transactionsService;
let app;

function makeApp(opts = {}) {
  return createApp({
    transactionsService,
    logger: silentLogger,
    now: () => new Date('2024-01-15T10:30:00Z'),
    ...opts,
  });
}

const post = (payload, headers = {}) =>
  sendRequest(app, {
    method: 'POST',
    url: '/v1/webhooks/transactions',
    headers: { 'content-type': 'application/json', ...headers },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

beforeEach(async () => {
  transactionsService = {
    receiveWebhook: vi.fn().mockResolvedValue({ duplicate: false }),
    getTransaction: vi.fn().mockResolvedValue([]),
  };
  app = makeApp();
});

describe('GET / (health)', () => {
  it('returns HEALTHY with an ISO-8601 UTC time', async () => {
    const res = await sendRequest(app, { method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'HEALTHY', current_time: '2024-01-15T10:30:00.000Z' });
  });

  it('does not touch the service (no dependency calls)', async () => {
    await sendRequest(app, { method: 'GET', url: '/' });
    expect(transactionsService.receiveWebhook).not.toHaveBeenCalled();
    expect(transactionsService.getTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /v1/webhooks/transactions', () => {
  it('accepts a valid webhook with 202 and maps fields to the service', async () => {
    const res = await post(valid);

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'ACCEPTED', duplicate: false });
    expect(transactionsService.receiveWebhook).toHaveBeenCalledWith(
      {
        transactionId: 'txn_abc123def456',
        sourceAccount: 'acc_user_789',
        destinationAccount: 'acc_merchant_456',
        amount: 1500,
        currency: 'INR',
      },
      // Request-scoped logger, so service logs carry the same request_id as the access log.
      { logger: expect.anything() },
    );
  });

  it('returns 202 (not an error) for a duplicate and says so', async () => {
    transactionsService.receiveWebhook.mockResolvedValue({ duplicate: true });
    const res = await post(valid);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'ACCEPTED', duplicate: true });
  });

  it('accepts decimal amounts and normalises the currency to upper case', async () => {
    const res = await post({ ...valid, amount: 150.5, currency: 'usd' });
    expect(res.statusCode).toBe(202);
    expect(transactionsService.receiveWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 150.5, currency: 'USD' }),
      expect.anything(),
    );
  });

  it('ignores unknown extra fields', async () => {
    const res = await post({ ...valid, event: 'payment.captured', notes: { a: 1 } });
    expect(res.statusCode).toBe(202);
    expect(transactionsService.receiveWebhook.mock.calls[0][0]).not.toHaveProperty('event');
  });

  it('sets an x-request-id header and honours one supplied by the caller', async () => {
    const generated = await post(valid);
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const supplied = await post(valid, { 'x-request-id': 'req-from-caller' });
    expect(supplied.headers['x-request-id']).toBe('req-from-caller');
  });

  describe('validation (400, never reaches the service)', () => {
    const cases = {
      'missing transaction_id': (() => {
        const { transaction_id: _omit, ...rest } = valid;
        return rest;
      })(),
      'empty transaction_id': { ...valid, transaction_id: '' },
      'numeric transaction_id (no coercion)': { ...valid, transaction_id: 123 },
      'transaction_id with illegal characters': { ...valid, transaction_id: 'txn 1; DROP' },
      'transaction_id too long': { ...valid, transaction_id: 'a'.repeat(129) },
      'missing source_account': { ...valid, source_account: undefined },
      'amount as string (no coercion)': { ...valid, amount: '1500' },
      'zero amount': { ...valid, amount: 0 },
      'negative amount': { ...valid, amount: -5 },
      'more than 4 decimal places': { ...valid, amount: 1.00001 },
      'absurdly large amount': { ...valid, amount: 1e15 },
      'currency too short': { ...valid, currency: 'IN' },
      'currency with digits': { ...valid, currency: 'IN1' },
      'currency not a string': { ...valid, currency: 356 },
      'array body': [valid],
    };

    it.each(Object.entries(cases))('rejects %s', async (_name, payload) => {
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(transactionsService.receiveWebhook).not.toHaveBeenCalled();
    });

    it('rejects a bare JSON null / scalar body at parse time (strict JSON parsing)', async () => {
      for (const body of ['null', '42', '"text"']) {
        const res = await post(body);
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('BAD_REQUEST');
      }
      expect(transactionsService.receiveWebhook).not.toHaveBeenCalled();
    });

    it('reports every problem with the offending field', async () => {
      const res = await post({ ...valid, amount: -1, currency: 'X' });
      const fields = res
        .json()
        .error.details.map((d) => d.field)
        .sort();
      expect(fields).toEqual(['amount', 'currency']);
    });

    it('names a missing field', async () => {
      const { currency: _omit, ...rest } = valid;
      const res = await post(rest);
      expect(res.json().error.details).toEqual([
        { field: 'currency', message: expect.stringContaining('required') },
      ]);
    });

    it('rejects an empty body, malformed JSON, and wrong content type', async () => {
      expect((await post('')).statusCode).toBe(400);
      const bad = await post('{"transaction_id":');
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.message).toMatch(/not valid JSON/);
      const text = await sendRequest(app, {
        method: 'POST',
        url: '/v1/webhooks/transactions',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });
      expect(text.statusCode).toBe(415);
      expect(text.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('rejects oversized bodies with 413', async () => {
      const res = await post({ ...valid, notes: 'x'.repeat(20 * 1024) });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  it('answers 500 with a generic body when the service fails (no internals leaked)', async () => {
    transactionsService.receiveWebhook.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:6543'),
    );
    const res = await post(valid);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(res.body).not.toContain('ECONNREFUSED');
  });
});

describe('signature verification (WEBHOOK_SECRET set)', () => {
  const secret = 'super-secret-value';
  const sign = (body, key = secret) => createHmac('sha256', key).update(body).digest('hex');

  beforeEach(async () => {
    app = makeApp({ webhookSecret: secret });
  });

  it('accepts a correctly signed body (X-Webhook-Signature)', async () => {
    const body = JSON.stringify(valid);
    const res = await post(body, { 'x-webhook-signature': sign(body) });
    expect(res.statusCode).toBe(202);
  });

  it('accepts the RazorPay header name', async () => {
    const body = JSON.stringify(valid);
    const res = await post(body, { 'x-razorpay-signature': sign(body) });
    expect(res.statusCode).toBe(202);
  });

  it('signs the raw bytes, so formatting matters', async () => {
    const pretty = JSON.stringify(valid, null, 2);
    const signedForCompact = sign(JSON.stringify(valid));
    const res = await post(pretty, { 'x-webhook-signature': signedForCompact });
    expect(res.statusCode).toBe(401);
    const ok = await post(pretty, { 'x-webhook-signature': sign(pretty) });
    expect(ok.statusCode).toBe(202);
  });

  it.each([
    ['missing header', {}],
    ['wrong secret', (body) => ({ 'x-webhook-signature': sign(body, 'other-secret') })],
    ['not hex', { 'x-webhook-signature': 'zzzz' }],
    ['wrong length', { 'x-webhook-signature': 'ab'.repeat(10) }],
  ])('rejects %s with 401 before validation or processing', async (_name, headers) => {
    const body = JSON.stringify(valid);
    const res = await post(body, typeof headers === 'function' ? headers(body) : headers);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_SIGNATURE');
    expect(transactionsService.receiveWebhook).not.toHaveBeenCalled();
  });

  it('checks the signature before validating, revealing nothing about the schema', async () => {
    const res = await post({ nonsense: true });
    expect(res.statusCode).toBe(401);
  });

  it('does not protect the health or query endpoints', async () => {
    expect((await sendRequest(app, { method: 'GET', url: '/' })).statusCode).toBe(200);
    expect(
      (await sendRequest(app, { method: 'GET', url: '/v1/transactions/txn_1' })).statusCode,
    ).toBe(404);
  });
});

describe('GET /v1/transactions/:transaction_id', () => {
  const stored = {
    transaction_id: 'txn_abc123def456',
    source_account: 'acc_user_789',
    destination_account: 'acc_merchant_456',
    amount: 150.5,
    currency: 'USD',
    status: 'PROCESSED',
    created_at: '2024-01-15T10:30:00.000Z',
    processed_at: '2024-01-15T10:30:30.000Z',
  };

  it('returns the transaction as a one-element array', async () => {
    transactionsService.getTransaction.mockResolvedValue([stored]);
    const res = await sendRequest(app, { method: 'GET', url: '/v1/transactions/txn_abc123def456' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([stored]);
    expect(transactionsService.getTransaction).toHaveBeenCalledWith('txn_abc123def456');
  });

  it('keeps processed_at null while processing', async () => {
    transactionsService.getTransaction.mockResolvedValue([
      { ...stored, status: 'PROCESSING', processed_at: null },
    ]);
    const res = await sendRequest(app, { method: 'GET', url: '/v1/transactions/txn_abc123def456' });
    expect(res.json()[0]).toMatchObject({ status: 'PROCESSING', processed_at: null });
  });

  it('returns 404 with the error envelope when unknown', async () => {
    const res = await sendRequest(app, { method: 'GET', url: '/v1/transactions/txn_missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TRANSACTION_NOT_FOUND');
  });

  it('tolerates a trailing slash', async () => {
    transactionsService.getTransaction.mockResolvedValue([stored]);
    const res = await sendRequest(app, {
      method: 'GET',
      url: '/v1/transactions/txn_abc123def456/',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('unknown routes', () => {
  it('return a JSON 404', async () => {
    const res = await sendRequest(app, { method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('Server-Timing header', () => {
  const FORMAT = /^app;dur=\d+(\.\d)?$/;

  it('reports the application time on successful responses', async () => {
    const health = await sendRequest(app, { method: 'GET', url: '/' });
    const accepted = await post(valid);

    expect(health.headers['server-timing']).toMatch(FORMAT);
    expect(accepted.headers['server-timing']).toMatch(FORMAT);
  });

  it('is also present on errors and 404s, so slow failures are visible too', async () => {
    const invalid = await post({ nonsense: true });
    const missing = await sendRequest(app, { method: 'GET', url: '/nope' });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers['server-timing']).toMatch(FORMAT);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['server-timing']).toMatch(FORMAT);
  });

  it('measures real time: a slow handler shows a correspondingly larger duration', async () => {
    transactionsService.receiveWebhook.mockImplementation(
      () => new Promise((done) => setTimeout(() => done({ duplicate: false }), 60)),
    );

    const res = await post(valid);

    const duration = Number(/dur=([\d.]+)/.exec(res.headers['server-timing'])[1]);
    expect(duration).toBeGreaterThanOrEqual(55);
    expect(duration).toBeLessThan(1000);
  });
});

describe('edge cases', () => {
  it('health check uses the real clock when none is injected', async () => {
    const realClockApp = createApp({ transactionsService, logger: silentLogger });
    const before = Date.now();

    const res = await sendRequest(realClockApp, { method: 'GET', url: '/' });

    const reported = new Date(res.json().current_time).getTime();
    expect(reported).toBeGreaterThanOrEqual(before);
    expect(reported).toBeLessThanOrEqual(Date.now());
  });

  it('rejects an over-long transaction id in the URL with a 400, not a 404 or a DB lookup', async () => {
    const res = await sendRequest(app, {
      method: 'GET',
      url: `/v1/transactions/${'a'.repeat(129)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'transaction_id' }],
    });
    expect(transactionsService.getTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unsupported content encoding with 415', async () => {
    const res = await post(JSON.stringify(valid), { 'content-encoding': 'compress' });

    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(transactionsService.receiveWebhook).not.toHaveBeenCalled();
  });

  it.each(['gzip', 'br', 'deflate'])(
    'answers a corrupt %s body with a 400, not a 500 (client mistake, not a server fault)',
    async (encoding) => {
      const res = await post('{"this is":"plain text, not compressed"}', {
        'content-encoding': encoding,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
      expect(res.body).not.toMatch(/stack|at .*\.js/); // no internals leaked
      expect(transactionsService.receiveWebhook).not.toHaveBeenCalled();
    },
  );

  it('rejects an unsupported charset with 415', async () => {
    const res = await post(JSON.stringify(valid), {
      'content-type': 'application/json; charset=iso-8859-1',
    });

    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('accepts a UTF-8 charset parameter on the content type', async () => {
    const res = await post(JSON.stringify(valid), {
      'content-type': 'application/json; charset=utf-8',
    });
    expect(res.statusCode).toBe(202);
  });
});
