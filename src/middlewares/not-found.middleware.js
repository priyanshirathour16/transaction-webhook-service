import { ERROR_CODE } from '#src/constants/error-codes.js';
import { HTTP_STATUS } from '#src/constants/http-status.js';
import { createErrorBody } from '#src/errors/http-errors.js';

/**
 * Final route: anything not matched above gets a JSON 404 instead of Express's HTML page.
 * @type {import('express').RequestHandler}
 */
export function notFoundHandler(req, res) {
  res
    .status(HTTP_STATUS.NOT_FOUND)
    .json(
      createErrorBody(
        ERROR_CODE.ROUTE_NOT_FOUND,
        `Route ${req.method} ${req.originalUrl} not found`,
      ),
    );
}
