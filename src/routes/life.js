import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, notFound } from '../lib/errors.js';
import { validate, idParams, oid, ymd, text, optText } from '../lib/validate.js';
import { SpecialDate, Guest, Contact, Membership } from '../models/index.js';
import { specialDateDto, guestDto, contactDto } from '../dto.js';
import { loadMembers } from '../services/members.js';
import { todayIn, diffDays } from '../lib/dates.js';

export const specialDates = Router();
export const guests = Router();
export const contacts = Router();

/** Next date this event happens (yearly events fall back to 28 Feb in non-leap years). */
export function nextOccurrence(sd, today) {
  if (!sd.repeatYearly) return sd.date >= today ? sd.date : null;
  const [, mm, dd] = sd.date.split('-');
  const at = (y) => {
    const d = `${y}-${mm}-${dd}`;
    return new Date(`${d}T00:00:00Z`).toISOString().slice(5, 10) === `${mm}-${dd}` ? d : `${y}-02-28`;
  };
  const y = Number(today.slice(0, 4));
  return at(y) >= today ? at(y) : at(y + 1);
}
const dto = (d, map, today) => { const next = nextOccurrence(d, today); return specialDateDto(d, map, next, next ? diffDays(next, today) : null); };

const checklistItem = z.object({ text: text(120), assigneeId: oid.optional() }).strict();
const sdShape = z.object({
  title: text(100), kind: z.enum(['birthday', 'anniversary', 'shraddham', 'festival', 'other']).default('other'), date: ymd,
  repeatYearly: z.boolean().default(true), remindDaysBefore: z.number().int().min(0).max(60).default(7),
  checklist: z.array(checklistItem).max(40).default([]),
}).strict();

async function checkAssignees(familyId, items) {
  const ids = [...new Set(items.map((i) => i.assigneeId).filter(Boolean))];
  if (!ids.length) return;
  if ((await Membership.countDocuments({ _id: { $in: ids }, familyId, status: 'active' })) !== ids.length) throw badRequest('Some assignees are not in this family');
}

specialDates.get('/', h(async (req, res) => {
  const { map } = await loadMembers(req.ctx.familyId);
  const today = todayIn(req.ctx.family.timezone);
  const list = (await SpecialDate.find({ familyId: req.ctx.familyId }).limit(300)).map((d) => dto(d, map, today));
  list.sort((a, b) => (a.daysAway ?? 99999) - (b.daysAway ?? 99999));
  res.json(list);
}));
specialDates.post('/', validate({ body: sdShape }), h(async (req, res) => {
  await checkAssignees(req.ctx.familyId, req.valid.body.checklist);
  const d = await SpecialDate.create({ ...req.valid.body, familyId: req.ctx.familyId, createdBy: req.ctx.me });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(dto(d, map, todayIn(req.ctx.family.timezone)));
}));
specialDates.patch('/:id', validate({ params: idParams, body: sdShape.omit({ checklist: true }).partial() }), h(async (req, res) => {
  const d = await SpecialDate.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!d) throw notFound();
  Object.assign(d, req.valid.body);
  await d.save();
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(dto(d, map, todayIn(req.ctx.family.timezone)));
}));
specialDates.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const r = await SpecialDate.deleteOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!r.deletedCount) throw notFound();
  res.status(204).end();
}));
specialDates.post('/:id/checklist', validate({ params: idParams, body: checklistItem }), h(async (req, res) => {
  await checkAssignees(req.ctx.familyId, [req.valid.body]);
  const d = await SpecialDate.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!d) throw notFound();
  if (d.checklist.length >= 40) throw badRequest('The checklist is full');
  d.checklist.push(req.valid.body);
  await d.save();
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(dto(d, map, todayIn(req.ctx.family.timezone)));
}));
specialDates.patch('/:id/checklist/:itemId', validate({
  params: z.object({ id: oid, itemId: oid }).strict(), body: z.object({ done: z.boolean().optional(), assigneeId: oid.nullable().optional() }).strict(),
}), h(async (req, res) => {
  const d = await SpecialDate.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  const item = d?.checklist.id(req.valid.params.itemId);
  if (!item) throw notFound();
  if (req.valid.body.assigneeId) await checkAssignees(req.ctx.familyId, [{ assigneeId: req.valid.body.assigneeId }]);
  if (req.valid.body.done !== undefined) item.done = req.valid.body.done;
  if (req.valid.body.assigneeId !== undefined) item.assigneeId = req.valid.body.assigneeId || undefined;
  await d.save();
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(dto(d, map, todayIn(req.ctx.family.timezone)));
}));
specialDates.delete('/:id/checklist/:itemId', validate({ params: z.object({ id: oid, itemId: oid }).strict() }), h(async (req, res) => {
  const d = await SpecialDate.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!d) throw notFound();
  d.checklist = d.checklist.filter((c) => String(c._id) !== req.valid.params.itemId);
  await d.save();
  res.status(204).end();
}));

// ---------- guests ----------
const guestShape = z.object({ name: text(80), from: ymd, to: ymd, notes: optText(300) }).strict().refine((g) => g.to >= g.from, { message: 'End date is before the start date', path: ['to'] });
guests.get('/', h(async (req, res) => {
  const { map } = await loadMembers(req.ctx.familyId);
  const today = todayIn(req.ctx.family.timezone);
  const list = await Guest.find({ familyId: req.ctx.familyId, to: { $gte: today } }).sort({ from: 1 }).limit(100);
  res.json(list.map((g) => guestDto(g, map)));
}));
guests.post('/', validate({ body: guestShape }), h(async (req, res) => {
  const g = await Guest.create({ ...req.valid.body, familyId: req.ctx.familyId, hostId: req.ctx.me });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(guestDto(g, map));
}));
guests.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const r = await Guest.deleteOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!r.deletedCount) throw notFound();
  res.status(204).end();
}));

// ---------- emergency contacts ----------
const contactShape = z.object({
  name: text(80), role: z.enum(['doctor', 'plumber', 'electrician', 'neighbour', 'relative', 'other']).default('other'),
  phone: z.string().trim().regex(/^\+?[\d\s-]{5,18}$/, 'Enter a valid phone number'), notes: optText(200),
}).strict();
contacts.get('/', h(async (req, res) => res.json((await Contact.find({ familyId: req.ctx.familyId }).sort({ name: 1 }).limit(200)).map(contactDto))));
contacts.post('/', validate({ body: contactShape }), h(async (req, res) => res.status(201).json(contactDto(await Contact.create({ ...req.valid.body, familyId: req.ctx.familyId })))));
contacts.patch('/:id', validate({ params: idParams, body: contactShape.partial() }), h(async (req, res) => {
  const c = await Contact.findOneAndUpdate({ _id: req.valid.params.id, familyId: req.ctx.familyId }, { $set: req.valid.body }, { new: true });
  if (!c) throw notFound();
  res.json(contactDto(c));
}));
contacts.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const r = await Contact.deleteOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!r.deletedCount) throw notFound();
  res.status(204).end();
}));
