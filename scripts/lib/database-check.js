import { createPool } from '#src/infrastructure/database/postgres-pool.js';
import { median } from './stats.js';

const WARM_SAMPLES = 5;
const CLI_CONNECTION_TIMEOUT_MS = 20_000;

/** Hides the password (and anything else secret-looking) in a message that might quote the URL. */
export function redact(message, url) {
  let text = String(message);
  try {
    const { password } = new URL(url);
    if (password) {
      text = text.replaceAll(password, '***').replaceAll(decodeURIComponent(password), '***');
    }
  } catch {
    // not a parseable URL: nothing more to hide
  }
  return text;
}

/**
 * Region encoded in a Supabase pooler host, e.g. `aws-0-ap-south-1.pooler.supabase.com`.
 * @param {string} url
 * @returns {string | undefined}
 */
export function poolerRegion(url) {
  try {
    return new URL(url).hostname.match(/^aws-\d+-([a-z0-9-]+)\.pooler\.supabase\.com$/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Warnings when the database is not in the region the application runs in.
 * @param {string} url
 * @param {string | undefined} expectedRegion
 * @returns {string[]}
 */
export function regionWarnings(url, expectedRegion) {
  const region = poolerRegion(url);
  if (!expectedRegion || !region || region === expectedRegion) return [];
  return [
    `database is in ${region} but the application runs in ${expectedRegion}: every query crosses regions`,
  ];
}

/** @param {string} url */
export function describeEndpoint(url) {
  try {
    const { hostname, port } = new URL(url);
    return { host: hostname, port: port || '5432' };
  } catch {
    return { host: '(unparseable URL)', port: '?' };
  }
}

/**
 * Connects the way the application does and measures it. Never throws; never prints the password.
 *
 * @param {{ url: string, ssl: boolean, expectedRegion?: string }} options
 */
export async function checkDatabase({ url, ssl, expectedRegion }) {
  const { host, port } = describeEndpoint(url);
  const region = poolerRegion(url);
  const result = { host, port, region, ok: false, warnings: regionWarnings(url, expectedRegion) };

  let pool;
  try {
    // Forgiving timeout: this tool is often run from far away, and a slow connection should be
    // reported as slow, not as failed.
    pool = createPool(url, { ssl, max: 1, connectionTimeoutMillis: CLI_CONNECTION_TIMEOUT_MS });

    // Cold: opening the connection (TLS + authentication) and the first query.
    const coldStart = performance.now();
    const version = await pool.query('SHOW server_version');
    result.coldMs = performance.now() - coldStart;
    result.serverVersion = version.rows[0].server_version;

    // Warm: round trips on the open connection, which is what each request pays per query.
    const warm = [];
    for (let i = 0; i < WARM_SAMPLES; i += 1) {
      const started = performance.now();
      await pool.query('SELECT 1');
      warm.push(performance.now() - started);
    }
    result.warmMs = median(warm);

    // A multi-statement transaction on one connection: what the worker does. Must work through a
    // transaction-mode pooler.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const tables = await pool.query(
      "SELECT to_regclass('public.transactions') IS NOT NULL AS present",
    );
    result.tablePresent = tables.rows[0].present;
    result.ok = true;
  } catch (error) {
    result.error = redact(error?.message ?? error, url);
  } finally {
    await pool?.end().catch(() => undefined);
  }
  return result;
}
