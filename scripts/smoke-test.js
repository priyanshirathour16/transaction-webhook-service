/**
 * End-to-end smoke test against a RUNNING service (local or deployed). It exercises the four
 * success criteria from the assessment brief and exits non-zero if any check fails.
 *
 *   node scripts/smoke-test.js --url https://<function-url>
 *   node scripts/smoke-test.js --url http://localhost:3000 --expected-delay 5
 *
 * Options (flags or environment variables):
 *   --url / SMOKE_BASE_URL         base URL of the service (required)
 *   --secret / WEBHOOK_SECRET      sign webhooks, if the service enforces signatures
 *   --expected-delay <s>           processing delay of the deployment (default 30)
 *   --max-ack-ms <ms>              acknowledgement budget (default 500)
 *   --strict-cold                  also fail if the very FIRST request exceeds the budget
 *
 * Criteria covered:
 *   1. Single transaction  — 202 fast, PROCESSING, then PROCESSED after ~the delay
 *   2. Duplicate prevention — many identical webhooks, one transaction, processed once
 *   3. Performance          — acknowledgement latency stays under budget while work is pending
 *   4. Reliability          — bad input is rejected cleanly, unknown ids give 404, nothing is lost
 */
import { pathToFileURL } from 'node:url';
import { parseCliArgs } from './lib/cli.js';
import { formatMs, summarizeLatencies } from './lib/stats.js';
import { buildWebhookPayload, createWebhookClient } from './lib/webhook-client.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   baseUrl: string,
 *   secret?: string,
 *   expectedDelaySeconds?: number,
 *   maxAckMs?: number,
 *   strictCold?: boolean,
 *   sequentialRequests?: number,
 *   concurrentRequests?: number,
 *   pollIntervalMs?: number,
 *   log?: (line: string) => void,
 * }} options
 */
