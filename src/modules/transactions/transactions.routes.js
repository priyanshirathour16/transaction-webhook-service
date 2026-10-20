import { Router } from 'express';
import { parseJsonBody } from '#src/middlewares/parse-json-body.middleware.js';
import { requireJson } from '#src/middlewares/require-json.middleware.js';
import { validateBody } from '#src/middlewares/validate-body.middleware.js';
import { createVerifyWebhookSignatureMiddleware } from '#src/middlewares/verify-webhook-signature.middleware.js';
import { createTransactionsController } from './transactions.controller.js';
import { webhookBodySchema } from './transactions.schema.js';

const API_V1 = '/v1';

/**
 * Routes of the transactions feature.
 *
 * The webhook pipeline order matters: media type → body (raw bytes kept) → signature → schema.
 * Signature is checked before validation so unsigned callers learn nothing about the schema.
 *
 * @param {{
 *   transactionsService: import('./transactions.service.js').TransactionsService,
 *   webhookSecret?: string,
 * }} deps
 */
export function createTransactionsRouter({ transactionsService, webhookSecret }) {
  const router = Router();
  const controller = createTransactionsController({ transactionsService });

  router.post(
    `${API_V1}/webhooks/transactions`,
    requireJson,
    parseJsonBody,
    createVerifyWebhookSignatureMiddleware({ secret: webhookSecret }),
    validateBody(webhookBodySchema),
    controller.receiveWebhook,
  );

  router.get(`${API_V1}/transactions/:transactionId`, controller.getTransaction);

  return router;
}
