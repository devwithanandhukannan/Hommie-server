import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const base = { issuer: 'family-hub', audience: 'family-hub-web' };

export const signAccess = (user, sessionId) =>
  jwt.sign({ sid: String(sessionId), tv: user.tokenVersion }, config.jwtSecret, {
    ...base,
    subject: String(user._id),
    expiresIn: config.accessTtl,
    algorithm: 'HS256',
  });

export const verifyAccess = (token) =>
  jwt.verify(token, config.jwtSecret, { ...base, algorithms: ['HS256'] });
