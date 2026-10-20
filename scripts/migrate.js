/**
 * Applies pending SQL migrations from ./migrations. Run with `npm run migrate`.
 * Uses the direct (non-pooled) connection when DATABASE_URL_DIRECT is set.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDatabaseConfig } from '#src/config/env.js';
import { createPool } from '#src/infrastructure/database/postgres-pool.js';
import { runMigrations } from '#src/infrastructure/database/migrator.js';

// Local convenience: load .env if present (CI/production pass real environment variables).
if (existsSync('.env')) process.loadEnvFile('.env');

async function main() {
  const config = parseDatabaseConfig(process.env);
  const url = config.DATABASE_URL_DIRECT ?? config.DATABASE_URL;
  // Generous connection timeout: migrations run from a laptop or a CI runner far from the database.
  const pool = createPool(url, {
    ssl: config.DB_SSL === 'require',
    max: 1,
    connectionTimeoutMillis: 20_000,
  });

  try {
    const { applied, skipped } = await runMigrations(pool, resolve('migrations'));
    for (const name of skipped) console.log(`skip   ${name}`);
    for (const name of applied) console.log(`apply  ${name}`);
    console.log(`Done: ${applied.length} applied, ${skipped.length} already up to date.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
