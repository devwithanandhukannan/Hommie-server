import { Bill, BillInstance, Task, Membership, Expense } from '../models/index.js';
import { dueDatesBetween } from '../lib/recurrence.js';
import { addDays, todayIn } from '../lib/dates.js';
import { notify, userIdsOf } from './push.js';
import { equalSplit, createExpense } from './expenses.js';
import { systemMessage } from './chat.js';
import { recordLoanPayment } from './loans.js';
import { Loan } from '../models/index.js';
import { conflict, badRequest } from '../lib/errors.js';

const EXPENSE_CATEGORY = { rent: 'rent', tax: 'tax', emi: 'emi' };
const rupees = (p) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const money = rupees;

const taskTitle = (bill, instance) =>
  instance.status === 'awaiting_amount' ? `Enter ${bill.title} amount` : `Pay ${bill.title} · ${rupees(instance.amount)}`;

async function memberUserIds(ids) {
  const ms = await Membership.find({ _id: { $in: ids }, status: 'active' });
  return userIdsOf(ms);
}

/** Creates the instance (+ its task + notification) for one due date. Safe to call repeatedly. */
export async function createInstance(bill, dueDate) {
  const awaiting = !(bill.amountMode === 'fixed' && bill.fixedAmount);
  let inst;
  try {
    inst = await BillInstance.create({
      familyId: bill.familyId, billId: bill._id, dueDate,
      amount: awaiting ? null : bill.fixedAmount, status: awaiting ? 'awaiting_amount' : 'pending',
    });
  } catch (e) {
    if (e?.code === 11000) return null;
    throw e;
  }
  const task = await Task.create({
    familyId: bill.familyId, title: taskTitle(bill, inst), kind: 'bill', assigneeId: bill.payerId, dueDate,
    link: { kind: 'bill_instance', id: inst._id },
  });
  inst.taskId = task._id;
  await inst.save();
  const uids = await memberUserIds([bill.payerId]);
  await notify({
    userIds: uids, familyId: bill.familyId, type: 'bill', url: '/bills',
    title: awaiting ? `Enter the amount for ${bill.title}` : `${bill.title} is due ${dueDate}`,
    body: awaiting ? `Due ${dueDate}. Open the app to add the amount.` : `Due ${dueDate}.`,
    dedupeKey: `bill:${inst._id}:created`,
    pushBody: `Due ${dueDate}`,
  });
  return inst;
}

/** Generates instances for every active bill whose reminder window has started. */
export async function ensureInstances(family, today = todayIn(family.timezone)) {
  const bills = await Bill.find({ familyId: family._id, active: true });
  let created = 0;
  for (const bill of bills) {
    const dates = dueDatesBetween(bill.rule, addDays(today, -7), addDays(today, bill.reminderDaysBefore));
    for (const d of dates) if (await createInstance(bill, d)) created++;
  }
  return created;
}

export async function setAmount(instance, bill, amount) {
  if (instance.status === 'paid') throw conflict('This bill is already paid');
  instance.amount = amount;
  instance.status = 'pending';
  await instance.save();
  if (instance.taskId) await Task.updateOne({ _id: instance.taskId }, { $set: { title: taskTitle(bill, instance) } });
  return instance;
}

/** Marks an instance as paid exactly once; creates the expense, closes the task, posts to chat, updates the loan. */
export async function payInstance({ instance, bill, family, paidById, paidOn, receiptDocumentId, memberName }) {
  if (instance.amount == null) throw badRequest('Add the amount before marking this bill as paid');
  const won = await BillInstance.findOneAndUpdate(
    { _id: instance._id, status: { $ne: 'paid' } },
    { $set: { status: 'paid', paidBy: paidById, paidAt: new Date(), ...(receiptDocumentId ? { receiptDocumentId } : {}) } },
    { new: true },
  );
  if (!won) throw conflict('This bill is already paid');

  let expense;
  try {
    const active = await Membership.find({ familyId: family._id, status: 'active' });
    const activeIds = active.map((m) => String(m._id));
    let among = (bill.splitAmong || []).map(String).filter((id) => activeIds.includes(id));
    if (!among.length) among = activeIds;
    expense = await createExpense({
      familyId: family._id, amount: won.amount, category: EXPENSE_CATEGORY[bill.category] || 'bills', date: paidOn,
      paidById, split: equalSplit(won.amount, among), note: bill.title, source: 'bill', sourceId: won._id, createdBy: paidById,
    });
    won.expenseId = expense._id;
    await won.save();
  } catch (e) {
    // Nothing else was written yet: put the bill back so the payment can simply be tried again.
    await BillInstance.updateOne({ _id: instance._id }, { $set: { status: 'pending' }, $unset: { paidBy: 1, paidAt: 1, receiptDocumentId: 1 } });
    throw e;
  }
  if (won.taskId) await Task.updateOne({ _id: won.taskId }, { $set: { status: 'done', completedBy: paidById, completedAt: new Date() } });
  if (bill.loanId) {
    const loan = await Loan.findById(bill.loanId);
    if (loan && !loan.closedAt) await recordLoanPayment(loan, { paidOn, amount: won.amount, billInstanceId: won._id });
  }
  await systemMessage(family._id, `${bill.title} (${rupees(won.amount)}) paid by ${memberName}`, { kind: 'bill_instance', id: won._id, title: `${bill.title} · due ${won.dueDate}` });
  return won;
}
