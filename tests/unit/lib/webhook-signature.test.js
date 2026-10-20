import { describe, expect, it } from 'vitest';
import { computeSignature, isValidSignature } from '#src/lib/webhook-signature.js';

const secret = 'topsecret-value';
const body = Buffer.from('{"a":1}');

describe('signature', () => {
  it('matches a known HMAC-SHA256 vector (verifiable with any HMAC tool)', () => {
    // printf '%s' '{"a":1}' | openssl dgst -sha256 -hmac 'topsecret-value'
    expect(computeSignature(secret, body)).toBe(
      '7a5f5394ffcdfa858b23a03b6e841fa3c0e602a127ee8f0df394ba12f0161cf4',
    );
  });

  it('accepts upper and lower case hex', () => {
    const sig = computeSignature(secret, body);
    expect(isValidSignature(secret, body, sig)).toBe(true);
    expect(isValidSignature(secret, body, sig.toUpperCase())).toBe(true);
  });

  it.each([undefined, null, 42, '', 'abc', 'g'.repeat(64), ['x']])(
    'rejects malformed header %j',
    (header) => {
      expect(isValidSignature(secret, body, header)).toBe(false);
    },
  );

  it('rejects a tampered body, a different secret and a missing body', () => {
    const sig = computeSignature(secret, body);
    expect(isValidSignature(secret, Buffer.from('{"a":2}'), sig)).toBe(false);
    expect(isValidSignature('another-secret', body, sig)).toBe(false);
    expect(isValidSignature(secret, undefined, sig)).toBe(false);
  });
});
