import { Router } from 'express';
import { z } from 'zod';
import { badRequest, h, notFound } from '../lib/errors.js';
import { validate, idParams, oid, text, optText, money, ymd } from '../lib/validate.js';
import { GroceryItem, Expense } from '../models/index.js';
import { expenseDto, groceryDto } from '../dto.js';
import { loadMembers } from '../services/members.js';
import { createExpense, equalSplit } from '../services/expenses.js';
import { systemMessage } from '../services/chat.js';
import { todayIn } from '../lib/dates.js';
import { attachImageToItem, backfillMissingGroceryImages } from '../services/groceryImage.js';

export const grocery = Router();

/**
 * One purchase = one expense. A repeated price (double tap, or a correction) updates the expense made in the
 * last 24 hours for this item instead of adding a duplicate that could never be deleted.
 */
async function recordGroceryExpense(req, g, price, date) {
  const { ids } = await loadMembers(req.ctx.familyId);
  const split = equalSplit(price, ids);
  const recent = await Expense.findOne({
    familyId: req.ctx.familyId, source: 'grocery', sourceId: g._id, createdAt: { $gt: new Date(Date.now() - 864e5) },
  }).sort({ _id: -1 });
  if (recent) {
    recent.amount = price; recent.split = split; recent.paidById = req.ctx.me; recent.note = g.name;
    if (date) recent.date = date;
    recent.markModified('split');
    await recent.save();
    return { expense: recent, created: false };
  }
  const expense = await createExpense({
    familyId: req.ctx.familyId, amount: price, category: 'grocery', date: date || todayIn(req.ctx.family.timezone),
    paidById: req.ctx.me, split, note: g.name, source: 'grocery', sourceId: g._id, createdBy: req.ctx.me,
  });
  return { expense, created: true };
}
const keyOf = (n) => n.trim().toLowerCase().replace(/\s+/g, ' ');

export async function addNeeded(familyId, name, addedBy, qty, category, shop, { awaitMs = 0 } = {}) {
  const nameKey = keyOf(name);
  const existing = await GroceryItem.findOne({ familyId, nameKey });
  if (existing) {
    existing.status = 'needed';
    existing.unbilled = false;
    if (qty) existing.qty = String(qty).slice(0, 60);
    if (category) existing.category = String(category).slice(0, 50);
    if (shop) existing.shop = String(shop).slice(0, 60);
    await existing.save();
    if (existing.imageUrl == null) await attachImageToItem(existing, { awaitMs });
    return { item: existing, created: false };
  }
  const item = await GroceryItem.create({
    familyId,
    name: name.trim().slice(0, 140),
    nameKey,
    qty: (qty || '').slice(0, 60),
    category: (category || 'other').slice(0, 50),
    shop: (shop || 'Supermarket').slice(0, 60),
    status: 'needed',
    addedBy,
  });
  await attachImageToItem(item, { awaitMs });
  return { item, created: true };
}

grocery.get('/', h(async (req, res) => {
  const list = await GroceryItem.find({ familyId: req.ctx.familyId }).limit(500);
  await backfillMissingGroceryImages(list);
  const { map } = await loadMembers(req.ctx.familyId);
  const items = list.map((g) => groceryDto(g, map));
  items.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'needed' ? -1 : 1));
  res.json(items);
}));

grocery.post('/', validate({ body: z.object({ name: text(80), qty: optText(30) }).strict() }), h(async (req, res) => {
  const { item, created } = await addNeeded(req.ctx.familyId, req.valid.body.name, req.ctx.me, req.valid.body.qty, undefined, undefined, { awaitMs: 1600 });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(created ? 201 : 200).json(groceryDto(item, map));
}));

grocery.patch('/:id', validate({ params: idParams, body: z.object({ name: text(80).optional(), qty: optText(30) }).strict() }), h(async (req, res) => {
  const g = await GroceryItem.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!g) throw notFound();
  const prevKey = g.nameKey;
  if (req.valid.body.name) { g.name = req.valid.body.name; g.nameKey = keyOf(req.valid.body.name); }
  if (req.valid.body.qty !== undefined) g.qty = req.valid.body.qty;
  const renamed = Boolean(req.valid.body.name && g.nameKey !== prevKey);
  if (renamed) g.imageUrl = null;
  await g.save();
  if (renamed) await attachImageToItem(g, { awaitMs: 1400 });
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(groceryDto(g, map));
}));

