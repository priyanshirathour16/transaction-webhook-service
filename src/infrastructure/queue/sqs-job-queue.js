import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { encodeJobMessage } from './job-message.js';

// SQS caps per-message delay at 15 minutes.
const SQS_MAX_DELAY_SECONDS = 900;

/**
 * SQS adapter. `DelaySeconds` is what provides the 30 s wait: no process sleeps, nothing is lost
 * on restart, and Lambda is not billed while the message is invisible.
 *
 * @param {{ client: { send: (command: SendMessageCommand) => Promise<unknown> }, queueUrl: string }} deps
 * @returns {import('./job-queue.js').JobQueue}
 */
export function createSqsJobQueue({ client, queueUrl }) {
  return {
    async send({ transactionId, delaySeconds }) {
      if (
        !Number.isInteger(delaySeconds) ||
        delaySeconds < 0 ||
        delaySeconds > SQS_MAX_DELAY_SECONDS
      ) {
        throw new RangeError(
          `delaySeconds must be an integer between 0 and ${SQS_MAX_DELAY_SECONDS}`,
        );
      }
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: encodeJobMessage(transactionId),
          DelaySeconds: delaySeconds,
        }),
      );
    },
  };
}
