import { LOG_EVENT } from '#src/constants/log-events.js';
import { UnauthorizedError } from '#src/errors/http-errors.js';
import { isValidSignature } from '#src/lib/webhook-signature.js';

// Header names payment processors use for the body signature (RazorPay uses the second).
const SIGNATURE_HEADERS = ['x-webhook-signature', 'x-razorpay-signature'];

/**
 * Optional HMAC check. With no secret configured it is a no-op; with one, a request without a
 * valid signature of its raw body is rejected with 401 before validation or processing runs.
 *
 * @param {{ secret?: string }} options
 * @returns {import('express').RequestHandler}
 */
export function createVerifyWebhookSignatureMiddleware({ secret }) {
  return (req, _res, next) => {
    if (!secret) return next();

    const signature = SIGNATURE_HEADERS.map((name) => req.get(name)).find(Boolean);
    if (!isValidSignature(secret, req.rawBody, signature)) {
      req.log.warn({ event: LOG_EVENT.WEBHOOK_SIGNATURE_REJECTED });
      return next(new UnauthorizedError());
    }
    next();
  };
}
