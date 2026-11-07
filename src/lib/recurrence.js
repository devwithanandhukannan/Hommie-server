import { addDays, addMonths, diffDays } from './dates.js';

/** The nth due date of a recurrence rule (n starts at 0 = anchorDate). */
export function nthDue(rule, n) {
  const step = rule.everyN * n;
  switch (rule.unit) {
    case 'day': return addDays(rule.anchorDate, step);
    case 'week': return addDays(rule.anchorDate, step * 7);
    case 'month': return addMonths(rule.anchorDate, step);
    case 'year': return addMonths(rule.anchorDate, step * 12);
    default: return rule.anchorDate;
  }
}

/** Due dates >= fromDate and <= toDate (inclusive). One-off bills have rule.unit === 'once'. */
export function dueDatesBetween(rule, fromDate, toDate, max = 60) {
  if (!rule) return [];
  const out = [];
  if (rule.unit === 'once') {
    if (rule.anchorDate >= fromDate && rule.anchorDate <= toDate) out.push(rule.anchorDate);
    return out;
  }
  // Jump close to fromDate to avoid iterating from an old anchor.
  const approxPerStep = { day: 1, week: 7, month: 30, year: 365 }[rule.unit] * rule.everyN;
  let n = Math.max(0, Math.floor(diffDays(fromDate, rule.anchorDate) / approxPerStep) - 1);
  for (let i = 0; i < 400 && out.length < max; i++, n++) {
    const d = nthDue(rule, n);
    if (rule.endDate && d > rule.endDate) break;
    if (d > toDate) break;
    if (d >= fromDate) out.push(d);
  }
  return out;
}

export function nextDue(rule, today) {
  if (!rule) return null;
  if (rule.unit === 'once') return rule.anchorDate >= today ? rule.anchorDate : null;
  const far = addDays(today, 366 * 2);
  return dueDatesBetween(rule, today, far, 1)[0] || null;
}
