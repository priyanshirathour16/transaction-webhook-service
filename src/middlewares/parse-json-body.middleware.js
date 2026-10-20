import express from 'express';

// Webhooks are tiny: reject anything bigger before parsing it.
const BODY_LIMIT = '16kb';

/**
 * Strict JSON body parser (objects and arrays only). Keeps the exact received bytes on
 * `req.rawBody`, because webhook signatures are computed over them, not over re-serialised JSON.
 */
export const parseJsonBody = express.json({
  limit: BODY_LIMIT,
  strict: true,
  verify: (req, _res, buffer) => {
    req.rawBody = buffer;
  },
});
