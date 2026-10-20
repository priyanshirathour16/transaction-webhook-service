import { createPool } from '#src/infrastructure/database/postgres-pool.js';

const LOCAL_ADMIN_URL = 'postgres://postgres:postgres@localhost:5433/postgres';
const LOCAL_TEST_URL = 'postgres://postgres:postgres@localhost:5433/transactions_test';

/** Connection string of the database integration tests run against. */
export function getTestDatabaseUrl() {
  return process.env.TEST_DATABASE_URL ?? LOCAL_TEST_URL;
}

/**
 * Pool for integration tests. Uses TEST_DATABASE_URL when set (e.g. CI service container);
 * otherwise a dedicated `transactions_test` database on the docker-compose Postgres, created on
 * demand so tests never touch the development database.
 *
 * @param {number} [max]
 */
export async function createTestPool(max = 2) {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return createPool(explicit, { ssl: false, max });

  const admin = createPool(LOCAL_ADMIN_URL, { ssl: false, max: 1 });
  try {
    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = 'transactions_test'",
    );
    if (exists.rowCount === 0) await admin.query('CREATE DATABASE transactions_test');
  } finally {
    await admin.end();
  }
  return createPool(LOCAL_TEST_URL, { ssl: false, max });
}

/**
 * Wipes everything so each test file starts from an empty database.
 * @param {import('pg').Pool} pool
 */
export async function resetSchema(pool) {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
}
