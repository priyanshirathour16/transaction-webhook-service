/**
 * The port the business logic depends on. Adapters: `sqs-job-queue.js` (AWS) and
 * `in-memory-job-queue.js` (local runs and tests).
 *
 * @typedef {object} JobQueue
 * @property {(job: { transactionId: string, delaySeconds: number }) => Promise<void>} send
 *   Enqueue a job to be delivered after `delaySeconds`. Rejects if it could not be queued.
 */

export {};
