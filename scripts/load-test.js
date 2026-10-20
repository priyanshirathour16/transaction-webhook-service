/**
 * Simple load test for the webhook endpoint (no extra dependencies: Node's built-in fetch).
 * Sends unique transactions with N concurrent connections and reports latency percentiles.
 *
 *   node scripts/load-test.js --url https://<function-url> --connections 5 --requests 300
 *
 * Options (flags or environment variables):
 *   --url / LOAD_BASE_URL       base URL of the service (required)
 *   --secret / WEBHOOK_SECRET   sign webhooks, if the service enforces signatures
 *   --connections <n>           concurrent connections (default 5)
 *   --requests <n>              total requests (default 300)
 *   --max-p95-ms <ms>           fail if the SERVER-SIDE p95 (Server-Timing header) exceeds this (default 500)
 *   --strict-e2e                also fail if END-TO-END p95 (including network distance) exceeds it
 *
 * Note: a brand-new AWS account may allow only ~10 concurrent Lambda executions in total, so
 * keep --connections modest against a deployed stack, or requests will be throttled (HTTP 429).
 * Every request creates a real transaction (ids start with "load_") that the worker will process.
 */
import { pathToFileURL } from 'node:url';
import { parseCliArgs } from './lib/cli.js';
import { formatMs, summarizeLatencies } from './lib/stats.js';
import { buildWebhookPayload, createWebhookClient } from './lib/webhook-client.js';

/**
 * @param {{
 *   baseUrl: string,
 *   secret?: string,
 *   connections?: number,
 *   requests?: number,
 *   maxP95Ms?: number,
 *   strictEndToEnd?: boolean,
 *   log?: (line: string) => void,
 * }} options
 */
export async function runLoadTest({
  baseUrl,
  secret,
  connections = 5,
  requests = 300,
  maxP95Ms = 500,
  strictEndToEnd = false,
  log = console.log,
}) {
  const client = createWebhookClient({ baseUrl, secret });
  const latencies = [];
  const serverLatencies = []; // from the Server-Timing header: the server's own time, no network
  const statuses = new Map();
  let nextRequest = 0;

  const worker = async () => {
    while (nextRequest < requests) {
      nextRequest += 1;
      const result = await client.postWebhook(buildWebhookPayload({}, 'load'));
      latencies.push(result.elapsedMs);
      if (result.serverMs !== undefined) serverLatencies.push(result.serverMs);
      statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
    }
  };

  const started = performance.now();
  await Promise.all(Array.from({ length: connections }, worker));
  const seconds = (performance.now() - started) / 1_000;

  const summary = summarizeLatencies(latencies);
  const serverSummary = summarizeLatencies(serverLatencies);
  const accepted = statuses.get(202) ?? 0;

  // The gate is the application's own time (Server-Timing) when the service reports it: end-to-end
  // time also contains network travel from this machine, which the service cannot control.
  // --strict-e2e additionally holds the end-to-end figure to the budget.
  const gate = serverLatencies.length > 0 ? serverSummary : summary;
  const passed =
    accepted === requests && gate.p95 < maxP95Ms && (!strictEndToEnd || summary.p95 < maxP95Ms);

  log(`Load test: ${requests} requests, ${connections} connections, ${seconds.toFixed(1)} s`);
  log(`  throughput  ${(requests / seconds).toFixed(1)} req/s`);
  log(`  status      ${[...statuses].map(([status, n]) => `${status}: ${n}`).join(', ')}`);
  log(
    `  latency     min ${formatMs(summary.min)} | p50 ${formatMs(summary.p50)} | ` +
      `p90 ${formatMs(summary.p90)} | p95 ${formatMs(summary.p95)} | ` +
      `p99 ${formatMs(summary.p99)} | max ${formatMs(summary.max)}`,
  );
  if (serverLatencies.length > 0) {
    log(
      `  server only p50 ${formatMs(serverSummary.p50)} | p95 ${formatMs(serverSummary.p95)} | ` +
        `max ${formatMs(serverSummary.max)}   (Server-Timing header; the difference is network)`,
    );
    log(
      `  network     ~${formatMs(summary.p50 - serverSummary.p50)} per request from this machine`,
    );
  }
  const basis = serverLatencies.length > 0 ? 'server-side' : 'end-to-end';
  log(
    `  result      ${passed ? 'PASS' : 'FAIL'} (all 202 and ${basis} p95 < ${maxP95Ms} ms` +
      `${strictEndToEnd ? ' and end-to-end p95 too' : ''})`,
  );

  return {
    passed,
    summary,
    serverSummary,
    statuses: Object.fromEntries(statuses),
    requestsPerSecond: requests / seconds,
  };
}

// ---- CLI ---------------------------------------------------------------------------------
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const usage =
    'Usage: node scripts/load-test.js --url <base-url> [--secret <s>] [--connections <n>]\n' +
    '                                 [--requests <n>] [--max-p95-ms <ms>] [--strict-e2e]';
  const values = parseCliArgs(
    {
      url: { type: 'string' },
      secret: { type: 'string' },
      connections: { type: 'string' },
      requests: { type: 'string' },
      'max-p95-ms': { type: 'string' },
      'strict-e2e': { type: 'boolean', default: false },
    },
    usage,
  );
  const baseUrl = values.url ?? process.env.LOAD_BASE_URL;
  if (!baseUrl) {
    console.error(`Missing --url (or LOAD_BASE_URL).\n\n${usage}`);
    process.exit(2);
  }
  const result = await runLoadTest({
    baseUrl,
    secret: values.secret ?? process.env.WEBHOOK_SECRET,
    connections: Number(values.connections ?? 5),
    requests: Number(values.requests ?? 300),
    maxP95Ms: Number(values['max-p95-ms'] ?? 500),
    strictEndToEnd: values['strict-e2e'],
  });
  process.exit(result.passed ? 0 : 1);
}
