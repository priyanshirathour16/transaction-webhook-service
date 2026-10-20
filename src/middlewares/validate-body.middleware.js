import Ajv from 'ajv';
import { ValidationError } from '#src/errors/http-errors.js';

// One shared instance: schemas are compiled once per container, not per request.
const ajv = new Ajv({
  allErrors: true, // report every problem at once
  coerceTypes: false, // "1500" is not a number, 123 is not an id
  removeAdditional: false,
  useDefaults: false,
  strict: true,
  // Lets `multipleOf: 0.0001` work on binary floats (e.g. 150.5, 0.1).
  multipleOfPrecision: 8,
});

/** @param {import('ajv').ErrorObject} issue */
function toDetail(issue) {
  return {
    field:
      issue.instancePath.replace(/^\//, '').replaceAll('/', '.') ||
      issue.params?.missingProperty ||
      '(body)',
    message: issue.message,
  };
}

/**
 * Express middleware that validates `req.body` against a JSON schema.
 * @param {object} schema
 * @returns {import('express').RequestHandler}
 */
export function validateBody(schema) {
  const validate = ajv.compile(schema);
  return (req, _res, next) => {
    if (!validate(req.body)) return next(new ValidationError(validate.errors.map(toDetail)));
    next();
  };
}
