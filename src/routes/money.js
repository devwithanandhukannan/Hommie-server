import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate, idParams, oid, ymd, ym, money, optText } from '../lib/validate.js';
import { Expense, Settlement, Membership, Bill } from '../models/index.js';
import { EXPENSE_CATEGORIES } from '../models/index.js';
import { expenseDto, settlementDto, billDto } from '../dto.js';
import { loadMembers, pick } from '../services/members.js';
import { createExpense, equalSplit, computeBalances, simplifyDebts } from '../services/expenses.js';
import { isAdmin } from '../middleware/auth.js';
import { todayIn, addMonths } from '../lib/dates.js';

export const expenses = Router();
export const wallet = Router();
export const reports = Router();

const monthRange = (month) => ({ $gte: `${month}-01`, $lte: `${month}-31` });
const prevMonth = (month) => addMonths(`${month}-01`, -1).slice(0, 7);

async function assertActive(familyId, ids) {
  const uniq = [...new Set(ids)];
  const n = await Membership.countDocuments({ _id: { $in: uniq }, familyId, status: 'active' });
  if (n !== uniq.length) throw badRequest('Some selected members are not in this family');
}

expenses.get('/', validate({ query: z.object({ month: ym.optional(), category: z.enum(EXPENSE_CATEGORIES).optional() }).strict() }), h(async (req, res) => {
  const month = req.valid.query.month || todayIn(req.ctx.family.timezone).slice(0, 7);
  const f = { familyId: req.ctx.familyId, date: monthRange(month) };
  if (req.valid.query.category) f.category = req.valid.query.category;
  const list = await Expense.find(f).sort({ date: -1, _id: -1 }).limit(500);
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(list.map((e) => expenseDto(e, map)));
}));

expenses.post('/', validate({
  body: z.object({
    amount: money, category: z.enum(EXPENSE_CATEGORIES).default('other'), date: ymd, paidById: oid.optional(), note: optText(200),
    equalAmong: z.array(oid).min(1).max(30).optional(),
    split: z.array(z.object({ memberId: oid, share: z.number().int().min(0).max(10_000_000_000) }).strict()).min(1).max(30).optional(),
  }).strict().refine((b) => !(b.equalAmong && b.split), { message: 'Use either equalAmong or split' }),
}), h(async (req, res) => {
  const b = req.valid.body;
  const paidById = b.paidById || req.ctx.me;
  if (paidById !== req.ctx.me && !isAdmin(req)) throw forbidden('Only an admin can record an expense paid by someone else');
  const { ids } = await loadMembers(req.ctx.familyId);
  const split = b.split || equalSplit(b.amount, b.equalAmong || ids);
  await assertActive(req.ctx.familyId, [paidById, ...split.map((s) => s.memberId)]);
  const e = await createExpense({ familyId: req.ctx.familyId, amount: b.amount, category: b.category, date: b.date, paidById, split, note: b.note, createdBy: req.ctx.me });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(expenseDto(e, map));
}));

expenses.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const e = await Expense.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!e) throw notFound();
  if (e.source === 'bill') throw badRequest('This expense comes from a paid bill. Paid bills cannot be removed here.');
  if (String(e.createdBy) !== req.ctx.me && !isAdmin(req)) throw forbidden('Only the creator or an admin can delete this expense');
  await e.deleteOne();
  res.status(204).end();
}));

// ---------- wallet & settlements ----------
async function balances(req) {
  const [ex, st, members] = await Promise.all([
    Expense.find({ familyId: req.ctx.familyId }).limit(20000), Settlement.find({ familyId: req.ctx.familyId }).limit(5000), loadMembers(req.ctx.familyId),
  ]);
  const net = computeBalances(ex, st);
  for (const id of members.ids) if (!net.has(id)) net.set(id, 0);
  return { net, map: members.map };
}

wallet.get('/', h(async (req, res) => {
  const { net, map } = await balances(req);
  const plan = simplifyDebts(new Map([...net].filter(([id]) => map.has(id))));
  const me = req.ctx.me;
  res.json({
    balances: [...net].filter(([id]) => map.has(id)).map(([id, v]) => ({ member: pick(map, id), net: v })),
    me: {
      net: net.get(me) || 0,
      youOwe: plan.filter((p) => p.from === me).map((p) => ({ member: pick(map, p.to), amount: p.amount })),
      owedToYou: plan.filter((p) => p.to === me).map((p) => ({ member: pick(map, p.from), amount: p.amount })),
    },
  });
}));

