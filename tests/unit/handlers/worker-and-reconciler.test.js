import { describe, expect, it, vi } from 'vitest';
import { createSilentLogger } from '#tests/helpers/logger.js';
import { createReconcilerHandler } from '#src/handlers/reconciler.js';
import { createWorkerHandler } from '#src/handlers/worker.js';
import { encodeJobMessage } from '#src/infrastructure/queue/job-message.js';

const logger = createSilentLogger();

const record = (id, transactionId, receiveCount) => ({
  messageId: id,
  body: encodeJobMessage(transactionId),
  attributes: { ApproximateReceiveCount: String(receiveCount) },
});

describe('worker handler', () => {
  const setup = (impl = async () => 'processed') => {
    const transactionsService = { processTransaction: vi.fn(impl) };
    const handler = createWorkerHandler({ transactionsService, logger, maxReceiveCount: 5 });
    return { transactionsService, handler };
  };

  it('processes every record and reports no failures', async () => {
    const { handler, transactionsService } = setup();

    const result = await handler({ Records: [record('m1', 'txn_1', 1), record('m2', 'txn_2', 1)] });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(
      transactionsService.processTransaction.mock.calls.map(([job]) => job.transactionId),
    ).toEqual(['txn_1', 'txn_2']);
  });

  it('reports only the failing record, so healthy neighbours are not redelivered', async () => {
    const { handler } = setup(async ({ transactionId }) => {
      if (transactionId === 'txn_bad') throw new Error('gateway timeout');
      return 'processed';
    });

    const result = await handler({
      Records: [record('m1', 'txn_ok', 1), record('m2', 'txn_bad', 1), record('m3', 'txn_ok2', 1)],
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
  });

  it('keeps going after a failure and processes records in order', async () => {
    const { handler, transactionsService } = setup(async ({ transactionId }) => {
      if (transactionId === 'txn_1') throw new Error('boom');
      return 'processed';
    });

    await handler({ Records: [record('m1', 'txn_1', 1), record('m2', 'txn_2', 1)] });

    expect(transactionsService.processTransaction).toHaveBeenCalledTimes(2);
  });

  it.each([
    [1, false],
    [4, false],
    [5, true],
    [6, true],
  ])('receive count %i → isFinalAttempt %s', async (receiveCount, expected) => {
    const { handler, transactionsService } = setup();
    await handler({ Records: [record('m1', 'txn_1', receiveCount)] });
    expect(transactionsService.processTransaction).toHaveBeenCalledWith({
      transactionId: 'txn_1',
      isFinalAttempt: expected,
    });
  });

  it('treats a missing receive count as a first attempt', async () => {
    const { handler, transactionsService } = setup();
    await handler({ Records: [{ messageId: 'm1', body: encodeJobMessage('txn_1') }] });
    expect(transactionsService.processTransaction).toHaveBeenCalledWith({
      transactionId: 'txn_1',
      isFinalAttempt: false,
    });
  });

  it('reports a malformed message without calling the service', async () => {
    const { handler, transactionsService } = setup();

    const result = await handler({
      Records: [{ messageId: 'bad', body: 'not json', attributes: {} }, record('m2', 'txn_2', 1)],
    });

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }] });
    expect(transactionsService.processTransaction).toHaveBeenCalledTimes(1);
  });

  it('hands unstarted records back to SQS when the invocation is running out of time', async () => {
    const { handler, transactionsService } = setup();
    const remaining = vi.fn().mockReturnValueOnce(30_000).mockReturnValue(500);

    const result = await handler(
      { Records: [record('m1', 'txn_1', 1), record('m2', 'txn_2', 1), record('m3', 'txn_3', 1)] },
      { getRemainingTimeInMillis: remaining },
    );

    expect(transactionsService.processTransaction).toHaveBeenCalledTimes(1);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }, { itemIdentifier: 'm3' }]);
  });

  it('tolerates an empty or missing Records array', async () => {
    const { handler } = setup();
    expect(await handler({ Records: [] })).toEqual({ batchItemFailures: [] });
    expect(await handler({})).toEqual({ batchItemFailures: [] });
  });
});

describe('reconciler handler', () => {
  const setup = (result) => {
    const transactionsService = { reenqueueStuck: vi.fn().mockResolvedValue(result) };
    const handler = createReconcilerHandler({
      transactionsService,
      logger,
      olderThanSeconds: 120,
      retryingOlderThanSeconds: 1800,
      batchSize: 100,
    });
    return { transactionsService, handler };
  };

  it('passes its settings to the service and returns the counts', async () => {
    const { handler, transactionsService } = setup({ found: 3, reenqueued: 3 });

    expect(await handler({ source: 'aws.events' })).toEqual({ found: 3, reenqueued: 3 });
    expect(transactionsService.reenqueueStuck).toHaveBeenCalledWith({
      olderThanSeconds: 120,
      retryingOlderThanSeconds: 1800,
      limit: 100,
    });
  });

  it('succeeds quietly when nothing is stuck', async () => {
    const { handler } = setup({ found: 0, reenqueued: 0 });
    await expect(handler({})).resolves.toEqual({ found: 0, reenqueued: 0 });
  });

  it('fails the invocation when some re-queues failed, so the error metric / alarm fires', async () => {
    const { handler } = setup({ found: 5, reenqueued: 3 });
    await expect(handler({})).rejects.toThrow('Re-queued 3 of 5 stuck transactions');
  });
});
