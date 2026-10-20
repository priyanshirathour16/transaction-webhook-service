import { randomUUID } from 'node:crypto';
import { LOG_EVENT } from '#src/constants/log-events.js';

const REQUEST_ID_HEADER = 'x-request-id';

// A caller-supplied request id is echoed back and logged, so only accept a safe shape.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Gives every request an id (`req.id`), a child logger carrying it (`req.log`), the
 * `x-request-id` response header, and emits one structured access-log line when it finishes.
 *
 * @param {{ logger: import('pino').Logger }} deps
 * @returns {import('express').RequestHandler}
 */
export function createRequestContextMiddleware({ logger }) {
  return (req, res, next) => {
    const supplied = req.get(REQUEST_ID_HEADER);
    req.id = supplied && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
    req.log = logger.child({ request_id: req.id });
    res.set(REQUEST_ID_HEADER, req.id);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      req.log.info({
        event: LOG_EVENT.REQUEST_COMPLETED,
        method: req.method,
        route: req.route?.path ?? '(unmatched)',
        status_code: res.statusCode,
        duration_ms: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      });
    });
    next();
  };
}
