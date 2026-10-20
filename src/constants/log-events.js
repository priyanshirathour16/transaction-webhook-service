/**
 * Structured-log `event` names. Dashboards, alarms and metric filters key off these strings
 * (see template.yaml: `request.failed` and `txn.failed`), so treat them as a stable contract.
 */
export const LOG_EVENT = Object.freeze({
  // HTTP
  REQUEST_COMPLETED: 'request.completed',
  REQUEST_REJECTED: 'request.rejected',
  REQUEST_FAILED: 'request.failed',

  // Webhook intake
  WEBHOOK_ACCEPTED: 'webhook.accepted',
  WEBHOOK_DUPLICATE: 'webhook.duplicate',
  WEBHOOK_REENQUEUED: 'webhook.reenqueued',
  WEBHOOK_PAYLOAD_MISMATCH: 'webhook.payload_mismatch',
  WEBHOOK_SIGNATURE_REJECTED: 'webhook.signature_rejected',

  // Background processing
  TXN_PROCESSED: 'txn.processed',
  TXN_ALREADY_DONE: 'txn.already_done',
  TXN_RETRY: 'txn.retry',
  TXN_FAILED: 'txn.failed',
  WORKER_MALFORMED_MESSAGE: 'worker.malformed_message',
  WORKER_OUT_OF_TIME: 'worker.out_of_time',

  // Reconciler
  RECONCILER_RUN: 'reconciler.run',
  RECONCILER_REENQUEUED: 'reconciler.reenqueued',
  RECONCILER_ENQUEUE_FAILED: 'reconciler.enqueue_failed',

  // Local tooling
  DEV_SERVER_LISTENING: 'dev_server.listening',
});
