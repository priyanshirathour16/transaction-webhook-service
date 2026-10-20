import { describe, expect, it, vi } from 'vitest';
import { TransactionNotFoundError } from '#src/modules/transactions/transactions.errors.js';
import { createTransactionsRepository } from '#src/modules/transactions/transactions.repository.js';

const txn = {
  transactionId: 'txn_1',
  sourceAccount: 'a',
  destinationAccount: 'b',
  amount: 10,
  currency: 'INR',
};

describe('insertIfAbsent', () => {
  it('fails loudly if a conflict was reported but the row has vanished (concurrent delete)', async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // INSERT ... ON CONFLICT DO NOTHING
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }), // SELECT finds nothing
    };

    await expect(createTransactionsRepository(pool).insertIfAbsent(txn)).rejects.toBeInstanceOf(
      TransactionNotFoundError,
    );
  });

  it('uses only unnamed statements, as Supabase transaction pooling requires', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };

    await createTransactionsRepository(pool)
      .insertIfAbsent(txn)
      .catch(() => {});

    for (const [statement] of pool.query.mock.calls) {
      expect(typeof statement).toBe('string'); // a config object with `name` would be a prepared statement
    }
  });
});
