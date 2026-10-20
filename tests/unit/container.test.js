import { afterEach, describe, expect, it, vi } from 'vitest';

// Replace the AWS SDK so nothing leaves the machine; capture what the SQS adapter would send.
const sqs = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue({}) }));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = sqs.send;
  },
  SendMessageCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));

const baseEnv = {
  DATABASE_URL: 'postgres://u:p@localhost:6543/db', // never connected: the pool is lazy
  LOG_LEVEL: 'silent',
  DB_SSL: 'disable',
};

async function loadContainerModule(env) {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...baseEnv, ...env })) vi.stubEnv(key, value);
  return import('#src/container.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  sqs.send.mockClear();
});

describe('buildContainer', () => {
  it('wires the SQS queue (with the configured URL) when QUEUE_DRIVER=sqs', async () => {
    const { buildContainer } = await loadContainerModule({
      QUEUE_DRIVER: 'sqs',
      QUEUE_URL: 'https://sqs.ap-south-1.amazonaws.com/123456789012/transactions',
    });
    const { parseConfig } = await import('#src/config/env.js');

    const { queue } = buildContainer(parseConfig(process.env));
    await queue.send({ transactionId: 'txn_1', delaySeconds: 30 });

    expect(sqs.send).toHaveBeenCalledTimes(1);
    expect(sqs.send.mock.calls[0][0].input).toEqual({
      QueueUrl: 'https://sqs.ap-south-1.amazonaws.com/123456789012/transactions',
      MessageBody: '{"transaction_id":"txn_1"}',
      DelaySeconds: 30,
    });
  });

  it('wires the in-memory queue when QUEUE_DRIVER=memory (and never calls AWS)', async () => {
    const { buildContainer } = await loadContainerModule({ QUEUE_DRIVER: 'memory' });
    const { parseConfig } = await import('#src/config/env.js');

    const { queue } = buildContainer(parseConfig(process.env));
    await queue.send({ transactionId: 'txn_1', delaySeconds: 30 });

    expect(queue.messages).toEqual([{ transactionId: 'txn_1', delaySeconds: 30 }]);
    expect(sqs.send).not.toHaveBeenCalled();
  });

  it('exposes the transactions service and the resolved configuration', async () => {
    const { buildContainer } = await loadContainerModule({
      QUEUE_DRIVER: 'memory',
      PROCESS_DELAY_SECONDS: '45',
    });
    const { parseConfig } = await import('#src/config/env.js');

    const container = buildContainer(parseConfig(process.env));

    expect(container.config.PROCESS_DELAY_SECONDS).toBe(45);
    expect(container.transactionsService).toEqual(
      expect.objectContaining({
        receiveWebhook: expect.any(Function),
        getTransaction: expect.any(Function),
        processTransaction: expect.any(Function),
        reenqueueStuck: expect.any(Function),
      }),
    );
  });
});

describe('getContainer', () => {
  it('builds the container once per process and reuses it', async () => {
    const { getContainer } = await loadContainerModule({ QUEUE_DRIVER: 'memory' });

    expect(getContainer()).toBe(getContainer());
  });
});
