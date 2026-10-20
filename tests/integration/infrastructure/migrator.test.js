import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '#src/infrastructure/database/migrator.js';
import { createTestPool, resetSchema } from '#tests/helpers/database.js';

/** @type {import('pg').Pool} */
let pool;

beforeAll(async () => {
  pool = await createTestPool();
  await resetSchema(pool);
});
afterAll(async () => {
  await pool.end();
});

describe('runMigrations (requires Postgres: npm run db:up)', () => {
  it('applies the real migrations and is idempotent on re-run', async () => {
    const first = await runMigrations(pool, resolve('migrations'));
    expect(first.applied).toContain('0001_create_transactions.sql');

    const second = await runMigrations(pool, resolve('migrations'));
    expect(second.applied).toEqual([]);
    expect(second.skipped).toContain('0001_create_transactions.sql');
    expect(first.applied).toContain('0002_enable_row_level_security.sql');
  });

  it('locks both tables against API roles: RLS is on, so a role with no policy sees no rows', async () => {
    // Supabase exposes the public schema through a REST API for the anon/authenticated roles.
    // With row-level security on and no policies, those roles must read nothing.
    const flags = await pool.query(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname IN ('transactions', 'schema_migrations') ORDER BY relname`,
    );
    expect(flags.rows).toEqual([
      { relname: 'schema_migrations', relrowsecurity: true },
      { relname: 'transactions', relrowsecurity: true },
    ]);

    // Behavioural proof, not just the flag: a low-privilege role with SELECT rights still sees nothing.
    await pool.query(
      `INSERT INTO transactions (transaction_id, source_account, destination_account, amount, currency)
       VALUES ('txn_rls_probe', 'a', 'b', 1, 'INR') ON CONFLICT DO NOTHING`,
    );
    await pool.query('DROP ROLE IF EXISTS rls_probe');
    await pool.query('CREATE ROLE rls_probe');
    const client = await pool.connect();
    try {
      // Like Supabase's API roles: allowed to use the schema and to SELECT. Only RLS stands in the way.
      await pool.query('GRANT USAGE ON SCHEMA public TO rls_probe');
      await pool.query('GRANT SELECT ON transactions TO rls_probe');
      await client.query('SET ROLE rls_probe');
      const asApiRole = await client.query('SELECT count(*)::int AS n FROM transactions');
      expect(asApiRole.rows[0].n).toBe(0);
      await client.query('RESET ROLE');
      const asOwner = await client.query(
        "SELECT count(*)::int AS n FROM transactions WHERE transaction_id = 'txn_rls_probe'",
      );
      expect(asOwner.rows[0].n).toBe(1); // the service's own connection still sees its rows
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
      await pool.query('REVOKE ALL ON transactions FROM rls_probe');
      await pool.query('REVOKE ALL ON SCHEMA public FROM rls_probe');
      await pool.query('DROP ROLE rls_probe');
      await pool.query("DELETE FROM transactions WHERE transaction_id = 'txn_rls_probe'");
    }
  });

  it('enforces idempotency key and data constraints', async () => {
    const insert = (id, amount, currency = 'INR') =>
      pool.query(
        `INSERT INTO transactions (transaction_id, source_account, destination_account, amount, currency)
         VALUES ($1, 'acc_a', 'acc_b', $2, $3)
         ON CONFLICT (transaction_id) DO NOTHING`,
        [id, amount, currency],
      );

    expect((await insert('txn_1', 1500)).rowCount).toBe(1);
    expect((await insert('txn_1', 1500)).rowCount).toBe(0); // duplicate → no-op, no error
    await expect(insert('txn_2', -5)).rejects.toThrow(/amount_positive/);
    await expect(insert('txn_3', 10, 'inr')).rejects.toThrow(/currency_format/);

    const row = await pool.query(
      'SELECT status, processed_at, amount FROM transactions WHERE transaction_id = $1',
      ['txn_1'],
    );
    expect(row.rows[0]).toMatchObject({
      status: 'PROCESSING',
      processed_at: null,
      amount: '1500.0000',
    });
  });

  it('rejects a modified, already-applied migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    try {
      await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE drift_check (id int);');
      await runMigrations(pool, dir);
      await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE drift_check (id bigint);');
      await expect(runMigrations(pool, dir)).rejects.toThrow(/modified after being applied/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failing migration without recording it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    try {
      await writeFile(join(dir, '0002_bad.sql'), 'CREATE TABLE half_done (id int); SELECT 1/0;');
      await expect(runMigrations(pool, dir)).rejects.toThrow(/0002_bad.sql failed/);
      const table = await pool.query("SELECT to_regclass('public.half_done') AS t");
      expect(table.rows[0].t).toBeNull();
      const recorded = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE name = '0002_bad.sql'",
      );
      expect(recorded.rowCount).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
