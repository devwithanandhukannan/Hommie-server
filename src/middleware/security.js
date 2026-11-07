import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { forbidden } from '../lib/errors.js';
import { safeEqual, randomToken } from '../lib/crypto.js';

export const CSRF_COOKIE = 'fh_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export const cookieBase = { secure: config.isProd, sameSite: 'lax' };

/** Issue (or re-use) a CSRF token: double-submit cookie pattern. */
export function issueCsrf(req, res) {
  let token = req.cookies?.[CSRF_COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) token = randomToken(32);
  res.cookie(CSRF_COOKIE, token, { ...cookieBase, httpOnly: false, path: '/', maxAge: 30 * 864e5 });
  return token;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/** State-changing requests must carry a header equal to the CSRF cookie, from an allowed Origin. */
export function csrfProtection(req, _res, next) {
  if (SAFE.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !config.webOrigins.includes(origin)) return next(forbidden('Origin not allowed'));
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);
  if (!cookie || !header || !safeEqual(cookie, header)) return next(forbidden('Invalid CSRF token'));
  next();
}

const limiterBase = { standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please slow down' } };
const skipInTest = () => config.isTest && process.env.RATE_LIMIT_TESTS !== '1';

export const globalLimiter = rateLimit({ ...limiterBase, windowMs: 60_000, limit: 300, skip: skipInTest });
export const authLimiter = rateLimit({ ...limiterBase, windowMs: 15 * 60_000, limit: 20, skip: skipInTest });
export const inviteLimiter = rateLimit({ ...limiterBase, windowMs: 15 * 60_000, limit: 15, skip: skipInTest });
export const chatLimiter = rateLimit({
  ...limiterBase, windowMs: 60_000, limit: 40, skip: skipInTest,
  keyGenerator: (req) => req.ctx?.user?.id || req.ip,
});
export const uploadLimiter = rateLimit({
  ...limiterBase, windowMs: 60 * 60_000, limit: 60, skip: skipInTest,
  keyGenerator: (req) => req.ctx?.user?.id || req.ip,
});
export const aiLimiter = rateLimit({
  ...limiterBase, windowMs: 60_000, limit: 15, skip: skipInTest,
  keyGenerator: (req) => req.ctx?.user?.id || req.ip,
});
