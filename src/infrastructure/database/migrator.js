import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Arbitrary constant: serialises concurrent migrators (e.g. two CI runs) on one database.
const MIGRATION_LOCK_ID = 727_001;

/**
 * @typedef {{ applied: string[], skipped: string[] }} MigrationResult
 */

/**
 * @param {string} dir
 * @returns {Promise<{ name: string, sql: string, checksum: string }[]>}
 */
async function loadMigrationFiles(dir) {
  const names = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

/**
 * Applies pending `.sql` files in filename order. Each file runs in its own transaction together
 * with its bookkeeping row, so a failed migration leaves no partial state.
 * Previously applied files are checksum-verified to catch edits to history.
 *
 * @param {import('pg').Pool} pool
 * @param {string} dir
 * @returns {Promise<MigrationResult>}
 */
export async function runMigrations(pool, dir) {
  const files = await loadMigrationFiles(dir);
  const client = await pool.connect();
  /** @type {MigrationResult} */
  const result = { applied: [], skipped: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    // Same reasoning as migration 0002: keep this bookkeeping table out of Supabase's public API.
    await client.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');

    const existing = await client.query('SELECT name, checksum FROM schema_migrations');
    const appliedChecksums = new Map(existing.rows.map((row) => [row.name, row.checksum]));

    for (const file of files) {
      const previous = appliedChecksums.get(file.name);
      if (previous !== undefined) {
        if (previous !== file.checksum) {
          throw new Error(`Migration ${file.name} was modified after being applied`);
        }
        result.skipped.push(file.name);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file.name} failed: ${err.message}`, { cause: err });
      }
      result.applied.push(file.name);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
