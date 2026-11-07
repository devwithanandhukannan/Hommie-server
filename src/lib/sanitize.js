import { HttpError } from './errors.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function scan(value, depth = 0) {
  if (depth > 8) throw new HttpError(400, 'Payload is nested too deeply');
  if (Array.isArray(value)) {
    if (value.length > 500) throw new HttpError(400, 'Array is too long');
    for (const v of value) scan(v, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key.startsWith('$') || key.includes('.') || FORBIDDEN_KEYS.has(key)) {
        throw new HttpError(400, 'Invalid field name');
      }
      scan(value[key], depth + 1);
    }
  }
}

/** Rejects any request carrying Mongo operators ($...) or dotted/prototype keys. */
export function sanitize(req, _res, next) {
  try {
    scan(req.body);
    scan(req.query);
    scan(req.params);
    next();
  } catch (e) {
    next(e);
  }
}
export const scanObject = scan;
