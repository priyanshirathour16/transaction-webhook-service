/**
 * In-memory queue for local development and tests. NOT durable — never use in production.
 *
 * - `messages` records every successful send (assert on it in tests).
 * - `failNextSend(err)` makes the next send reject (simulates an SQS outage).
 * - `subscribe(handler)` delivers each message to `handler` after its delay (local runs).
 *
 * @param {{ onConsumerError?: (err: unknown) => void }} [options]
 * @returns {import('./job-queue.js').JobQueue & {
 *   messages: { transactionId: string, delaySeconds: number }[],
 *   failNextSend: (err: Error) => void,
 *   subscribe: (handler: (message: { transactionId: string, receiveCount: number }) => unknown) => void,
 * }}
 */
export function createInMemoryJobQueue({ onConsumerError = defaultConsumerErrorHandler } = {}) {
  const messages = [];
  /** @type {Error | undefined} */
  let pendingFailure;
  let consumer;

  return {
    messages,
    failNextSend(err) {
      pendingFailure = err;
    },
    subscribe(handler) {
      consumer = handler;
    },
    async send({ transactionId, delaySeconds }) {
      if (pendingFailure) {
        const err = pendingFailure;
        pendingFailure = undefined;
        throw err;
      }
      messages.push({ transactionId, delaySeconds });
      if (consumer) {
        const handler = consumer;
        const timer = setTimeout(() => {
          Promise.resolve(handler({ transactionId, receiveCount: 1 })).catch(onConsumerError);
        }, delaySeconds * 1000);
        timer.unref();
      }
    },
  };
}

function defaultConsumerErrorHandler(err) {
  // eslint-disable-next-line no-console -- development/test double; a real queue would redeliver
  console.error('in-memory queue consumer failed', err);
}
