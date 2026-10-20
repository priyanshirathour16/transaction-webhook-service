import { describe, expect, it } from 'vitest';
import {
  createPool,
  DEFAULT_CONNECTION_TIMEOUT_MS,
} from '#src/infrastructure/database/postgres-pool.js';

const url = 'postgres://u:p@localhost:5433/db'; // never connected: pools connect lazily

describe('createPool', () => {
  it('fails fast by default: 3 s to connect, which is plenty next to the database', async () => {
    const pool = createPool(url, { ssl: false, max: 1 });
    expect(pool.options.connectionTimeoutMillis).toBe(DEFAULT_CONNECTION_TIMEOUT_MS);
    expect(DEFAULT_CONNECTION_TIMEOUT_MS).toBe(3_000);
    await pool.end();
  });

  it('lets command-line tools allow far longer, for connections made across continents', async () => {
    const pool = createPool(url, { ssl: false, max: 1, connectionTimeoutMillis: 20_000 });
    expect(pool.options.connectionTimeoutMillis).toBe(20_000);
    await pool.end();
  });

  it('applies the pool size and TLS settings it is given', async () => {
    const secure = createPool(url, { ssl: true, max: 3 });
    expect(secure.options.max).toBe(3);
    expect(secure.options.ssl).toEqual({ rejectUnauthorized: false });
    const plain = createPool(url, { ssl: false, max: 1 });
    expect(plain.options.ssl).toBe(false);
    await Promise.all([secure.end(), plain.end()]);
  });
});
