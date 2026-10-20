/**
 * Translation between the public API shape (snake_case JSON) and the domain model (camelCase).
 * Kept in one place so neither the controller nor the service knows the other's naming.
 */

/**
 * Validated webhook body → domain input. The currency is normalised to upper case.
 *
 * @param {{
 *   transaction_id: string,
 *   source_account: string,
 *   destination_account: string,
 *   amount: number,
 *   currency: string,
 * }} body
 * @returns {import('./transactions.repository.js').NewTransaction}
 */
export function toNewTransaction(body) {
  return {
    transactionId: body.transaction_id,
    sourceAccount: body.source_account,
    destinationAccount: body.destination_account,
    amount: body.amount,
    currency: body.currency.toUpperCase(),
  };
}

/**
 * Stored transaction → public API shape.
 * `amount` becomes a JSON number only here, at the edge; internally it stays an exact decimal string.
 *
 * @param {import('./transactions.repository.js').Transaction} txn
 */
export function toPublicTransaction(txn) {
  return {
    transaction_id: txn.transactionId,
    source_account: txn.sourceAccount,
    destination_account: txn.destinationAccount,
    amount: Number(txn.amount),
    currency: txn.currency,
    status: txn.status,
    created_at: txn.createdAt.toISOString(),
    processed_at: txn.processedAt ? txn.processedAt.toISOString() : null,
  };
}
