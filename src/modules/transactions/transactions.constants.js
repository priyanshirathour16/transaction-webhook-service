/** Lifecycle of a transaction. Mirrors the CHECK constraint in migrations/0001. */
export const TRANSACTION_STATUS = Object.freeze({
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
});

/** Result of one processing attempt (see TransactionsRepository#processWithLock). */
export const PROCESS_OUTCOME = Object.freeze({
  PROCESSED: 'processed',
  ALREADY_DONE: 'already_done',
});

/** Longest transaction id accepted in a URL or body. */
export const MAX_TRANSACTION_ID_LENGTH = 128;
