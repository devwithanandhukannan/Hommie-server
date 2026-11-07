import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate, idParams, oid, ymd, text, optText } from '../lib/validate.js';
import { MealPlan, Recipe, Membership, Guest, Attachment } from '../models/index.js';
import { mealDto, recipeDto, recipeSummaryDto } from '../dto.js';
import { loadMembers } from '../services/members.js';
import { addNeeded } from './grocery.js';
import { isAdmin } from '../middleware/auth.js';
import { diffDays, addDays } from '../lib/dates.js';

const SLOTS = ['morning', 'noon', 'night'];
export const meals = Router();
export const recipes = Router();

async function guestsOn(familyId, from, to) {
  const list = await Guest.find({ familyId, from: { $lte: to }, to: { $gte: from } });
  return (date) => list.filter((g) => g.from <= date && g.to >= date).length;
}

meals.get('/', validate({ query: z.object({ from: ymd, to: ymd }).strict() }), h(async (req, res) => {
  const { from, to } = req.valid.query;
  if (to < from || diffDays(to, from) > 31) throw badRequest('Choose a range of at most 31 days');
  const list = await MealPlan.find({ familyId: req.ctx.familyId, date: { $gte: from, $lte: to } }).sort({ date: 1 });
  const { map } = await loadMembers(req.ctx.familyId);
  const titles = new Map((await Recipe.find({ _id: { $in: list.map((m) => m.recipeId).filter(Boolean) } }).select('title')).map((r) => [String(r._id), r.title]));
  const guests = await guestsOn(req.ctx.familyId, from, to);
  res.json(list.map((m) => mealDto(m, map, titles.get(String(m.recipeId)), guests(m.date))));
}));

const slotParams = z.object({ date: ymd, slot: z.enum(SLOTS) }).strict();

meals.put('/:date/:slot', validate({
  params: slotParams,
  body: z.object({ items: z.array(text(80)).max(12), recipeId: oid.nullable().optional(), cookId: oid.nullable().optional() }).strict(),
}), h(async (req, res) => {
  const { date, slot } = req.valid.params;
  const { items, recipeId, cookId } = req.valid.body;
  if (recipeId && !(await Recipe.exists({ _id: recipeId, familyId: req.ctx.familyId }))) throw badRequest('Unknown recipe');
  if (cookId && !(await Membership.exists({ _id: cookId, familyId: req.ctx.familyId, status: 'active' }))) throw badRequest('Unknown member');
  const set = { items, recipeId: recipeId ?? null, cookId: cookId ?? null };
  const m = await MealPlan.findOneAndUpdate({ familyId: req.ctx.familyId, date, slot }, { $set: set, $setOnInsert: { attendance: [] } }, { new: true, upsert: true });
  const { map } = await loadMembers(req.ctx.familyId);
  const recipe = m.recipeId ? await Recipe.findById(m.recipeId).select('title') : null;
  res.json(mealDto(m, map, recipe?.title, (await guestsOn(req.ctx.familyId, date, date))(date)));
}));

meals.post('/:date/:slot/attendance', validate({ params: slotParams, body: z.object({ status: z.enum(['in', 'out']), memberId: oid.optional() }).strict() }), h(async (req, res) => {
  const { date, slot } = req.valid.params;
  const memberId = req.valid.body.memberId || req.ctx.me;
  if (memberId !== req.ctx.me && !isAdmin(req)) throw forbidden('You can only change your own meal status');
  if (!(await Membership.exists({ _id: memberId, familyId: req.ctx.familyId, status: 'active' }))) throw badRequest('Unknown member');
  let m = await MealPlan.findOneAndUpdate({ familyId: req.ctx.familyId, date, slot }, { $setOnInsert: { items: [], attendance: [] } }, { new: true, upsert: true });
  m.attendance = (m.attendance || []).filter((a) => String(a.memberId) !== memberId);
  m.attendance.push({ memberId, status: req.valid.body.status });
  await m.save();
  const { map } = await loadMembers(req.ctx.familyId);
  const recipe = m.recipeId ? await Recipe.findById(m.recipeId).select('title') : null;
  res.json(mealDto(m, map, recipe?.title, (await guestsOn(req.ctx.familyId, date, date))(date)));
}));

meals.delete('/:date/:slot', validate({ params: slotParams }), h(async (req, res) => {
  await MealPlan.deleteOne({ familyId: req.ctx.familyId, date: req.valid.params.date, slot: req.valid.params.slot });
  res.status(204).end();
}));

// ---------- recipes ----------
const recipeBody = z.object({
  title: text(100),
  ingredients: z.array(z.object({ name: text(80), qty: optText(30) }).strict()).max(60).default([]),
  steps: z.array(text(600)).max(40).default([]),
  tags: z.array(text(24)).max(8).default([]),
  photoId: oid.nullable().optional(),
}).strict();

async function checkPhoto(req, photoId) {
  if (!photoId) return;
  const a = await Attachment.findOne({ _id: photoId, familyId: req.ctx.familyId }).select('mime');
  if (!a || !a.mime.startsWith('image/')) throw badRequest('Photo not found');
}

recipes.get('/', validate({ query: z.object({ q: z.string().trim().max(60).optional() }).strict() }), h(async (req, res) => {
  const { map } = await loadMembers(req.ctx.familyId);
  let list = await Recipe.find({ familyId: req.ctx.familyId }).sort({ _id: -1 }).limit(300);
  const q = req.valid.query.q?.toLowerCase();
  if (q) list = list.filter((r) => r.title.toLowerCase().includes(q) || (r.tags || []).some((t) => t.toLowerCase().includes(q)));
  res.json(list.map((r) => recipeSummaryDto(r, map)));
}));
recipes.get('/:id', validate({ params: idParams }), h(async (req, res) => {
  const r = await Recipe.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!r) throw notFound();
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(recipeDto(r, map));
}));
recipes.post('/', validate({ body: recipeBody }), h(async (req, res) => {
  await checkPhoto(req, req.valid.body.photoId);
  const r = await Recipe.create({ ...req.valid.body, photoId: req.valid.body.photoId || undefined, familyId: req.ctx.familyId, createdBy: req.ctx.me });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(recipeDto(r, map));
}));
recipes.patch('/:id', validate({ params: idParams, body: recipeBody.partial() }), h(async (req, res) => {
  const r = await Recipe.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!r) throw notFound();
  if (String(r.createdBy) !== req.ctx.me && !isAdmin(req)) throw forbidden('Only the author or an admin can edit this recipe');
  await checkPhoto(req, req.valid.body.photoId);
  Object.assign(r, req.valid.body, { photoId: req.valid.body.photoId === undefined ? r.photoId : req.valid.body.photoId || undefined });
  await r.save();
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(recipeDto(r, map));
}));
recipes.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const r = await Recipe.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!r) throw notFound();
  if (String(r.createdBy) !== req.ctx.me && !isAdmin(req)) throw forbidden('Only the author or an admin can delete this recipe');
  await r.deleteOne();
  await MealPlan.updateMany({ familyId: req.ctx.familyId, recipeId: r._id }, { $set: { recipeId: null } });
  res.status(204).end();
}));
recipes.post('/:id/add-to-grocery', validate({ params: idParams }), h(async (req, res) => {
  const r = await Recipe.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!r) throw notFound();
  let added = 0;
  for (const ing of r.ingredients) { const { created } = await addNeeded(req.ctx.familyId, ing.name, req.ctx.me, ing.qty); if (created) added++; }
  res.json({ added, total: r.ingredients.length });
}));
export { addDays };
