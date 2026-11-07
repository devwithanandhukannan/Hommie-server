import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';
import { config } from '../config.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      issues: err.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  if (err?.code === 11000) return res.status(409).json({ error: 'This already exists' });
  if (err?.name === 'CastError' || err?.name === 'ValidationError') return res.status(400).json({ error: 'Invalid input' });
  if (err?.name === 'MulterError') {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : 'Invalid upload' });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (!config.isTest) console.error(`[error] ${req.method} ${req.path}:`, err?.message);
  res.status(500).json({ error: 'Something went wrong' });
}
