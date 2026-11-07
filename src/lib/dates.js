// Dates are handled as 'YYYY-MM-DD' strings in the family's timezone.
export function todayIn(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function timeIn(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
}
const toUTC = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = toUTC(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
export const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / 86400000);
export function addMonths(s, n) {
  const d = toUTC(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fmt(d);
}
export const weekday = (s) => toUTC(s).getUTCDay();
export const monthOf = (s) => s.slice(0, 7);
