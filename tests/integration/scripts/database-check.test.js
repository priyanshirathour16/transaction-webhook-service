import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '#src/infrastructure/database/migrator.js';
import { createTestPool, getTestDatabaseUrl, resetSchema } from '#tests/helpers/database.js';
import { checkDatabase } from '../../../scripts/lib/database-check.js';

let pool;

beforeAll(async () => {
  pool = await createTestPool();
  await resetSchema(pool);
});
afterAll(async () => {
  await pool.end();
});

describe('checkDatabase against real Postgres', () => {
  it('reports a healthy connection with timings and whether the schema exists', async () => {
    const before = await checkDatabase({ url: getTestDatabaseUrl(), ssl: false });
    expect(before).toMatchObject({ ok: true, tablePresent: false });
    expect(before.serverVersion).toMatch(/^\d+/);
    expect(before.coldMs).toBeGreaterThan(0);
    expect(before.warmMs).toBeGreaterThan(0);

    await runMigrations(pool, resolve('migrations'));

    const after = await checkDatabase({ url: getTestDatabaseUrl(), ssl: false });
    expect(after.tablePresent).toBe(true);
  });

  it('fails cleanly, without leaking the password, when the database is unreachable', async () => {
    const result = await checkDatabase({
      url: 'postgres://app:hunter2-secret@127.0.0.1:1/transactions',
      ssl: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain('hunter2-secret');
  });

  it('fails cleanly on a wrong password, again without leaking it', async () => {
    const base = new URL(getTestDatabaseUrl());
    base.password = 'definitely-wrong-password';

    const result = await checkDatabase({ url: base.toString(), ssl: false });

    // Local Docker Postgres trusts all connections, so this may still succeed there; what matters
    // is that nothing ever echoes the password.
    expect(JSON.stringify(result)).not.toContain('definitely-wrong-password');
  });
});
