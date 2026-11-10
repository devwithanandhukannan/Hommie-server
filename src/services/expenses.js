import mongoose from 'mongoose';
import { Expense, Settlement } from '../models/index.js';
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

const toOid = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)));

/** Computes per-member net balances directly in MongoDB without loading full history into Node. */
export async function computeFamilyBalances(familyId) {
  const fid = toOid(familyId);
  const [paidRows, shareRows, settleRows] = await Promise.all([
    Expense.aggregate([{ $match: { familyId: fid } }, { $group: { _id: '$paidById', total: { $sum: '$amount' } } }]),
    Expense.aggregate([{ $match: { familyId: fid } }, { $unwind: '$split' }, { $group: { _id: '$split.memberId', total: { $sum: '$split.share' } } }]),
    Settlement.aggregate([
      { $match: { familyId: fid } },
      {
        $facet: {
          sent: [{ $group: { _id: '$fromId', total: { $sum: '$amount' } } }],
          received: [{ $group: { _id: '$toId', total: { $sum: '$amount' } } }],
        },
      },
    ]),
  ]);

  const net = new Map();
  const add = (id, delta) => {
    if (!id || !delta) return;
    net.set(String(id), (net.get(String(id)) || 0) + delta);
  };
  for (const r of paidRows) add(r._id, r.total);
  for (const r of shareRows) add(r._id, -r.total);
  const facet = settleRows?.[0] || {};
  for (const r of facet.sent || []) add(r._id, r.total);
  for (const r of facet.received || []) add(r._id, -r.total);
  return net;
}

/** Aggregates a month's expenses by category and member inside MongoDB. */
export async function monthlyExpenseSummary(familyId, month, prevMonthStr) {
  const fid = toOid(familyId);
  const range = (m) => ({ $gte: `${m}-01`, $lte: `${m}-31` });
  const [curFacet, prevTotalRow] = await Promise.all([
    Expense.aggregate([
      { $match: { familyId: fid, date: range(month) } },
      {
        $facet: {
          total: [{ $group: { _id: null, total: { $sum: '$amount' } } }],
          byCategory: [{ $group: { _id: '$category', total: { $sum: '$amount' } } }, { $sort: { total: -1 } }],
          byPaid: [{ $group: { _id: '$paidById', paid: { $sum: '$amount' } } }],
          byShare: [{ $unwind: '$split' }, { $group: { _id: '$split.memberId', share: { $sum: '$split.share' } } }],
        },
      },
    ]),
    Expense.aggregate([
      { $match: { familyId: fid, date: range(prevMonthStr) } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);

  const f = curFacet?.[0] || {};
  const total = f.total?.[0]?.total || 0;
  const lastTotal = prevTotalRow?.[0]?.total || 0;
  const byCategory = (f.byCategory || []).map((c) => ({ category: c._id || 'other', total: c.total }));
  const byMemberMap = new Map();
  for (const p of f.byPaid || []) {
    if (!p._id) continue;
    byMemberMap.set(String(p._id), { paid: p.paid || 0, share: 0 });
  }
  for (const s of f.byShare || []) {
    if (!s._id) continue;
    const entry = byMemberMap.get(String(s._id)) || { paid: 0, share: 0 };
    entry.share = s.share || 0;
    byMemberMap.set(String(s._id), entry);
  }
  return {
    total,
    lastTotal,
    byCategory,
    byMemberMap,
  };
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
