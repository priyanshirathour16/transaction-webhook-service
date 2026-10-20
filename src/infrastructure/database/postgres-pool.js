import pg from 'pg';
import { getConfig } from '#src/config/env.js';
import { getLogger } from '#src/infrastructure/logging/logger.js';

/** @type {pg.Pool | undefined} */
let pool;

// The application runs next to its database, so a connection that takes longer than this is a
// fault worth failing fast on (the webhook has a 500 ms budget).
export const DEFAULT_CONNECTION_TIMEOUT_MS = 3_000;

/**
 * @param {string} connectionString
 * @param {{ ssl: boolean, max: number, connectionTimeoutMillis?: number }} opts
 *        `connectionTimeoutMillis`: command-line tools run from far away (a laptop on another
 *        continent) pass a larger value, because opening a TLS connection takes many round trips.
 * @returns {pg.Pool}
 */
export function createPool(connectionString, opts) {
  const created = new pg.Pool({
    connectionString,
    max: opts.max,
    // Supabase's pooler presents a certificate chain Node does not trust by default.
    // Traffic is still encrypted; for stricter verification supply Supabase's CA via `ssl.ca`.
    ssl: opts.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    // Fail fast instead of hanging the 500 ms webhook path on a slow query.
    statement_timeout: 5_000,
    query_timeout: 6_000,
    application_name: 'transaction-webhook-service',
  });
  // An idle client erroring (e.g. pooler restart) must not crash the process.
  created.on('error', (err) => getLogger().error({ err }, 'db.pool.idle_client_error'));
  return created;
}

/**
 * Shared pool, reused across warm Lambda invocations. Uses the transaction-mode pooler URL:
 * only unnamed statements are used (pg does not prepare unless `name` is passed), which is
 * what transaction pooling requires.
 */
export function getPool() {
  if (!pool) {
    const config = getConfig();
    pool = createPool(config.DATABASE_URL, {
      ssl: config.DB_SSL === 'require',
      max: config.DB_POOL_MAX,
    });
  }
  return pool;
}

export async function closePool() {
  const current = pool;
  pool = undefined;
  await current?.end();
}
