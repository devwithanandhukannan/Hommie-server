import { Family, Bill, BillInstance, Membership, Medicine, MedicineLog, SpecialDate, Document, Loan, Task } from '../models/index.js';
import { ensureInstances, money } from '../services/bills.js';
import { notify, userIdsOf } from '../services/push.js';
import { todayIn, timeIn, diffDays, weekday, addDays } from '../lib/dates.js';
import { nextOccurrence } from '../routes/life.js';

let running = false;
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/**
 * Idempotent scheduler tick. Called every few minutes (by an in-process timer and/or an external cron ping).
 * Every notification carries a dedupeKey, so running it twice never notifies twice.
 */
export async function runTick(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  const stats = { families: 0, instances: 0, notifications: 0 };
  try {
    for (const family of await Family.find({})) {
      stats.families++;
      try {
        const today = todayIn(family.timezone, now);
        const time = timeIn(family.timezone, now);
        const members = await Membership.find({ familyId: family._id, status: 'active' });
        const byId = new Map(members.map((m) => [String(m._id), m]));
        const uidOf = (id) => (byId.get(String(id))?.userId ? [String(byId.get(String(id)).userId)] : []);
        const allUids = userIdsOf(members);
        const adminUids = userIdsOf(members.filter((m) => ['owner', 'admin'].includes(m.role)));

        stats.instances += await ensureInstances(family, today);

        // 1. bills: reminder when the window opens, then once more when overdue
        const open = await BillInstance.find({ familyId: family._id, status: { $ne: 'paid' } }).limit(300);
        for (const inst of open) {
          const bill = await Bill.findById(inst.billId);
          if (!bill) continue;
          const daysLeft = diffDays(inst.dueDate, today);
          if (daysLeft < 0 && !inst.overdueSentAt) {
            await notify({
              userIds: [...uidOf(bill.payerId), ...adminUids], familyId: family._id, type: 'bill', url: '/bills',
              title: `${bill.title} is overdue`, body: `It was due on ${inst.dueDate}.`, dedupeKey: `bill:${inst._id}:overdue`,
            });
            inst.overdueSentAt = now; await inst.save(); stats.notifications++;
          } else if (daysLeft >= 0 && daysLeft <= bill.reminderDaysBefore && !inst.reminderSentAt && daysLeft <= 1) {
            await notify({
              userIds: uidOf(bill.payerId), familyId: family._id, type: 'bill', url: '/bills',
              title: daysLeft === 0 ? `${bill.title} is due today` : `${bill.title} is due tomorrow`,
              body: inst.amount != null ? `Amount ${money(inst.amount)}` : 'Amount still needed', pushBody: 'Open the app to take care of it',
              dedupeKey: `bill:${inst._id}:due`,
            });
            inst.reminderSentAt = now; await inst.save(); stats.notifications++;
          }
        }

        // 2. medicine: remind the person and their caregivers at the dose time (5-minute window)
        const meds = await Medicine.find({ familyId: family._id, active: true });
        for (const m of meds) {
          if (m.startDate > today || (m.endDate && m.endDate < today)) continue;
          if (m.days?.length && !m.days.includes(weekday(today))) continue;
          for (const t of m.times) {
            const late = minutes(time) - minutes(t);
            if (late < 0 || late > 30) continue;
            if (await MedicineLog.exists({ medicineId: m._id, date: today, time: t })) continue;
            await notify({
              userIds: [...uidOf(m.forId), ...(m.caregivers || []).flatMap(uidOf)], familyId: family._id, type: 'medicine', url: '/medicine',
              title: 'Medicine time', body: `${byId.get(String(m.forId))?.displayName || 'Someone'}: ${m.name} at ${t}`,
              pushTitle: 'Medicine time', pushBody: `Dose due at ${t}`, dedupeKey: `med:${m._id}:${today}:${t}`,
            });
            stats.notifications++;
          }
          if (m.stock != null && m.stock <= 3) {
            await notify({
              userIds: [...uidOf(m.forId), ...(m.caregivers || []).flatMap(uidOf)], familyId: family._id, type: 'medicine', url: '/medicine',
              title: 'Medicine running low', body: `${m.name}: ${m.stock} left`, dedupeKey: `medstock:${m._id}:${today}`,
            });
          }
        }

        // 3. special days
        for (const d of await SpecialDate.find({ familyId: family._id })) {
          const next = nextOccurrence(d, today);
          if (!next) continue;
          const away = diffDays(next, today);
          if (away === d.remindDaysBefore || away === 0) {
            await notify({
              userIds: allUids, familyId: family._id, type: 'date', url: '/special-days',
              title: away === 0 ? `Today: ${d.title}` : `${d.title} in ${away} day${away === 1 ? '' : 's'}`, body: next,
              dedupeKey: `date:${d._id}:${next}:${away}`,
            });
            stats.notifications++;
          }
        }

        // 4. documents about to expire (30, 7 and 1 days before), to the owner only
        for (const d of await Document.find({ familyId: family._id, expiryDate: { $ne: null } })) {
          const away = diffDays(d.expiryDate, today);
          if ([30, 7, 1, 0].includes(away)) {
            await notify({
              userIds: uidOf(d.ownerId), familyId: family._id, type: 'document', url: '/documents',
              title: away === 0 ? `A document expires today` : `A document expires in ${away} day${away === 1 ? '' : 's'}`,
              body: d.title, pushBody: 'Open the app to see which one', dedupeKey: `doc:${d._id}:${away}`,
            });
            stats.notifications++;
          }
        }

        // 5. private loans have no family bill: remind only the owner 3 days before the EMI
        for (const l of await Loan.find({ familyId: family._id, closedAt: null, visibility: 'private' })) {
          for (const offset of [0, 1]) {
            const [y, mo] = addDays(today, 0).split('-').map(Number);
            const ny = mo + offset > 12 ? y + 1 : y, nm = ((mo - 1 + offset) % 12) + 1;
            const emi = `${ny}-${String(nm).padStart(2, '0')}-${String(l.emiDay).padStart(2, '0')}`;
            const away = diffDays(emi, today);
            if (away >= 0 && away <= 3) {
              await notify({ userIds: uidOf(l.ownerId), familyId: family._id, type: 'loan', url: '/money', title: 'A loan EMI is coming up', body: `Due ${emi}`, pushBody: `Due ${emi}`, dedupeKey: `loan:${l._id}:${emi}` });
              stats.notifications++;
            }
          }
        }
        void Task;
      } catch (e) {
        console.error(`[tick] family ${family._id} failed:`, e.message);
      }
    }
  } finally {
    running = false;
  }
  return stats;
}

export function startInternalCron(everyMs = 5 * 60_000) {
  const t = setInterval(() => runTick().catch((e) => console.error('[tick] failed:', e.message)), everyMs);
  t.unref();
  return t;
}