const billSchema = z.object({
  itemIds: z.array(oid).min(1).max(100),
  amount: money.optional(),
  skip: z.boolean().optional(),
  date: ymd.optional(),
  note: optText(200),
}).strict().refine((d) => d.skip || typeof d.amount === 'number', { message: 'Enter an amount' });

grocery.post('/bill', validate({ body: billSchema }), h(async (req, res) => {
  const { itemIds, amount, skip, date, note } = req.valid.body;
  const items = await GroceryItem.find({ _id: { $in: itemIds }, familyId: req.ctx.familyId });
  if (!items.length) throw badRequest('Select at least one grocery item');
  const idsToClear = items.map((g) => g._id);

  if (skip) {
    await GroceryItem.updateMany({ _id: { $in: idsToClear }, familyId: req.ctx.familyId }, { $set: { unbilled: false } });
    return res.json({ ok: true, skipped: items.length });
  }

  const each = Math.round(amount / items.length);
  await GroceryItem.updateMany(
    { _id: { $in: idsToClear }, familyId: req.ctx.familyId },
    each > 0 ? { $set: { unbilled: false, lastPrice: each } } : { $set: { unbilled: false } },
  );

  const { ids, map } = await loadMembers(req.ctx.familyId);
  const split = equalSplit(amount, ids);
  const defaultNote = `Grocery: ${items.map((g) => g.name).join(', ')}`.slice(0, 200);
  const exp = await createExpense({
    familyId: req.ctx.familyId,
    amount,
    category: 'grocery',
    date: date || todayIn(req.ctx.family.timezone),
    paidById: req.ctx.me,
    split,
    note: note || defaultNote,
    source: 'grocery',
    createdBy: req.ctx.me,
  });

  await systemMessage(
    req.ctx.familyId,
    `Grocery bill added: ₹${Math.round(amount / 100)} (${items.length} ${items.length === 1 ? 'item' : 'items'}) by ${req.ctx.membership.displayName}`,
    { kind: 'grocery', id: items[0]._id, title: exp.note },
  );
  res.status(201).json({ expense: expenseDto(exp, map), billedCount: items.length });
}));

grocery.post('/:id/bought', validate({ params: idParams, body: z.object({ price: money.optional(), date: ymd.optional() }).strict().optional().default({}) }), h(async (req, res) => {
  const g = await GroceryItem.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!g) throw notFound();
  const now = new Date();
  g.status = 'stocked';
  g.lastBoughtBy = req.ctx.me;
  g.lastBoughtAt = now;
  g.buyDates = [...(g.buyDates || []), now].slice(-8);
  if (req.valid.body?.price) {
    g.lastPrice = req.valid.body.price;
    g.unbilled = false;
  } else {
    g.unbilled = true;
  }
  await g.save();
  if (req.valid.body?.price) await recordGroceryExpense(req, g, req.valid.body.price, req.valid.body.date);
  await systemMessage(
    req.ctx.familyId,
    `${g.name} bought by ${req.ctx.membership.displayName}${req.valid.body?.price ? ` (₹${Math.round(req.valid.body.price / 100)})` : ''}`,
    { kind: 'grocery', id: g._id, title: g.name }
  );
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(groceryDto(g, map));
}));

grocery.post('/:id/price', validate({ params: idParams, body: z.object({ price: money, date: ymd.optional() }).strict() }), h(async (req, res) => {
  const g = await GroceryItem.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!g) throw notFound();
  g.lastPrice = req.valid.body.price;
  g.unbilled = false;
  await g.save();
  const { created } = await recordGroceryExpense(req, g, req.valid.body.price, req.valid.body.date);
  if (created) {
    await systemMessage(
      req.ctx.familyId,
      `Added expense for ${g.name}: ₹${Math.round(req.valid.body.price / 100)} by ${req.ctx.membership.displayName}`,
      { kind: 'grocery', id: g._id, title: g.name }
    );
  }
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(200).json(groceryDto(g, map));
}));

grocery.post('/:id/need', validate({ params: idParams }), h(async (req, res) => {
  const g = await GroceryItem.findOneAndUpdate(
    { _id: req.valid.params.id, familyId: req.ctx.familyId },
    { $set: { status: 'needed', unbilled: false } },
    { new: true },
  );
  if (!g) throw notFound();
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(groceryDto(g, map));
}));

grocery.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const r = await GroceryItem.deleteOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!r.deletedCount) throw notFound();
  res.status(204).end();
}));
