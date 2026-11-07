import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { validate, idParams, oid, ymd, text, optText, money } from '../lib/validate.js';
import { Bill, BillInstance, Task, Membership, Loan, LoanPayment, Document } from '../models/index.js';
import { BILL_CATEGORIES } from '../models/index.js';
import { billDto, instanceDto, loanDto, loanPaymentDto, canViewDoc } from '../dto.js';
import { loadMembers } from '../services/members.js';
import { ensureInstances, setAmount, payInstance } from '../services/bills.js';
import { recordLoanPayment, suggestEmi } from '../services/loans.js';
import { audit } from '../services/audit.js';
import { isAdmin } from '../middleware/auth.js';
import { todayIn, addDays, addMonths } from '../lib/dates.js';

export const bills = Router();
export const instances = Router();
export const loans = Router();

const rule = z.object({
  unit: z.enum(['once', 'day', 'week', 'month', 'year']), everyN: z.number().int().min(1).max(60).default(1),
  anchorDate: ymd, endDate: ymd.optional(),
}).strict();
const billShape = z.object({
  title: text(80), category: z.enum(BILL_CATEGORIES).default('other'), amountMode: z.enum(['fixed', 'ask']).default('ask'),
  fixedAmount: money.optional(), rule, payerId: oid.optional(), reminderDaysBefore: z.number().int().min(0).max(30).default(3),
  splitAmong: z.array(oid).max(30).default([]), note: optText(300),
}).strict();
const fixedNeedsAmount = (b) => b.amountMode !== 'fixed' || b.fixedAmount;
const billBody = billShape.refine(fixedNeedsAmount, { message: 'Fixed bills need an amount', path: ['fixedAmount'] });

async function checkMembers(familyId, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return;
  const n = await Membership.countDocuments({ _id: { $in: uniq }, familyId, status: 'active' });
  if (n !== uniq.length) throw badRequest('Some of the selected members are not in this family');
}
const canEditBill = (req, b) => String(b.createdBy) === req.ctx.me || isAdmin(req);

async function removeOpenInstances(billId) {
  const open = await BillInstance.find({ billId, status: { $ne: 'paid' } });
  await Task.deleteMany({ _id: { $in: open.map((i) => i.taskId).filter(Boolean) } });
  await BillInstance.deleteMany({ _id: { $in: open.map((i) => i._id) } });
}

// ---------- bills ----------
bills.get('/', h(async (req, res) => {
  const { map } = await loadMembers(req.ctx.familyId);
  const today = todayIn(req.ctx.family.timezone);
  const list = await Bill.find({ familyId: req.ctx.familyId, active: true }).sort({ title: 1 });
  res.json(list.map((b) => billDto(b, map, today)));
}));

bills.post('/', validate({ body: billBody }), h(async (req, res) => {
  const b = req.valid.body;
  const payerId = b.payerId || req.ctx.me;
  await checkMembers(req.ctx.familyId, [payerId, ...b.splitAmong]);
  const bill = await Bill.create({ ...b, payerId, familyId: req.ctx.familyId, createdBy: req.ctx.me });
  await ensureInstances(req.ctx.family);
  await audit(req, 'bill.create', 'bill', bill._id, { title: bill.title });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(billDto(bill, map, todayIn(req.ctx.family.timezone)));
}));

bills.patch('/:id', validate({ params: idParams, body: billShape.partial() }), h(async (req, res) => {
  const bill = await Bill.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId, active: true });
  if (!bill) throw notFound();
  if (!canEditBill(req, bill)) throw forbidden('Only the creator or an admin can edit this bill');
  if (bill.loanId && (req.valid.body.rule || req.valid.body.fixedAmount)) throw badRequest('Edit EMI details from the loan');
  const merged = { ...bill.toObject(), ...req.valid.body };
  if (!fixedNeedsAmount(merged)) throw badRequest('Fixed bills need an amount');
  await checkMembers(req.ctx.familyId, [req.valid.body.payerId, ...(req.valid.body.splitAmong || [])]);
  Object.assign(bill, req.valid.body);
  await bill.save();
  await audit(req, 'bill.update', 'bill', bill._id);

  // Sync open instances and their tasks if title or fixedAmount or payerId changed
  if (req.valid.body.title || req.valid.body.fixedAmount !== undefined || req.valid.body.payerId !== undefined) {
    const openInsts = await BillInstance.find({ billId: bill._id, status: { $ne: 'paid' } });
    for (const inst of openInsts) {
      if (bill.amountMode === 'fixed' && bill.fixedAmount) {
        inst.amount = bill.fixedAmount;
        inst.status = 'pending';
        await inst.save();
      }
      if (inst.taskId) {
        const updateTask = {};
        if (req.valid.body.title || req.valid.body.fixedAmount !== undefined) {
          updateTask.title = inst.status === 'awaiting_amount' ? `Enter ${bill.title} amount` : `Pay ${bill.title} · ₹${((inst.amount || 0) / 100).toLocaleString('en-IN')}`;
        }
        if (req.valid.body.payerId !== undefined) {
          updateTask.assigneeId = req.valid.body.payerId || null;
        }
        if (Object.keys(updateTask).length) {
          await Task.updateOne({ _id: inst.taskId }, { $set: updateTask });
        }
      }
    }
  }

  const { map } = await loadMembers(req.ctx.familyId);
  res.json(billDto(bill, map, todayIn(req.ctx.family.timezone)));
}));

