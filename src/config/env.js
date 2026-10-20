import { z } from 'zod';

const databaseShape = {
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Migrations need a direct/session connection; falls back to DATABASE_URL when unset.
  DATABASE_URL_DIRECT: z.string().min(1).optional(),
  DB_SSL: z.enum(['require', 'disable']).default('require'),
  // One connection per Lambda container: concurrency is bounded by Lambda, not by the pool.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(1),
};

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    ...databaseShape,

    // When set, webhooks must carry a valid HMAC-SHA256 signature of the raw body. Unset = no check.
    WEBHOOK_SECRET: z.string().min(8, 'WEBHOOK_SECRET must be at least 8 characters').optional(),

    // "sqs" in AWS; "memory" is for local runs/tests only (not durable).
    QUEUE_DRIVER: z.enum(['sqs', 'memory']).default('sqs'),
    QUEUE_URL: z.string().min(1).optional(),
    // Wait before a new transaction is processed. SQS supports up to 900 s.
    PROCESS_DELAY_SECONDS: z.coerce.number().int().min(0).max(900).default(30),
    // Must match the queue's redrive policy (maxReceiveCount) so the last attempt is recognised.
    MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).max(100).default(5),
    // A duplicate webhook younger than this is assumed to be racing the original request.
    REPAIR_GRACE_SECONDS: z.coerce.number().int().min(0).default(10),
    // Reconciler: re-queue transactions untouched for this long (must exceed PROCESS_DELAY_SECONDS).
    RECONCILE_AFTER_SECONDS: z.coerce.number().int().min(1).default(120),
    // Same, for transactions already attempted: their message is cycling through SQS retries
    // (up to MAX_RECEIVE_COUNT x queue visibility timeout), so leave them alone for longer.
    RECONCILE_RETRYING_AFTER_SECONDS: z.coerce.number().int().min(1).default(1800),
    RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  })
  .superRefine((env, ctx) => {
    if (env.QUEUE_DRIVER === 'sqs' && !env.QUEUE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['QUEUE_URL'],
        message: 'QUEUE_URL is required when QUEUE_DRIVER=sqs',
      });
    }
    if (env.RECONCILE_RETRYING_AFTER_SECONDS < env.RECONCILE_AFTER_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['RECONCILE_RETRYING_AFTER_SECONDS'],
        message: 'must not be smaller than RECONCILE_AFTER_SECONDS',
      });
    }
    if (env.RECONCILE_AFTER_SECONDS <= env.PROCESS_DELAY_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['RECONCILE_AFTER_SECONDS'],
        message: 'must be greater than PROCESS_DELAY_SECONDS or healthy jobs would be re-queued',
      });
    }
  });

const databaseSchema = z.object(databaseShape);

/** @typedef {z.infer<typeof envSchema>} Config */

/** @param {z.ZodType} schema @param {NodeJS.ProcessEnv} env */
function parseWith(schema, env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return result.data;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Config}
 */
export function parseConfig(env) {
  return parseWith(envSchema, env);
}

/**
 * Database-only settings, for tools (migrations) that must not require queue configuration.
 * @param {NodeJS.ProcessEnv} env
 * @returns {z.infer<typeof databaseSchema>}
 */
export function parseDatabaseConfig(env) {
  return parseWith(databaseSchema, env);
}

/** @type {Config | undefined} */
let cached;

/** Parsed once per container and reused across invocations. */
export function getConfig() {
  cached ??= parseConfig(process.env);
  return cached;
}