wallet.get('/settlements', h(async (req, res) => {
  const { map } = await loadMembers(req.ctx.familyId);
  const list = await Settlement.find({ familyId: req.ctx.familyId }).sort({ _id: -1 }).limit(50);
  res.json(list.map((s) => settlementDto(s, map)));
}));

wallet.delete('/settlements/:id', validate({ params: idParams }), h(async (req, res) => {
  const s = await Settlement.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!s) throw notFound();
  if (String(s.fromId) !== req.ctx.me && !isAdmin(req)) throw forbidden('Only the person who recorded it, or an admin, can undo this');
  await s.deleteOne();
  res.status(204).end();
}));

wallet.post('/settlements', validate({ body: z.object({ toId: oid, fromId: oid.optional(), amount: money, date: ymd, note: optText(200) }).strict() }), h(async (req, res) => {
  const b = req.valid.body;
  const fromId = b.fromId || req.ctx.me;
  if (fromId !== req.ctx.me && !isAdmin(req)) throw forbidden('Only an admin can record a payment between other members');
  if (fromId === b.toId) throw badRequest('Choose someone else');
  await assertActive(req.ctx.familyId, [fromId, b.toId]);
  const s = await Settlement.create({ familyId: req.ctx.familyId, fromId, toId: b.toId, amount: b.amount, date: b.date, note: b.note });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(settlementDto(s, map));
}));

// ---------- reports ----------
reports.get('/monthly', validate({ query: z.object({ month: ym.optional() }).strict() }), h(async (req, res) => {
  const month = req.valid.query.month || todayIn(req.ctx.family.timezone).slice(0, 7);
  const [cur, prev, members] = await Promise.all([
    Expense.find({ familyId: req.ctx.familyId, date: monthRange(month) }).limit(5000),
    Expense.find({ familyId: req.ctx.familyId, date: monthRange(prevMonth(month)) }).limit(5000),
    loadMembers(req.ctx.familyId),
  ]);
  const total = cur.reduce((a, e) => a + e.amount, 0);
  const lastTotal = prev.reduce((a, e) => a + e.amount, 0);
  const byCat = new Map();
  const byMember = new Map();
  for (const e of cur) {
    byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount);
    const p = byMember.get(String(e.paidById)) || { paid: 0, share: 0 };
    p.paid += e.amount;
    byMember.set(String(e.paidById), p);
    for (const s of e.split) {
      const q = byMember.get(String(s.memberId)) || { paid: 0, share: 0 };
      q.share += s.share;
      byMember.set(String(s.memberId), q);
    }
  }
  res.json({
    month, total,
    byCategory: [...byCat].map(([category, t]) => ({ category, total: t })).sort((a, b) => b.total - a.total),
    byMember: [...byMember].map(([id, v]) => ({ member: pick(members.map, id), ...v })),
    vsLastMonth: { lastTotal, changePercent: lastTotal ? Math.round(((total - lastTotal) / lastTotal) * 100) : null },
  });
}));

// Indian financial year (April to March): tax paid so far and the tax bills coming up.
reports.get('/tax', validate({ query: z.object({ fy: z.coerce.number().int().min(2000).max(2100).optional() }).strict() }), h(async (req, res) => {
  const today = todayIn(req.ctx.family.timezone);
  const [y, m] = today.split('-').map(Number);
  const fy = req.valid.query.fy ?? (m >= 4 ? y : y - 1);
  const from = `${fy}-04-01`, to = `${fy + 1}-03-31`;
  const [paid, taxBills, members] = await Promise.all([
    Expense.find({ familyId: req.ctx.familyId, category: 'tax', date: { $gte: from, $lte: to } }).sort({ date: -1 }).limit(200),
    Bill.find({ familyId: req.ctx.familyId, category: 'tax', active: true }),
    loadMembers(req.ctx.familyId),
  ]);
  res.json({
    financialYear: `${fy}-${String(fy + 1).slice(2)}`, from, to,
    totalPaid: paid.reduce((a, e) => a + e.amount, 0),
    payments: paid.map((e) => expenseDto(e, members.map)),
    upcoming: taxBills.map((b) => billDto(b, members.map, today)),
  });
}));
