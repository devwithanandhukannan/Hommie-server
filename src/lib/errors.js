export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const badRequest = (m = 'Bad request') => new HttpError(400, m);
export const unauthorized = (m = 'Authentication required') => new HttpError(401, m);
export const forbidden = (m = 'You do not have permission to do this') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m = 'Conflict') => new HttpError(409, m);

// Wrap async route handlers so rejections reach the error middleware.
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
