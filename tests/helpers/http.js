import request from 'supertest';

/**
 * Sends one HTTP request to an Express app in-process (no port, no network) and returns a small,
 * stable response shape: `{ statusCode, headers, body, json() }`.
 *
 * @param {import('express').Express} app
 * @param {{ method?: string, url: string, headers?: Record<string, string>, payload?: unknown }} opts
 */
export async function sendRequest(app, { method = 'GET', url, headers = {}, payload }) {
  let req = request(app)[method.toLowerCase()](url).set(headers);
  if (payload !== undefined) {
    // Strings are sent byte-for-byte (the signature tests depend on that); objects as JSON.
    req = req.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    if (!headers['content-type']) req = req.set('content-type', 'application/json');
  }
  const res = await req.buffer(true).parse((r, done) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
  });
  return {
    statusCode: res.status,
    headers: res.headers,
    body: res.body,
    json: () => JSON.parse(res.body),
  };
}
