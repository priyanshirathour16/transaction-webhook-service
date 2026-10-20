import { describe, expect, it } from 'vitest';
import { toPublicTransaction } from '#src/modules/transactions/transactions.mapper.js';

const base = {
  transactionId: 'txn_abc123def456',
  sourceAccount: 'acc_user_789',
  destinationAccount: 'acc_merchant_456',
  amount: '150.5000',
  currency: 'USD',
  status: 'PROCESSING',
  createdAt: new Date('2024-01-15T10:30:00Z'),
  enqueuedAt: new Date('2024-01-15T10:30:00Z'),
  processedAt: null,
  attempts: 0,
  lastError: null,
  ageSeconds: 1,
};

describe('toPublicTransaction', () => {
  it('matches the documented response shape while processing', () => {
    expect(toPublicTransaction(base)).toEqual({
      transaction_id: 'txn_abc123def456',
      source_account: 'acc_user_789',
      destination_account: 'acc_merchant_456',
      amount: 150.5,
      currency: 'USD',
      status: 'PROCESSING',
      created_at: '2024-01-15T10:30:00.000Z',
      processed_at: null,
    });
  });

  it('serialises processed_at as ISO-8601 and hides internal fields', () => {
    const view = toPublicTransaction({
      ...base,
      status: 'PROCESSED',
      processedAt: new Date('2024-01-15T10:30:30Z'),
    });
    expect(view.processed_at).toBe('2024-01-15T10:30:30.000Z');
    expect(view).not.toHaveProperty('attempts');
    expect(view).not.toHaveProperty('enqueuedAt');
    expect(view).not.toHaveProperty('last_error');
  });
});
