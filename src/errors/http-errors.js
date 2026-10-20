/** Errors the HTTP layer maps to specific responses (see error-handler.middleware.js). */

/** Request failed schema validation → 400 with per-field details. */
export class ValidationError extends Error {
  /** @param {{ field: string, message: string }[]} details */
  constructor(details) {
    super('Request validation failed');
    this.name = 'ValidationError';
    this.details = details;
  }
}

/** Missing or invalid webhook signature → 401. */
export class UnauthorizedError extends Error {
  constructor(message = 'Invalid or missing signature') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/** Unsupported Content-Type → 415. */
export class UnsupportedMediaTypeError extends Error {
  constructor() {
    super('Content-Type must be application/json');
    this.name = 'UnsupportedMediaTypeError';
  }
}

/**
 * Uniform error body: `{ "error": { "code", "message", "details"? } }`.
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 */
export function createErrorBody(code, message, details) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}