bills.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const bill = await Bill.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId, active: true });
  if (!bill) throw notFound();
  if (!canEditBill(req, bill)) throw forbidden('Only the creator or an admin can delete this bill');
  if (bill.loanId) throw badRequest('Delete the loan to remove its EMI bill');
  bill.active = false;
  await bill.save();
  await removeOpenInstances(bill._id);
  await audit(req, 'bill.delete', 'bill', bill._id, { title: bill.title });
  res.status(204).end();
}));

bills.get('/:id/history', validate({ params: idParams }), h(async (req, res) => {
  const bill = await Bill.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!bill) throw notFound();
  const { map } = await loadMembers(req.ctx.familyId);
  const list = await BillInstance.find({ billId: bill._id }).sort({ dueDate: -1 }).limit(36);
  const today = todayIn(req.ctx.family.timezone);
  res.json(list.map((i) => instanceDto(i, bill, map, today)));
}));

// ---------- bill instances (one per due date) ----------
instances.get('/', validate({ query: z.object({ status: z.enum(['open', 'paid', 'all']).default('open') }).strict() }), h(async (req, res) => {
  const today = todayIn(req.ctx.family.timezone);
  await ensureInstances(req.ctx.family, today);
  const { status } = req.valid.query;
  const f = { familyId: req.ctx.familyId };
  if (status === 'open') f.status = { $ne: 'paid' };
  if (status === 'paid') f.status = 'paid';
  const list = await BillInstance.find(f).sort(status === 'paid' ? { paidAt: -1 } : { dueDate: 1 }).limit(status === 'open' ? 200 : 60);
  const billsById = new Map((await Bill.find({ _id: { $in: list.map((i) => i.billId) } })).map((b) => [String(b._id), b]));
  const tasksById = new Map((await Task.find({ _id: { $in: list.map((i) => i.taskId).filter(Boolean) } })).map((t) => [String(t._id), t]));
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(list.map((i) => instanceDto(i, billsById.get(String(i.billId)), map, today, tasksById.get(String(i.taskId)))));
}));

async function loadInstance(req) {
  const inst = await BillInstance.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!inst) throw notFound('Bill not found');
  const bill = await Bill.findById(inst.billId);
  const task = inst.taskId ? await Task.findById(inst.taskId) : null;
  const allowed = isAdmin(req) || String(task?.assigneeId) === req.ctx.me || String(bill?.payerId) === req.ctx.me || String(bill?.createdBy) === req.ctx.me;
  if (!allowed) throw forbidden('This bill is assigned to someone else');
  return { inst, bill, task };
}
const reply = async (req, inst, bill) => {
  const { map } = await loadMembers(req.ctx.familyId);
  const task = inst.taskId ? await Task.findById(inst.taskId) : null;
  return instanceDto(inst, bill, map, todayIn(req.ctx.family.timezone), task);
};

instances.post('/:id/amount', validate({ params: idParams, body: z.object({ amount: money }).strict() }), h(async (req, res) => {
  const { inst, bill } = await loadInstance(req);
  await setAmount(inst, bill, req.valid.body.amount);
  res.json(await reply(req, inst, bill));
}));

instances.post('/:id/pay', validate({
  params: idParams,
  body: z.object({ paidOn: ymd.optional(), paidById: oid.optional(), receiptDocumentId: oid.optional() }).strict().optional().default({}),
}), h(async (req, res) => {
  const { inst, bill } = await loadInstance(req);
  const b = req.valid.body;
  let paidById = req.ctx.me;
  if (b.paidById && b.paidById !== req.ctx.me) {
    if (!isAdmin(req)) throw forbidden('Only an admin can record a payment made by someone else');
    await checkMembers(req.ctx.familyId, [b.paidById]);
    paidById = b.paidById;
  }
  if (b.receiptDocumentId) {
    const d = await Document.findOne({ _id: b.receiptDocumentId, familyId: req.ctx.familyId });
    if (!d || !canViewDoc(d, req.ctx.me)) throw badRequest('Receipt document not found');
  }
  const payer = await Membership.findById(paidById);
  const done = await payInstance({
    instance: inst, bill, family: req.ctx.family, paidById, paidOn: b.paidOn || todayIn(req.ctx.family.timezone),
    receiptDocumentId: b.receiptDocumentId, memberName: payer?.displayName || 'Someone',
  });
  await audit(req, 'bill.pay', 'bill_instance', done._id, { title: bill.title });
  res.json(await reply(req, done, bill));
}));

