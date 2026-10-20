import { MAX_TRANSACTION_ID_LENGTH } from './transactions.constants.js';

const TRANSACTION_ID_PATTERN = '^[A-Za-z0-9_.:-]+$';
const CURRENCY_PATTERN = '^[A-Za-z]{3}$';

/**
 * JSON Schema for the webhook body.
 *
 * Strict on types (no coercion: "1500" is not a number, 123 is not an id), lenient on unknown
 * extra fields (processors add fields over time; we simply ignore them).
 * `amount` is limited to what the numeric(20,4) column can hold exactly.
 */
export const webhookBodySchema = {
  type: 'object',
  required: ['transaction_id', 'source_account', 'destination_account', 'amount', 'currency'],
  properties: {
    transaction_id: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_TRANSACTION_ID_LENGTH,
      pattern: TRANSACTION_ID_PATTERN,
    },
    source_account: { type: 'string', minLength: 1, maxLength: 128 },
    destination_account: { type: 'string', minLength: 1, maxLength: 128 },
    amount: { type: 'number', exclusiveMinimum: 0, maximum: 999999999999, multipleOf: 0.0001 },
    currency: { type: 'string', pattern: CURRENCY_PATTERN },
  },
};
