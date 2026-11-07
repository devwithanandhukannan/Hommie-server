import { Router } from 'express';
import { h } from '../lib/errors.js';
import { Task, BillInstance, Bill, Medicine, MedicineLog, SpecialDate, Document, GroceryItem, MealPlan, ChatMessage, Expense, Settlement, Loan, Membership, Family } from '../models/index.js';
import { taskDto, instanceDto, docDto, canViewDoc, canSeeMedicine, groceryDto, mealDto, loanDto } from '../dto.js';
import { loadMembers, pick } from '../services/members.js';
import { ensureInstances } from '../services/bills.js';
import { computeBalances } from '../services/expenses.js';
import { dosesFor } from './medicine.js';
import { nextOccurrence } from './life.js';
import { todayIn, timeIn, diffDays } from '../lib/dates.js';
import { isAdmin } from '../middleware/auth.js';

export const dashboard = Router();
export const overview = Router();

dashboard.get('/', h(async (req, res) => {
  const { familyId, me, family } = req.ctx;
  const tz = family.timezone;
  const today = todayIn(tz);
  await ensureInstances(family, today);
  const { map, docs } = await loadMembers(familyId);

  const [myTasks, unclaimed, openInst, meds, specials, docsList, grocery, meals, expenses, settlements, loans] = await Promise.all([
    Task.find({ familyId, status: 'open', assigneeId: me }).sort({ dueDate: 1 }).limit(20),
    Task.countDocuments({ familyId, status: 'open', assigneeId: null }),
    BillInstance.find({ familyId, status: { $ne: 'paid' } }).sort({ dueDate: 1 }).limit(30),
    Medicine.find({ familyId, active: true }).limit(200),
    SpecialDate.find({ familyId }).limit(300),
    Document.find({ familyId, expiryDate: { $ne: null } }).limit(300),
    GroceryItem.find({ familyId }).limit(500),
    MealPlan.find({ familyId, date: today }),
    Expense.find({ familyId }).limit(20000),
    Settlement.find({ familyId }).limit(5000),
    Loan.find({ familyId, ownerId: me, closedAt: null }),
  ]);

  const billsById = new Map((await Bill.find({ _id: { $in: openInst.map((i) => i.billId) } })).map((b) => [String(b._id), b]));
  const instTasks = new Map((await Task.find({ _id: { $in: openInst.map((i) => i.taskId).filter(Boolean) } })).map((t) => [String(t._id), t]));
  const instances = openInst.map((i) => instanceDto(i, billsById.get(String(i.billId)), map, today, instTasks.get(String(i.taskId))));
  const mineInst = (i) => String(instTasks.get(i.taskId)?.assigneeId ?? billsById.get(i.billId)?.payerId) === me;

  const visibleMeds = meds.filter((m) => canSeeMedicine(m, me));
  const logs = await MedicineLog.find({ familyId, date: today, medicineId: { $in: visibleMeds.map((m) => m._id) } });
  const doses = dosesFor(visibleMeds, logs, today, timeIn(tz), today, map);

  const net = computeBalances(expenses, settlements);
  const myNet = net.get(me) || 0;

  const unread = await ChatMessage.countDocuments({ familyId, createdAt: { $gt: req.ctx.membership.lastChatReadAt }, senderId: { $ne: me } });
  const members = docs.length;

  res.json({
    date: today,
    myTasks: myTasks.map((t) => taskDto(t, map)),
    unclaimedTasks: unclaimed,
    billsNeedingAmount: instances.filter((i) => i.status === 'awaiting_amount' && (mineInst(i) || isAdmin(req))),
    upcomingBills: instances.filter((i) => i.daysLeft <= 14),
    wallet: { net: myNet, owed: Math.max(0, myNet), owe: Math.max(0, -myNet) },
    medicinesDueToday: doses.filter((d) => d.status !== 'given' && d.status !== 'skipped'),
    specialDatesSoon: specials.map((d) => { const n = nextOccurrence(d, today); return { id: String(d._id), title: d.title, kind: d.kind, nextDate: n, daysAway: n ? diffDays(n, today) : null }; })
      .filter((d) => d.daysAway !== null && d.daysAway <= 30).sort((a, b) => a.daysAway - b.daysAway),
    expiringDocuments: docsList.filter((d) => canViewDoc(d, me) && d.expiryDate && diffDays(d.expiryDate, today) <= 45)
      .map((d) => docDto(d, me, map, today)).sort((a, b) => a.expiresInDays - b.expiresInDays),
    grocery: {
      needed: grocery.filter((g) => g.status === 'needed').length,
      likelyLow: grocery.map((g) => groceryDto(g, map)).filter((g) => g.likelyLow).map((g) => ({ id: g.id, name: g.name })),
    },
    todayMeals: meals.map((m) => mealDto(m, map, undefined, 0)),
    upcomingEmi: loans.map((l) => loanDto(l, today, map)).filter((l) => l.nextEmiDate && diffDays(l.nextEmiDate, today) <= 14),
    unreadChat: unread, memberCount: members,
  });
}));

// One call across all of the caller's families (used by the "All families" view and the switcher badges).
overview.get('/', h(async (req, res) => {
  const mine = await Membership.find({ userId: req.ctx.user._id, status: 'active' });
  const fams = new Map((await Family.find({ _id: { $in: mine.map((m) => m.familyId) } })).map((f) => [String(f._id), f]));
  const out = [];
  for (const m of mine) {
    const f = fams.get(String(m.familyId));
    if (!f) continue;
    const today = todayIn(f.timezone);
    const [memberCount, openTasks, tasks, bills, unread] = await Promise.all([
      Membership.countDocuments({ familyId: f._id, status: 'active' }),
      Task.countDocuments({ familyId: f._id, status: 'open', assigneeId: m._id }),
      Task.find({ familyId: f._id, status: 'open', assigneeId: m._id }).sort({ dueDate: 1 }).limit(8),
      BillInstance.countDocuments({ familyId: f._id, status: { $ne: 'paid' }, dueDate: { $lte: today } }),
      ChatMessage.countDocuments({ familyId: f._id, createdAt: { $gt: m.lastChatReadAt }, senderId: { $ne: m._id } }),
    ]);
    out.push({
      id: String(f._id), name: f.name, type: f.type, myRole: m.role, myMembershipId: String(m._id), memberCount,
      openTasksForMe: openTasks, billsDue: bills, unreadChat: unread,
      tasks: tasks.map((t) => ({ id: String(t._id), title: t.title, dueDate: t.dueDate || null, kind: t.kind })),
    });
  }
  res.json(out);
}));
export { pick };
