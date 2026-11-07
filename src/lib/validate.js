import { z } from 'zod';

export const oid = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Invalid id');
const isRealDate = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isRealDate, 'Invalid date');
export const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
// Money is always an integer number of paise (1 rupee = 100 paise).
export const money = z.number().int().min(1).max(10_000_000_000);
export const text = (max) => z.string().trim().min(1).max(max);
export const optText = (max) => z.string().trim().max(max).optional();
export const idParams = z.object({ id: oid }).strict();

/** Validate params/query/body with zod; results land in req.valid.* (never read raw input afterwards). */
export function validate(schemas) {
  return (req, _res, next) => {
    try {
      req.valid = {};
      for (const part of ['params', 'query', 'body']) {
        if (schemas[part]) req.valid[part] = schemas[part].parse(req[part] ?? {});
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
