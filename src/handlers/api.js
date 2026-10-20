import serverlessExpress from '@codegenie/serverless-express';
import { createApp } from '#src/app.js';
import { getContainer } from '#src/container.js';
import { getPool } from '#src/infrastructure/database/postgres-pool.js';
import { getLogger } from '#src/infrastructure/logging/logger.js';

/**
 * Builds a Lambda handler around an app factory. The app is created once per container (cold
 * start) and reused by every warm invocation. Function URL events (payload format 2.0) are
 * translated to normal Express requests, including base64-encoded bodies.
 *
 * Also answers the scheduled warm-up ping: it opens the DB connection ahead of real traffic so
 * the first webhook after an idle period does not pay for TLS + auth inside the 500 ms budget.
 *
 * @param {() => import('express').Express} createExpressApp
 * @param {() => Promise<unknown>} [warmUp]
 */
export function createApiHandler(
  createExpressApp,
  warmUp = async () => getPool().query('SELECT 1'),
) {
  /** @type {ReturnType<typeof serverlessExpress> | undefined} */
  let proxy;
  const getProxy = () => (proxy ??= serverlessExpress({ app: createExpressApp() }));

  return async (event, context) => {
    if (event?.source === 'aws.events' || event?.warmup === true) {
      await warmUp();
      getProxy();
      return { warmed: true };
    }
    return getProxy()(event, context);
  };
}

export const handler = createApiHandler(() => {
  const { config, transactionsService } = getContainer();
  return createApp({
    transactionsService,
    logger: getLogger(),
    webhookSecret: config.WEBHOOK_SECRET,
  });
});
