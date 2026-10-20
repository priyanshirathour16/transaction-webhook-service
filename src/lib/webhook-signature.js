import { createHmac, timingSafeEqual } from 'node:crypto';

/** Same scheme as RazorPay: lowercase hex HMAC-SHA256 of the exact raw request body. */
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * @param {string} secret
 * @param {Buffer} rawBody
 * @returns {string}
 */
export function computeSignature(secret, rawBody) {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Constant-time check, so response timing cannot be used to guess a valid signature.
 * @param {string} secret
 * @param {Buffer | undefined} rawBody
 * @param {unknown} header
 */
export function isValidSignature(secret, rawBody, header) {
  if (!rawBody || typeof header !== 'string' || !HEX_SHA256.test(header)) return false;
  const expected = Buffer.from(computeSignature(secret, rawBody), 'hex');
  const received = Buffer.from(header, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
