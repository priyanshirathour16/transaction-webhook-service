import { UnsupportedMediaTypeError } from '#src/errors/http-errors.js';

/**
 * Rejects requests whose Content-Type is not JSON (→ 415) before any body is read.
 * @type {import('express').RequestHandler}
 */
export function requireJson(req, _res, next) {
  next(req.is('application/json') ? undefined : new UnsupportedMediaTypeError());
}
