import { pino } from 'pino';
import { getConfig } from '#src/config/env.js';

const SERVICE_NAME = 'transaction-webhook-service';

// Never log secrets, even if a request/connection object slips into a log call.
const REDACTED_PATHS = [
  '*.password',
  '*.secret',
  'req.headers.authorization',
  'req.headers["x-webhook-signature"]',
  'req.headers["x-razorpay-signature"]',
];

/**
 * Structured JSON logger (CloudWatch-friendly): ISO timestamps, level as a string, service name.
 *
 * @param {{ level: string, destination?: import('pino').DestinationStream }} options
 *        `destination` defaults to stdout; tests pass a stream to inspect the output.
 * @returns {import('pino').Logger}
 */
export function createLogger({ level, destination }) {
  return pino(
    {
      level,
      base: { service: SERVICE_NAME },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: REDACTED_PATHS,
    },
    destination,
  );
}

/** @type {import('pino').Logger | undefined} */
let root;

/** Process-wide logger. Created lazily so a bad configuration surfaces on first use. */
export function getLogger() {
  root ??= createLogger({ level: getConfig().LOG_LEVEL });
  return root;
}
