import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig, parseDatabaseConfig } from '#src/config/env.js';

const base = { DATABASE_URL: 'postgres://u:p@host:6543/db', QUEUE_URL: 'https://sqs/queue' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    const config = parseConfig(base);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      DB_SSL: 'require',
      DB_POOL_MAX: 1,
      QUEUE_DRIVER: 'sqs',
      PROCESS_DELAY_SECONDS: 30,
      MAX_RECEIVE_COUNT: 5,
      REPAIR_GRACE_SECONDS: 10,
      RECONCILE_AFTER_SECONDS: 120,
    });
    expect(config.DATABASE_URL_DIRECT).toBeUndefined();
  });

  it('coerces numeric settings from strings', () => {
    const config = parseConfig({ ...base, DB_POOL_MAX: '3', PROCESS_DELAY_SECONDS: '45' });
    expect(config.DB_POOL_MAX).toBe(3);
    expect(config.PROCESS_DELAY_SECONDS).toBe(45);
  });

  it('fails fast with a readable message when DATABASE_URL is missing', () => {
    expect(() => parseConfig({ QUEUE_URL: 'x' })).toThrow(/Invalid configuration: DATABASE_URL/);
  });

  it('rejects invalid enum values', () => {
    expect(() => parseConfig({ ...base, DB_SSL: 'maybe' })).toThrow(/DB_SSL/);
  });

  it('requires QUEUE_URL for the sqs driver but not for the memory driver', () => {
    expect(() => parseConfig({ DATABASE_URL: 'x' })).toThrow(/QUEUE_URL is required/);
    expect(parseConfig({ DATABASE_URL: 'x', QUEUE_DRIVER: 'memory' }).QUEUE_DRIVER).toBe('memory');
  });

  it('rejects a reconcile threshold that would re-queue healthy delayed jobs', () => {
    expect(() =>
      parseConfig({ ...base, PROCESS_DELAY_SECONDS: '30', RECONCILE_AFTER_SECONDS: '30' }),
    ).toThrow(/greater than PROCESS_DELAY_SECONDS/);
  });

  it('defaults the retrying threshold to 30 minutes and rejects one below the base threshold', () => {
    expect(parseConfig(base).RECONCILE_RETRYING_AFTER_SECONDS).toBe(1800);
    expect(() => parseConfig({ ...base, RECONCILE_RETRYING_AFTER_SECONDS: '60' })).toThrow(
      /RECONCILE_RETRYING_AFTER_SECONDS/,
    );
  });

  it('rejects a delay beyond the SQS maximum', () => {
    expect(() => parseConfig({ ...base, PROCESS_DELAY_SECONDS: '901' })).toThrow(
      /PROCESS_DELAY_SECONDS/,
    );
  });
});

describe('parseDatabaseConfig', () => {
  it('needs only database settings, so migrations run without queue configuration', () => {
    const config = parseDatabaseConfig({ DATABASE_URL: 'postgres://u:p@host:5432/db' });
    expect(config).toMatchObject({ DB_SSL: 'require', DB_POOL_MAX: 1 });
    expect(config).not.toHaveProperty('QUEUE_URL');
  });

  it('still fails fast without DATABASE_URL', () => {
    expect(() => parseDatabaseConfig({})).toThrow(/Invalid configuration: DATABASE_URL/);
  });
});

describe('getConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reads process.env once and reuses the result across calls', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@host:6543/db');
    vi.stubEnv('QUEUE_DRIVER', 'memory');
    vi.stubEnv('LOG_LEVEL', 'info');
    const { getConfig } = await import('#src/config/env.js');

    const first = getConfig();
    vi.stubEnv('LOG_LEVEL', 'debug'); // changing the environment afterwards has no effect

    expect(getConfig()).toBe(first);
    expect(first.LOG_LEVEL).toBe('info');
  });

  it('throws a readable error when the environment is invalid', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { getConfig } = await import('#src/config/env.js');
    expect(() => getConfig()).toThrow(/Invalid configuration/);
  });
});