// ---------- loans (private ones are visible only to their owner) ----------
const loanVisible = (req) => ({ familyId: req.ctx.familyId });
const canSeeLoan = (req, l) => l.visibility === 'family' || String(l.ownerId) === req.ctx.me;

loans.get('/', h(async (req, res) => {
  const list = (await Loan.find(loanVisible(req)).sort({ _id: -1 }).limit(100)).filter((l) => canSeeLoan(req, l));
  const { map } = await loadMembers(req.ctx.familyId);
  const today = todayIn(req.ctx.family.timezone);
  res.json(list.map((l) => loanDto(l, today, map)));
}));

loans.post('/', validate({
  body: z.object({
    lender: text(80), principal: money, interestRate: z.number().min(0).max(60).default(0),
    emiAmount: money.optional(), emiDay: z.number().int().min(1).max(28), startDate: ymd,
    tenureMonths: z.number().int().min(1).max(600), outstanding: money.optional(), visibility: z.enum(['private', 'family']).default('private'),
  }).strict().refine((b) => !b.outstanding || b.outstanding <= b.principal, { message: 'Outstanding cannot exceed the principal', path: ['outstanding'] }),
}), h(async (req, res) => {
  const b = req.valid.body;
  const emiAmount = b.emiAmount || suggestEmi(b.principal, b.interestRate, b.tenureMonths);
  const loan = await Loan.create({ ...b, emiAmount, outstanding: b.outstanding || b.principal, familyId: req.ctx.familyId, ownerId: req.ctx.me });
  if (b.visibility === 'family') {
    const today = todayIn(req.ctx.family.timezone);
    const base = b.startDate > today ? b.startDate : today;
    let anchor = `${base.slice(0, 8)}${String(b.emiDay).padStart(2, '0')}`;
    if (anchor < base) anchor = addMonths(anchor, 1);
    const bill = await Bill.create({
      familyId: req.ctx.familyId, title: `${b.lender} EMI`, category: 'emi', amountMode: 'fixed', fixedAmount: emiAmount,
      rule: { unit: 'month', everyN: 1, anchorDate: anchor, endDate: addMonths(b.startDate, b.tenureMonths + 1) },
      payerId: req.ctx.me, reminderDaysBefore: 3, splitAmong: [req.ctx.me], loanId: loan._id, createdBy: req.ctx.me,
    });
    loan.billId = bill._id;
    await loan.save();
    await ensureInstances(req.ctx.family);
  }
  await audit(req, 'loan.create', 'loan', loan._id, { visibility: b.visibility });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(loanDto(loan, todayIn(req.ctx.family.timezone), map));
}));

async function loadLoan(req) {
  const l = await Loan.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!l || !canSeeLoan(req, l)) throw notFound('Loan not found');
  return l;
}

loans.get('/:id', validate({ params: idParams }), h(async (req, res) => {
  const l = await loadLoan(req);
  const { map } = await loadMembers(req.ctx.familyId);
  const pays = await LoanPayment.find({ loanId: l._id }).sort({ paidOn: -1 }).limit(36);
  res.json({ ...loanDto(l, todayIn(req.ctx.family.timezone), map), payments: pays.map(loanPaymentDto) });
}));

loans.post('/:id/payments', validate({ params: idParams, body: z.object({ paidOn: ymd, amount: money }).strict() }), h(async (req, res) => {
  const l = await loadLoan(req);
  if (String(l.ownerId) !== req.ctx.me) throw forbidden('Only the loan owner can record payments');
  const p = await recordLoanPayment(l, req.valid.body);
  const fresh = await Loan.findById(l._id);
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json({ loan: loanDto(fresh, todayIn(req.ctx.family.timezone), map), payment: loanPaymentDto(p) });
}));

loans.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const l = await loadLoan(req);
  if (String(l.ownerId) !== req.ctx.me && !(l.visibility === 'family' && isAdmin(req))) throw forbidden('Only the loan owner can delete it');
  if (l.billId) {
    await Bill.updateOne({ _id: l.billId }, { $set: { active: false } });
    await removeOpenInstances(l.billId);
  }
  await LoanPayment.deleteMany({ loanId: l._id });
  await l.deleteOne();
  await audit(req, 'loan.delete', 'loan', l._id);
  res.status(204).end();
}));
export { conflict, addDays };
