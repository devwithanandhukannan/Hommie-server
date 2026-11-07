import crypto from 'node:crypto';
import { config } from '../config.js';

const master = Buffer.from(config.masterKeyHex, 'hex');

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const safeEqual = (a, b) => {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

/** Envelope encryption: random per-file key (AES-256-GCM) wrapped with the master key. */
export function encryptFile(buf) {
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  const tag = c.getAuthTag();
  const wrapIv = crypto.randomBytes(12);
  const w = crypto.createCipheriv('aes-256-gcm', master, wrapIv);
  const wrappedKey = Buffer.concat([w.update(dataKey), w.final()]);
  const wrapTag = w.getAuthTag();
  return {
    data,
    meta: {
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      wrapIv: wrapIv.toString('hex'),
      wrapTag: wrapTag.toString('hex'),
      wrappedKey: wrappedKey.toString('hex'),
    },
  };
}

export function decryptFile(data, m) {
  const w = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(m.wrapIv, 'hex'));
  w.setAuthTag(Buffer.from(m.wrapTag, 'hex'));
  const dataKey = Buffer.concat([w.update(Buffer.from(m.wrappedKey, 'hex')), w.final()]);
  const d = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(m.iv, 'hex'));
  d.setAuthTag(Buffer.from(m.tag, 'hex'));
  return Buffer.concat([d.update(data), d.final()]);
}
