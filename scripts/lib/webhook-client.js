import { createHmac, randomUUID } from 'node:crypto';

/**
 * A valid webhook payload with a unique transaction id.
 * @param {Record<string, unknown>} [overrides]
 * @param {string} [prefix]  helps you recognise the rows in the database afterwards
 */
export function buildWebhookPayload(overrides = {}, prefix = 'smoke') {
  return {
    transaction_id: `${prefix}_${randomUUID()}`,
    source_account: 'acc_user_789',
    destination_account: 'acc_merchant_456',
    amount: 1500,
    currency: 'INR',
    ...overrides,
  };
}

/**
 * Milliseconds the server reports for itself in a `Server-Timing: app;dur=12.3` header.
 * @param {string | null | undefined} header
 * @returns {number | undefined}
 */
export function parseServerTiming(header) {
  const match = /(?:^|,)\s*app;(?:[^,]*;)?dur=([0-9]+(?:\.[0-9]+)?)/.exec(header ?? '');
  return match ? Number(match[1]) : undefined;
}

/**
 * Minimal HTTP client for the service, with latency measurement. Every call resolves (never
 * rejects) with `{ status, elapsedMs, json, error }` so callers can assert instead of try/catch.
 *
 * @param {{ baseUrl: string, secret?: string, timeoutMs?: number }} options
 */
export function createWebhookClient({ baseUrl, secret, timeoutMs = 15_000 }) {
  const root = baseUrl.replace(/\/+$/, '');

  async function send(method, path, { body, headers = {} } = {}) {
    const started = performance.now();
    try {
      const response = await fetch(`${root}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return {
        status: response.status,
        elapsedMs: performance.now() - started,
        // What the server says it spent; the rest of elapsedMs is network and TLS.
        serverMs: parseServerTiming(response.headers.get('server-timing')),
        json,
        text,
      };
    } catch (error) {
      return { status: 0, elapsedMs: performance.now() - started, error: String(error) };
    }
  }

  return {
    getHealth: () => send('GET', '/'),

    getTransaction: (transactionId) =>
      send('GET', `/v1/transactions/${encodeURIComponent(transactionId)}`),

    /**
     * @param {unknown} payload
     * @param {{ sign?: boolean, headers?: Record<string, string>, rawBody?: string }} [options]
     *        `sign: false` omits the signature even when a secret is configured (negative tests).
     */
    postWebhook: (payload, { sign = true, headers = {}, rawBody } = {}) => {
      const body = rawBody ?? JSON.stringify(payload);
      const allHeaders = { 'content-type': 'application/json', ...headers };
      if (secret && sign) {
        allHeaders['x-webhook-signature'] = createHmac('sha256', secret).update(body).digest('hex');
      }
      return send('POST', '/v1/webhooks/transactions', { body, headers: allHeaders });
    },
  };
}
