/**
 * Wire format of a queue message. It carries only the transaction id: the database row is the
 * source of truth, so a delayed / duplicated / replayed message can never carry stale data.
 */

/** @param {string} transactionId */
export function encodeJobMessage(transactionId) {
  return JSON.stringify({ transaction_id: transactionId });
}

/**
 * @param {string} body
 * @returns {{ transactionId: string }}
 */
export function decodeJobMessage(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Malformed job message: body is not valid JSON');
  }
  const id = parsed?.transaction_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Malformed job message: transaction_id missing');
  }
  return { transactionId: id };
}
