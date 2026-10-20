export class TransactionNotFoundError extends Error {
  /** @param {string} transactionId */
  constructor(transactionId) {
    super(`Transaction ${transactionId} not found`);
    this.name = 'TransactionNotFoundError';
    this.transactionId = transactionId;
  }
}
