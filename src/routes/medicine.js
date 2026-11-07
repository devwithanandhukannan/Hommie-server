import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { validate, idParams, oid, ymd, hhmm, text, optText } from '../lib/validate.js';
import { Medicine, MedicineLog, Membership } from '../models/index.js';
import { medicineDto, canSeeMedicine } from '../dto.js';
import { loadMembers, pick } from '../services/members.js';
import { todayIn, timeIn, weekday, addDays } from '../lib/dates.js';

// Medicine details are visible only to the person the medicine is for, their caregivers and whoever added it (not to admins).
export const medicines = Router();

const shape = z.object({
  forId: oid, name: text(80), dosage: optText(60), times: z.array(hhmm).min(1).max(6), days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  startDate: ymd, endDate: ymd.optional(), stock: z.number().int().min(0).max(100000).optional(), caregiverIds: z.array(oid).max(10).default([]), notes: optText(300),
}).strict();

async function checkMembers(familyId, ids) {
  const uniq = [...new Set(ids)];
  const n = await Membership.countDocuments({ _id: { $in: uniq }, familyId, status: 'active' });
  if (n !== uniq.length) throw badRequest('Some selected members are not in this family');
}
const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** Doses scheduled on `date` for the medicines visible to the viewer. */
export function dosesFor(meds, logs, date, nowTime, today, map) {
  const out = [];
  for (const m of meds) {
    if (!m.active || m.startDate > date || (m.endDate && m.endDate < date)) continue;
    if (m.days?.length && !m.days.includes(weekday(date))) continue;
    for (const time of [...m.times].sort()) {
      const log = logs.find((l) => String(l.medicineId) === String(m._id) && l.date === date && l.time === time);
      let status = log ? log.status : 'pending';
      if (status === 'pending' && (date < today || (date === today && minutes(nowTime) > minutes(time) + 60))) status = 'missed';
      out.push({ medicineId: String(m._id), forMember: pick(map, m.forId), name: m.name, dosage: m.dosage || '', date, time, status, lowStock: m.stock != null && m.stock <= 3 });
    }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

medicines.get('/', h(async (req, res) => {
  const list = (await Medicine.find({ familyId: req.ctx.familyId, active: true }).limit(200)).filter((m) => canSeeMedicine(m, req.ctx.me));
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(list.map((m) => medicineDto(m, map)));
}));

medicines.get('/today', h(async (req, res) => {
  const tz = req.ctx.family.timezone;
  const today = todayIn(tz);
  const meds = (await Medicine.find({ familyId: req.ctx.familyId, active: true }).limit(200)).filter((m) => canSeeMedicine(m, req.ctx.me));
  const logs = await MedicineLog.find({ familyId: req.ctx.familyId, date: today, medicineId: { $in: meds.map((m) => m._id) } });
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(dosesFor(meds, logs, today, timeIn(tz), today, map));
}));

medicines.post('/', validate({ body: shape }), h(async (req, res) => {
  const { caregiverIds, ...b } = req.valid.body;
  await checkMembers(req.ctx.familyId, [b.forId, ...caregiverIds]);
  const m = await Medicine.create({ ...b, caregivers: caregiverIds, familyId: req.ctx.familyId, createdBy: req.ctx.me });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(medicineDto(m, map));
}));

async function loadMed(req) {
  const m = await Medicine.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId, active: true });
  if (!m || !canSeeMedicine(m, req.ctx.me)) throw notFound('Medicine not found');
  return m;
}

medicines.patch('/:id', validate({ params: idParams, body: shape.partial() }), h(async (req, res) => {
  const m = await loadMed(req);
  const { caregiverIds, ...rest } = req.valid.body;
  await checkMembers(req.ctx.familyId, [rest.forId, ...(caregiverIds || [])].filter(Boolean));
  Object.assign(m, rest);
  if (caregiverIds) m.caregivers = caregiverIds;
  await m.save();
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(medicineDto(m, map));
}));

medicines.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const m = await loadMed(req);
  m.active = false;
  await m.save();
  res.status(204).end();
}));

medicines.post('/:id/logs', validate({
  params: idParams, body: z.object({ time: hhmm, status: z.enum(['given', 'skipped']), date: ymd.optional() }).strict(),
}), h(async (req, res) => {
  const m = await loadMed(req);
  const today = todayIn(req.ctx.family.timezone);
  const date = req.valid.body.date || today;
  if (date > today || date < addDays(today, -2)) throw badRequest('You can only record today or the last two days');
  if (!m.times.includes(req.valid.body.time)) throw badRequest('That time is not in the schedule');
  try {
    await MedicineLog.create({ familyId: req.ctx.familyId, medicineId: m._id, forId: m.forId, date, time: req.valid.body.time, status: req.valid.body.status, byId: req.ctx.me });
  } catch (e) {
    if (e?.code === 11000) throw conflict('This dose was already recorded');
    throw e;
  }
  if (req.valid.body.status === 'given' && m.stock != null && m.stock > 0) { m.stock -= 1; await m.save(); }
  const logs = await MedicineLog.find({ medicineId: m._id, date });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(dosesFor([m], logs, date, timeIn(req.ctx.family.timezone), today, map).find((d) => d.time === req.valid.body.time));
}));
export { forbidden };
