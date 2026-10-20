import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '#src/infrastructure/logging/logger.js';

/** A destination that keeps every emitted line, parsed. */
function captureOutput() {
  const lines = [];
  return {
    lines,
    destination: { write: (chunk) => lines.push(JSON.parse(chunk)) },
  };
}

describe('createLogger', () => {
  it('writes structured JSON with an ISO timestamp, string level and service name', () => {
    const { lines, destination } = captureOutput();

    createLogger({ level: 'info', destination }).info({ event: 'demo.event' }, 'hello');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'transaction-webhook-service',
      event: 'demo.event',
      msg: 'hello',
    });
    expect(new Date(lines[0].time).toISOString()).toBe(lines[0].time);
  });

  it('respects the configured level', () => {
    const { lines, destination } = captureOutput();
    const logger = createLogger({ level: 'warn', destination });

    logger.info('dropped');
    logger.warn('kept');

    expect(lines.map((line) => line.msg)).toEqual(['kept']);
  });

  it('redacts secrets nested in logged objects and signature headers', () => {
    const { lines, destination } = captureOutput();

    createLogger({ level: 'info', destination }).info({
      db: { password: 'hunter2' },
      config: { secret: 'webhook-secret' },
      req: {
        headers: {
          authorization: 'Bearer abc',
          'x-webhook-signature': 'sig-1',
          'x-razorpay-signature': 'sig-2',
          'content-type': 'application/json',
        },
      },
    });

    const output = JSON.stringify(lines[0]);
    for (const secret of ['hunter2', 'webhook-secret', 'Bearer abc', 'sig-1', 'sig-2']) {
      expect(output).not.toContain(secret);
    }
    expect(lines[0].req.headers['content-type']).toBe('application/json'); // non-secrets stay
  });

  it('serialises errors with their message and stack', () => {
    const { lines, destination } = captureOutput();

    createLogger({ level: 'info', destination }).error({ err: new Error('boom') }, 'failed');

    expect(lines[0].err).toMatchObject({ type: 'Error', message: 'boom' });
    expect(lines[0].err.stack).toContain('boom');
  });
});

describe('getLogger', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('is a process-wide singleton using LOG_LEVEL from the environment', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://unused');
    vi.stubEnv('QUEUE_DRIVER', 'memory');
    vi.stubEnv('LOG_LEVEL', 'error');
    const { getLogger } = await import('#src/infrastructure/logging/logger.js');

    const first = getLogger();

    expect(getLogger()).toBe(first);
    expect(first.level).toBe('error');
  });
});
