import { describe, expect, it, vi } from 'vitest';
import { decodeJobMessage, encodeJobMessage } from '#src/infrastructure/queue/job-message.js';
import { createInMemoryJobQueue } from '#src/infrastructure/queue/in-memory-job-queue.js';
import { createSqsJobQueue } from '#src/infrastructure/queue/sqs-job-queue.js';

describe('job message codec', () => {
  it('round-trips a transaction id', () => {
    expect(decodeJobMessage(encodeJobMessage('txn_1'))).toEqual({ transactionId: 'txn_1' });
  });

  it.each(['not json', '{}', '{"transaction_id":""}', '{"transaction_id":42}', 'null'])(
    'rejects malformed body %j',
    (body) => {
      expect(() => decodeJobMessage(body)).toThrow(/Malformed job message/);
    },
  );
});

describe('createSqsJobQueue', () => {
  it('sends the id with the requested DelaySeconds to the configured queue', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };
    const queue = createSqsJobQueue({ client, queueUrl: 'https://sqs/q' });

    await queue.send({ transactionId: 'txn_1', delaySeconds: 30 });

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0].input).toEqual({
      QueueUrl: 'https://sqs/q',
      MessageBody: '{"transaction_id":"txn_1"}',
      DelaySeconds: 30,
    });
  });

  it.each([-1, 901, 1.5, Number.NaN])('rejects invalid delay %s before calling SQS', async (d) => {
    const client = { send: vi.fn() };
    const queue = createSqsJobQueue({ client, queueUrl: 'q' });
    await expect(queue.send({ transactionId: 'txn_1', delaySeconds: d })).rejects.toThrow(
      RangeError,
    );
    expect(client.send).not.toHaveBeenCalled();
  });

  it('propagates SQS failures so the caller can answer 5xx', async () => {
    const client = { send: vi.fn().mockRejectedValue(new Error('SQS down')) };
    const queue = createSqsJobQueue({ client, queueUrl: 'q' });
    await expect(queue.send({ transactionId: 'txn_1', delaySeconds: 30 })).rejects.toThrow(
      'SQS down',
    );
  });
});

describe('createInMemoryJobQueue', () => {
  it('records sends and can simulate a single outage', async () => {
    const queue = createInMemoryJobQueue();
    queue.failNextSend(new Error('boom'));

    await expect(queue.send({ transactionId: 'a', delaySeconds: 1 })).rejects.toThrow('boom');
    await queue.send({ transactionId: 'a', delaySeconds: 1 });

    expect(queue.messages).toEqual([{ transactionId: 'a', delaySeconds: 1 }]);
  });

  it('delivers to a subscriber after the delay', async () => {
    vi.useFakeTimers();
    try {
      const queue = createInMemoryJobQueue();
      const handler = vi.fn();
      queue.subscribe(handler);

      await queue.send({ transactionId: 'a', delaySeconds: 30 });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(handler).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(handler).toHaveBeenCalledWith({ transactionId: 'a', receiveCount: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createInMemoryJobQueue consumer errors', () => {
  it('reports a failing consumer through onConsumerError instead of crashing the process', async () => {
    vi.useFakeTimers();
    try {
      const onConsumerError = vi.fn();
      const queue = createInMemoryJobQueue({ onConsumerError });
      queue.subscribe(() => Promise.reject(new Error('consumer boom')));

      await queue.send({ transactionId: 'a', delaySeconds: 1 });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(onConsumerError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'consumer boom' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs to the console by default', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const queue = createInMemoryJobQueue();
      queue.subscribe(() => Promise.reject(new Error('consumer boom')));

      await queue.send({ transactionId: 'a', delaySeconds: 1 });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });
});
