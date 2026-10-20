import { ERROR_CODE } from '#src/constants/error-codes.js';
import { HTTP_STATUS } from '#src/constants/http-status.js';
import { createErrorBody, ValidationError } from '#src/errors/http-errors.js';
import { MAX_TRANSACTION_ID_LENGTH } from './transactions.constants.js';
import { toNewTransaction } from './transactions.mapper.js';

/**
 * HTTP adapter for the transactions feature: translates requests into service calls and results
 * into responses. Business rules live in the service, never here.
 *
 * @param {{ transactionsService: import('./transactions.service.js').TransactionsService }} deps
 */
export function createTransactionsController({ transactionsService }) {
  return {
    /** POST /v1/webhooks/transactions — acknowledge fast; the real work happens in the background. */
    receiveWebhook: async (req, res) => {
      const { duplicate } = await transactionsService.receiveWebhook(toNewTransaction(req.body), {
        logger: req.log, // service log lines carry the same request_id
      });
      res.status(HTTP_STATUS.ACCEPTED).json({ status: 'ACCEPTED', duplicate });
    },

    /** GET /v1/transactions/:transactionId — returns a one-element array, as specified. */
    getTransaction: async (req, res) => {
      const { transactionId } = req.params;
      if (transactionId.length > MAX_TRANSACTION_ID_LENGTH) {
        throw new ValidationError([
          {
            field: 'transaction_id',
            message: `must NOT have more than ${MAX_TRANSACTION_ID_LENGTH} characters`,
          },
        ]);
      }

      const result = await transactionsService.getTransaction(transactionId);
      if (result.length === 0) {
        return res
          .status(HTTP_STATUS.NOT_FOUND)
          .json(createErrorBody(ERROR_CODE.TRANSACTION_NOT_FOUND, 'No transaction with that id'));
      }
      res.json(result);
    },
  };
}
