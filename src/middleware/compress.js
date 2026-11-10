import zlib from 'node:zlib';

const MIN_GZIP_BYTES = 1024;

/**
 * Lightweight zero-dependency gzip compression for JSON API responses >= 1 KB.
 * Skips SSE streams, empty replies, and clients that do not advertise gzip support.
 */
export function compressJson(req, res, next) {
  if (!String(req.headers['accept-encoding'] || '').includes('gzip')) return next();
  const origJson = res.json.bind(res);

  res.json = (data) => {
    if (res.headersSent || res.getHeader('Content-Encoding') || data === undefined) {
      return origJson(data);
    }
    const serialized = JSON.stringify(data);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') < MIN_GZIP_BYTES) {
      return origJson(data);
    }
    const buf = Buffer.from(serialized, 'utf8');
    zlib.gzip(buf, (err, gz) => {
      if (err || res.headersSent) return origJson(data);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', String(gz.length));
      res.end(gz);
    });
    return res;
  };

  next();
}