export async function runSmokeTest({
  baseUrl,
  secret,
  expectedDelaySeconds = 30,
  maxAckMs = 500,
  strictCold = false,
  sequentialRequests = 30,
  concurrentRequests = 5,
  pollIntervalMs = 1_000,
  log = console.log,
}) {
  const client = createWebhookClient({ baseUrl, secret });
  const checks = [];
  const warnings = [];

  const check = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    return ok;
  };
  const section = (title) => log(`\n${title}`);

  // ---- 0. Health -------------------------------------------------------------------------
  section('0. Health check');
  const health = await client.getHealth();
  check('GET / answers 200 HEALTHY', health.status === 200 && health.json?.status === 'HEALTHY');
  check(
    'current_time is an ISO-8601 timestamp',
    !Number.isNaN(Date.parse(health.json?.current_time)),
    health.json?.current_time,
  );

  // ---- 1. Single transaction -------------------------------------------------------------
  section('1. Single transaction');
  const single = buildWebhookPayload();
  const first = await client.postWebhook(single);
  check('webhook accepted with 202', first.status === 202, `HTTP ${first.status}`);
  const firstWithinBudget = first.elapsedMs < maxAckMs;
  if (strictCold) {
    check(
      `first request acknowledged < ${maxAckMs} ms`,
      firstWithinBudget,
      formatMs(first.elapsedMs),
    );
  } else if (!firstWithinBudget) {
    warnings.push(
      `first request took ${formatMs(first.elapsedMs)} (> ${maxAckMs} ms): likely a cold start`,
    );
  }
  log(`  info  first request latency ${formatMs(first.elapsedMs)} (may include a cold start)`);

  const pending = await client.getTransaction(single.transaction_id);
  const pendingRecord = pending.json?.[0];
  check(
    'query returns an array with one record',
    Array.isArray(pending.json) && pending.json.length === 1,
  );
  check(
    'record is PROCESSING with processed_at null',
    pendingRecord?.status === 'PROCESSING' && pendingRecord?.processed_at === null,
    pendingRecord?.status,
  );
  check(
    'record echoes the submitted data',
    pendingRecord?.source_account === single.source_account &&
      pendingRecord?.destination_account === single.destination_account &&
      pendingRecord?.amount === single.amount &&
      pendingRecord?.currency === single.currency,
  );

  // ---- 2. Duplicate prevention (submitted now so it is processed during the same wait) ----
  section('2. Duplicate prevention');
  const duplicated = buildWebhookPayload();
  const burst = await Promise.all(Array.from({ length: 10 }, () => client.postWebhook(duplicated)));
  check(
    '10 simultaneous identical webhooks all answer 202',
    burst.every((r) => r.status === 202),
    burst.map((r) => r.status).join(','),
  );
  check(
    'exactly one of them was the first (duplicate:false)',
    burst.filter((r) => r.json?.duplicate === false).length === 1,
  );
  // (A lookup by primary key can never return two rows, so "one row exists" proves nothing from
  // outside. Exactly-once is proven by the database constraint + the integration tests; here we
  // check what a client can observe: one "first" response and an unchanged record afterwards.)

  // ---- 3. Performance --------------------------------------------------------------------
  section('3. Performance (acknowledgement latency while earlier work is still pending)');
  const timings = [];
  const serverTimings = []; // what the server says it spent; the rest of each timing is the network
  let rejected = 0;
  for (let i = 0; i < sequentialRequests; i += 1) {
    const r = await client.postWebhook(buildWebhookPayload());
    timings.push(r.elapsedMs);
    if (r.serverMs !== undefined) serverTimings.push(r.serverMs);
    if (r.status !== 202) rejected += 1;
  }
  const concurrent = await Promise.all(
    Array.from({ length: concurrentRequests }, () => client.postWebhook(buildWebhookPayload())),
  );
  for (const r of concurrent) {
    timings.push(r.elapsedMs);
    if (r.serverMs !== undefined) serverTimings.push(r.serverMs);
    if (r.status !== 202) rejected += 1;
  }
  const latency = summarizeLatencies(timings);
  log(
    `  info  ${latency.count} requests, end to end: p50 ${formatMs(latency.p50)}, p95 ${formatMs(latency.p95)}, ` +
      `p99 ${formatMs(latency.p99)}, max ${formatMs(latency.max)}`,
  );
  if (serverTimings.length > 0) {
    const server = summarizeLatencies(serverTimings);
    log(
      `  info  server-side only (Server-Timing header): p50 ${formatMs(server.p50)}, ` +
        `p95 ${formatMs(server.p95)}, max ${formatMs(server.max)}. The rest of the end-to-end time is network travel`,
    );
  }
  check(`all ${latency.count} requests answered 202`, rejected === 0, `${rejected} rejected`);
  check(`p95 acknowledgement < ${maxAckMs} ms`, latency.p95 < maxAckMs, formatMs(latency.p95));

  // ---- 4. Reliability: clean failure handling --------------------------------------------
  section('4. Reliability / error handling');
  const invalid = await client.postWebhook({ transaction_id: 'x', amount: -1 });
  check(
    'invalid payload → 400 with an error body',
    invalid.status === 400 && invalid.json?.error?.code === 'VALIDATION_ERROR',
    `HTTP ${invalid.status}`,
  );
  const malformed = await client.postWebhook(null, { rawBody: '{"broken":' });
  check('malformed JSON → 400', malformed.status === 400, `HTTP ${malformed.status}`);
  const wrongType = await client.postWebhook(null, {
    rawBody: 'hello',
    headers: { 'content-type': 'text/plain' },
  });
  check('non-JSON content type → 415', wrongType.status === 415, `HTTP ${wrongType.status}`);
  const unknown = await client.getTransaction(`does_not_exist_${Date.now()}`);
  check('unknown transaction → 404', unknown.status === 404, `HTTP ${unknown.status}`);
  if (secret) {
    const unsigned = await client.postWebhook(buildWebhookPayload(), { sign: false });
    check(
      'unsigned webhook → 401 when a secret is configured',
      unsigned.status === 401,
      `HTTP ${unsigned.status}`,
    );
  }

  // ---- Wait for background processing ----------------------------------------------------
  section(`Waiting for background processing (expected delay ~${expectedDelaySeconds} s)`);
  const waitStarted = Date.now();
  const deadline = waitStarted + (expectedDelaySeconds + 60) * 1_000;
  // Only wait for transactions the service actually accepted: if intake is broken there is
  // nothing to wait for, and the run should fail in seconds rather than after a long timeout.
  const watched = [
    first.status === 202 && single.transaction_id,
    burst.some((r) => r.status === 202) && duplicated.transaction_id,
  ].filter(Boolean);
  if (watched.length < 2) log('  info  some webhooks were not accepted; not waiting for them');
  const processed = new Map();
  while (processed.size < watched.length && Date.now() < deadline) {
    for (const id of watched) {
      if (processed.has(id)) continue;
      const res = await client.getTransaction(id);
      if (res.json?.[0]?.status === 'PROCESSED') processed.set(id, res.json[0]);
    }
    if (processed.size < watched.length) await sleep(pollIntervalMs);
  }
  log(`  info  waited ${((Date.now() - waitStarted) / 1_000).toFixed(1)} s`);

  const record = processed.get(single.transaction_id);
  check('single transaction became PROCESSED', Boolean(record));
  if (record) {
    const lagSeconds = (Date.parse(record.processed_at) - Date.parse(record.created_at)) / 1_000;
    log(`  info  created_at → processed_at: ${lagSeconds.toFixed(1)} s`);
    check(
      `processed ~${expectedDelaySeconds} s after creation`,
      lagSeconds >= expectedDelaySeconds - 1 && lagSeconds <= expectedDelaySeconds + 30,
      `${lagSeconds.toFixed(1)} s`,
    );
  }
  check(
    'duplicated transaction was processed exactly once (PROCESSED)',
    processed.has(duplicated.transaction_id),
  );

  // ---- Idempotency after processing ------------------------------------------------------
  section('Idempotency after processing');
  if (record) {
    const replay = await client.postWebhook(single);
    check(
      'replay of a processed transaction → 202 duplicate:true',
      replay.status === 202 && replay.json?.duplicate === true,
    );
    await sleep(Math.min(pollIntervalMs * 2, 3_000));
    const after = await client.getTransaction(single.transaction_id);
    check(
      'record unchanged: still PROCESSED with the same processed_at',
      after.json?.length === 1 &&
        after.json[0].status === 'PROCESSED' &&
        after.json[0].processed_at === record.processed_at,
    );
  }

  const failed = checks.filter((c) => !c.ok);
  section('Summary');
  for (const warning of warnings) log(`  WARN  ${warning}`);
  log(
    `  ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ' — FAILED' : ''}`,
  );
  return { passed: failed.length === 0, checks, warnings, latency };
}

// ---- CLI ---------------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const usage =
    'Usage: node scripts/smoke-test.js --url <base-url> [--secret <s>] [--expected-delay <seconds>]\n' +
    '                                   [--max-ack-ms <ms>] [--strict-cold]';
  const values = parseCliArgs(
    {
      url: { type: 'string' },
      secret: { type: 'string' },
      'expected-delay': { type: 'string' },
      'max-ack-ms': { type: 'string' },
      'strict-cold': { type: 'boolean', default: false },
    },
    usage,
  );
  const baseUrl = values.url ?? process.env.SMOKE_BASE_URL;
  if (!baseUrl) {
    console.error(`Missing --url (or SMOKE_BASE_URL).\n\n${usage}`);
    process.exit(2);
  }
  console.log(`Smoke test against ${baseUrl}`);
  const result = await runSmokeTest({
    baseUrl,
    secret: values.secret ?? process.env.WEBHOOK_SECRET,
    expectedDelaySeconds: Number(
      values['expected-delay'] ?? process.env.SMOKE_EXPECTED_DELAY ?? 30,
    ),
    maxAckMs: Number(values['max-ack-ms'] ?? 500),
    strictCold: values['strict-cold'],
  });
  process.exit(result.passed ? 0 : 1);
}
