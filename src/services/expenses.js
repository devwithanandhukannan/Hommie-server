import { Expense } from '../models/index.js';
import { badRequest } from '../lib/errors.js';

/** Splits `amount` (paise) equally; the remainder goes to the first members so shares always sum exactly. */
export function equalSplit(amount, memberIds) {
  const n = memberIds.length;
  const base = Math.floor(amount / n);
  let rem = amount - base * n;
  return memberIds.map((memberId) => ({ memberId, share: base + (rem-- > 0 ? 1 : 0) }));
}

export function checkSplit(amount, split) {
  const sum = split.reduce((a, s) => a + s.share, 0);
  if (sum !== amount) throw badRequest('Shares must add up to the amount');
  if (new Set(split.map((s) => String(s.memberId))).size !== split.length) throw badRequest('A member appears twice in the split');
}

export async function createExpense({ familyId, amount, category, date, paidById, split, note, source = 'manual', sourceId, createdBy }) {
  checkSplit(amount, split);
  return Expense.create({ familyId, amount, category, date, paidById, split, note, source, sourceId, createdBy });
}

/** Net balance per member: (paid) - (own share) + settlements sent - settlements received. Positive = is owed money. */
export function computeBalances(expenses, settlements) {
  const net = new Map();
  const add = (id, v) => net.set(String(id), (net.get(String(id)) || 0) + v);
  for (const e of expenses) {
    add(e.paidById, e.amount);
    for (const s of e.split) add(s.memberId, -s.share);
  }
  for (const s of settlements) { add(s.fromId, s.amount); add(s.toId, -s.amount); }
  return net;
}

/** Greedy debt simplification: who should pay whom. */
export function simplifyDebts(net) {
  const debtors = [], creditors = [];
  for (const [id, v] of net) { if (v < 0) debtors.push([id, -v]); else if (v > 0) creditors.push([id, v]); }
  debtors.sort((a, b) => b[1] - a[1]); creditors.sort((a, b) => b[1] - a[1]);
  const out = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i][1], creditors[j][1]);
    out.push({ from: debtors[i][0], to: creditors[j][0], amount: pay });
    debtors[i][1] -= pay; creditors[j][1] -= pay;
    if (debtors[i][1] === 0) i++;
    if (creditors[j][1] === 0) j++;
  }
  return out;
}
