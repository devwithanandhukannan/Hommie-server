import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest } from '../lib/errors.js';
import { validate, ymd, ym } from '../lib/validate.js';
import { Task, BillInstance, Bill, Medicine, MedicineLog, SpecialDate, Document, MealPlan, Recipe, Loan, Guest } from '../models/index.js';
import { canViewDoc, canSeeMedicine } from '../dto.js';
import { loadMembers, pick } from '../services/members.js';
import { ensureInstances } from '../services/bills.js';
import { todayIn, diffDays, addDays, weekday } from '../lib/dates.js';

export const calendar = Router();

calendar.get('/', validate({
  query: z.object({
    month: ym.optional(),
    from: ymd.optional(),
    to: ymd.optional(),
  }).strict(),
}), h(async (req, res) => {
  const { familyId, me, family } = req.ctx;
  const tz = family.timezone;
  const today = todayIn(tz);

  let from = req.valid.query.from;
  let to = req.valid.query.to;

  if (req.valid.query.month) {
    const [y, m] = req.valid.query.month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    from = `${req.valid.query.month}-01`;
    to = `${req.valid.query.month}-${String(lastDay).padStart(2, '0')}`;
  } else if (!from || !to) {
    const [y, m] = today.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const ymStr = `${y}-${String(m).padStart(2, '0')}`;
    from = `${ymStr}-01`;
    to = `${ymStr}-${String(lastDay).padStart(2, '0')}`;
  }

  if (to < from || diffDays(to, from) > 62) {
    throw badRequest('Date range must be between 1 and 62 days');
  }

  await ensureInstances(family, today);
  const { map } = await loadMembers(familyId);

  // Parallel fetch of all items within range
  const [tasks, openInst, recipes, meals, specials, meds, medLogs, docsList, loans, guests] = await Promise.all([
    Task.find({ familyId, dueDate: { $gte: from, $lte: to } }).limit(500),
    BillInstance.find({ familyId, dueDate: { $gte: from, $lte: to } }).limit(500),
    Recipe.find({ familyId }).select('title'),
    MealPlan.find({ familyId, date: { $gte: from, $lte: to } }).limit(500),
    SpecialDate.find({ familyId }).limit(500),
    Medicine.find({ familyId, active: true }).limit(200),
    MedicineLog.find({ familyId, date: { $gte: from, $lte: to } }).limit(1000),
    Document.find({ familyId, expiryDate: { $gte: from, $lte: to } }).limit(300),
    Loan.find({ familyId, closedAt: null }).limit(100),
    Guest.find({ familyId, from: { $lte: to }, to: { $gte: from } }).limit(100),
  ]);

  const recipeMap = new Map(recipes.map((r) => [String(r._id), r.title]));
  const billsById = new Map((await Bill.find({ _id: { $in: openInst.map((i) => i.billId) } })).map((b) => [String(b._id), b]));

  const events = [];

  // 1. Tasks
  for (const t of tasks) {
    events.push({
      id: String(t._id),
      date: t.dueDate,
      type: 'task',
      title: t.title,
      subtitle: t.kind === 'chore' ? 'Chore' : 'Task',
      status: t.status,
      kind: t.kind,
      person: pick(map, t.assigneeId),
      link: '/tasks',
    });
  }

  // 2. Bills
  for (const inst of openInst) {
    const bill = billsById.get(String(inst.billId));
    events.push({
      id: String(inst._id),
      date: inst.dueDate,
      type: 'bill',
      title: bill?.title || 'Bill',
      subtitle: inst.amount != null ? `₹${(inst.amount / 100).toLocaleString('en-IN')}` : 'Amount needed',
      status: inst.status,
      kind: bill?.category || 'other',
      person: pick(map, bill?.payerId),
      link: '/bills',
      meta: { amount: inst.amount, billId: String(inst.billId) },
    });
  }

  // 3. Meals
  for (const m of meals) {
    const slotLabel = m.slot === 'morning' ? 'Breakfast' : m.slot === 'noon' ? 'Lunch' : 'Dinner';
    const dishList = m.items?.length ? m.items.join(', ') : (m.recipeId ? recipeMap.get(String(m.recipeId)) : '');
    if (dishList) {
      events.push({
        id: String(m._id),
        date: m.date,
        type: 'meal',
        title: `${slotLabel}: ${dishList}`,
        subtitle: slotLabel,
        status: 'planned',
        slot: m.slot,
        person: pick(map, m.cookId),
        link: '/meals',
        meta: { items: m.items, recipeTitle: recipeMap.get(String(m.recipeId)) },
      });
    }
  }

  // 4. Special Dates (birthdays, anniversaries, festivals)
  const startYear = Number(from.slice(0, 4));
  const endYear = Number(to.slice(0, 4));
  for (const sd of specials) {
    if (sd.repeatYearly) {
      const [, mm, dd] = sd.date.split('-');
      for (let y = startYear; y <= endYear; y++) {
        const cand = `${y}-${mm}-${dd}`;
        if (cand >= from && cand <= to) {
          events.push({
            id: `${sd._id}-${y}`,
            date: cand,
            type: 'special_day',
            title: sd.title,
            subtitle: sd.kind === 'birthday' ? 'Birthday' : sd.kind === 'anniversary' ? 'Anniversary' : sd.kind === 'festival' ? 'Festival' : 'Special day',
            status: 'event',
            kind: sd.kind,
            person: pick(map, sd.createdBy),
            link: '/special-days',
          });
        }
      }
    } else if (sd.date >= from && sd.date <= to) {
      events.push({
        id: String(sd._id),
        date: sd.date,
        type: 'special_day',
        title: sd.title,
        subtitle: 'Special day',
        status: 'event',
        kind: sd.kind,
        person: pick(map, sd.createdBy),
        link: '/special-days',
      });
    }
  }

  // 5. Medicines
  const visibleMeds = meds.filter((m) => canSeeMedicine(m, me));
  const logsByKey = new Set(medLogs.filter((l) => l.status === 'given').map((l) => `${l.date}_${l.medicineId}_${l.time}`));
  if (visibleMeds.length) {
    let cur = from;
    while (cur <= to) {
      const dayW = weekday(cur);
      for (const m of visibleMeds) {
        if (cur < m.startDate || (m.endDate && cur > m.endDate)) continue;
        if (m.days?.length && !m.days.includes(dayW)) continue;
        for (const time of (m.times || [])) {
          const isGiven = logsByKey.has(`${cur}_${m._id}_${time}`);
          events.push({
            id: `${m._id}_${cur}_${time}`,
            date: cur,
            type: 'medicine',
            title: `${m.name} (${time})`,
            subtitle: m.dosage ? `${m.dosage} · ${time}` : time,
            status: isGiven ? 'given' : (cur < today ? 'missed' : 'scheduled'),
            person: pick(map, m.forId),
            link: '/medicine',
            meta: { medicineId: String(m._id), time },
          });
        }
      }
      cur = addDays(cur, 1);
    }
  }

  // 6. Guest Stays
  for (const g of guests) {
    let cur = g.from < from ? from : g.from;
    const end = g.to > to ? to : g.to;
    while (cur <= end) {
      const isStart = cur === g.from;
      const isEnd = cur === g.to;
      events.push({
        id: `${g._id}_${cur}`,
        date: cur,
        type: 'guest',
        title: isStart ? `Guest Arrival: ${g.name}` : isEnd ? `Guest Departure: ${g.name}` : `Guest staying: ${g.name}`,
        subtitle: g.notes || 'Guest visit',
        status: 'stay',
        person: pick(map, g.hostId),
        link: '/special-days',
      });
      cur = addDays(cur, 1);
    }
  }

  // 7. Documents Expiring
  for (const d of docsList) {
    if (canViewDoc(d, me) && d.expiryDate >= from && d.expiryDate <= to) {
      events.push({
        id: String(d._id),
        date: d.expiryDate,
        type: 'document',
        title: `Document Expiry: ${d.title}`,
        subtitle: `${d.category} expires`,
        status: 'expiring',
        person: pick(map, d.ownerId),
        link: '/documents',
      });
    }
  }

  // 8. Loan EMIs
  for (const l of loans) {
    if (l.visibility === 'family' || String(l.ownerId) === me) {
      const startM = Number(from.slice(5, 7));
      const endM = Number(to.slice(5, 7));
      const y = Number(from.slice(0, 4));
      for (let m = startM; m <= endM; m++) {
        const cand = `${y}-${String(m).padStart(2, '0')}-${String(l.emiDay).padStart(2, '0')}`;
        if (cand >= from && cand <= to) {
          events.push({
            id: `${l._id}_${cand}`,
            date: cand,
            type: 'loan_emi',
            title: `EMI Due: ${l.lender}`,
            subtitle: `₹${(l.emiAmount / 100).toLocaleString('en-IN')}`,
            status: 'due',
            person: pick(map, l.ownerId),
            link: '/bills',
          });
        }
      }
    }
  }

  // Group events by date
  const byDate = {};
  for (const ev of events) {
    if (!byDate[ev.date]) byDate[ev.date] = [];
    byDate[ev.date].push(ev);
  }

  // Sort events inside each day by priority
  const typeOrder = { special_day: 1, meal: 2, bill: 3, loan_emi: 4, task: 5, medicine: 6, guest: 7, document: 8 };
  for (const date in byDate) {
    byDate[date].sort((a, b) => (typeOrder[a.type] || 9) - (typeOrder[b.type] || 9));
  }

  res.json({
    today,
    from,
    to,
    month: from.slice(0, 7),
    eventsCount: events.length,
    byDate,
  });
}));

