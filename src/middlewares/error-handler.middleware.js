import { ERROR_CODE } from '#src/constants/error-codes.js';
import { HTTP_STATUS } from '#src/constants/http-status.js';
import { LOG_EVENT } from '#src/constants/log-events.js';
import {
  createErrorBody,
  UnauthorizedError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '#src/errors/http-errors.js';

// body-parser reports problems through `err.type`; map the ones a webhook sender can cause.
const BODY_PARSER_ERRORS = {
  'entity.parse.failed': {
    status: HTTP_STATUS.BAD_REQUEST,
    code: ERROR_CODE.BAD_REQUEST,
    message: 'Request body is not valid JSON',
  },
  'entity.too.large': {
    status: HTTP_STATUS.PAYLOAD_TOO_LARGE,
    code: ERROR_CODE.PAYLOAD_TOO_LARGE,
    message: 'Request body is too large',
  },
  'encoding.unsupported': {
    status: HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
    code: ERROR_CODE.UNSUPPORTED_MEDIA_TYPE,
    message: 'Unsupported content encoding',
  },
  'charset.unsupported': {
    status: HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE,
    code: ERROR_CODE.UNSUPPORTED_MEDIA_TYPE,
    message: 'Unsupported charset',
  },
};

// Error code for framework-raised client errors that have no entry above.
const CLIENT_ERROR_CODES = {
  [HTTP_STATUS.PAYLOAD_TOO_LARGE]: ERROR_CODE.PAYLOAD_TOO_LARGE,
  [HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE]: ERROR_CODE.UNSUPPORTED_MEDIA_TYPE,
};

/**
 * Central error handler (four arguments is how Express recognises one). Never leaks internals:
 * known client errors get a safe message; anything else becomes a generic 500 while the real
 * error goes to the log, correlated by request_id.
 *
 * @type {import('express').ErrorRequestHandler}
 */
export function errorHandler(err, req, res, _next) {
  if (err instanceof ValidationError) {
    return res
      .status(HTTP_STATUS.BAD_REQUEST)
      .json(createErrorBody(ERROR_CODE.VALIDATION_ERROR, err.message, err.details));
  }
  if (err instanceof UnauthorizedError) {
    return res
      .status(HTTP_STATUS.UNAUTHORIZED)
      .json(createErrorBody(ERROR_CODE.INVALID_SIGNATURE, err.message));
  }
  if (err instanceof UnsupportedMediaTypeError) {
    return res
      .status(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE)
      .json(createErrorBody(ERROR_CODE.UNSUPPORTED_MEDIA_TYPE, err.message));
  }

  const parserError = BODY_PARSER_ERRORS[err?.type];
  if (parserError) {
    req.log.warn({
      event: LOG_EVENT.REQUEST_REJECTED,
      status_code: parserError.status,
      code: err.type,
    });
    return res
      .status(parserError.status)
      .json(createErrorBody(parserError.code, parserError.message));
  }

  // Any other 4xx raised by the framework or body parser (e.g. "Decompression failed",
  // "request aborted") is the client's mistake, not ours. http-errors marks these `expose: true`,
  // meaning the message is safe to return. Without this they would surface as a misleading 500.
  const status = err?.status ?? err?.statusCode;
  if (err?.expose === true && status >= 400 && status < 500) {
    req.log.warn({ event: LOG_EVENT.REQUEST_REJECTED, status_code: status, code: err.type });
    return res
      .status(status)
      .json(createErrorBody(CLIENT_ERROR_CODES[status] ?? ERROR_CODE.BAD_REQUEST, err.message));
  }

  req.log.error({ event: LOG_EVENT.REQUEST_FAILED, err }, 'unhandled error');
  return res
    .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
    .json(createErrorBody(ERROR_CODE.INTERNAL_ERROR, 'Internal server error'));
}
