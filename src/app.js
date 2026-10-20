import express from 'express';
import { errorHandler } from '#src/middlewares/error-handler.middleware.js';
import { notFoundHandler } from '#src/middlewares/not-found.middleware.js';
import { createRequestContextMiddleware } from '#src/middlewares/request-context.middleware.js';
import { createHealthRouter } from '#src/modules/health/health.routes.js';
import { createTransactionsRouter } from '#src/modules/transactions/transactions.routes.js';

/**
 * Builds the Express application. It never listens on a port: a local server
 * (scripts/dev-server.js) or the Lambda adapter (handlers/api.js) hosts it, so the same app runs
 * in development, in tests and in AWS.
 *
 * The HTTP layer knows nothing about SQS or Postgres. It talks to the transactions service only,
 * which keeps the request path short and the app testable without AWS.
 *
 * @param {{
 *   transactionsService: import('#src/modules/transactions/transactions.service.js').TransactionsService,
 *   logger: import('pino').Logger,
 *   webhookSecret?: string,
 *   now?: () => Date,
 * }} deps
 * @returns {import('express').Express}
 */
export function createApp({ transactionsService, logger, webhookSecret, now }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(createRequestContextMiddleware({ logger }));

  app.use(createHealthRouter({ now }));
  app.use(createTransactionsRouter({ transactionsService, webhookSecret }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
