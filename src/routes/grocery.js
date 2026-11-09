import { Router } from 'express';
import { z } from 'zod';
import { h, notFound } from '../lib/errors.js';
import { validate, idParams, text, optText, money, ymd, oid } from '../lib/validate.js';
import { GroceryItem } from '../models/index.js';
import { groceryDto } from '../dto.js';
import { loadMembers } from '../services/members.js';
import { createExpense, equalSplit } from '../services/expenses.js';
import { systemMessage } from '../services/chat.js';
import { todayIn } from '../lib/dates.js';

export const grocery = Router();
const keyOf = (n) => n.trim().toLowerCase().replace(/\s+/g, ' ');

export async function addNeeded(familyId, name, addedBy, qty, category, shop) {
  const nameKey = keyOf(name);
  const existing = await GroceryItem.findOne({ familyId, nameKey });
  if (existing) {
    existing.status = 'needed';
    if (qty) existing.qty = String(qty).slice(0, 60);
    if (category) existing.category = String(category).slice(0, 50);
    if (shop) existing.shop = String(shop).slice(0, 60);
    await existing.save();
    return { item: existing, created: false };
  }
  return {
    item: await GroceryItem.create({
      familyId,
      name: name.trim().slice(0, 140),
      nameKey,
      qty: (qty || '').slice(0, 60),
      category: (category || 'other').slice(0, 50),
      shop: (shop || 'Supermarket').slice(0, 60),
      status: 'needed',
      addedBy,
    }),
    created: true,
  };
}

grocery.get('/', h(async (req, res) => {
  const list = await GroceryItem.find({ familyId: req.ctx.familyId }).limit(500);
  const { map } = await loadMembers(req.ctx.familyId);
  const items = list.map((g) => groceryDto(g, map));
  items.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'needed' ? -1 : 1));
  res.json(items);
}));

grocery.post('/', validate({ body: z.object({ name: text(80), qty: optText(30) }).strict() }), h(async (req, res) => {
  const { item, created } = await addNeeded(req.ctx.familyId, req.valid.body.name, req.ctx.me, req.valid.body.qty);
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(created ? 201 : 200).json(groceryDto(item, map));
}));

grocery.patch('/:id', validate({ params: idParams, body: z.object({ name: text(80).optional(), qty: optText(30) }).strict() }), h(async (req, res) => {
  const g = await GroceryItem.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!g) throw notFound();
  if (req.valid.body.name) { g.name = req.valid.body.name; g.nameKey = keyOf(req.valid.body.name); }
  if (req.valid.body.qty !== undefined) g.qty = req.valid.body.qty;
  await g.save();
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(groceryDto(g, map));
}));

grocery.post('/bill', validate({
  body: z.object({
    amount: money,
    itemIds: z.array(oid).min(1).max(100),
    date: ymd.optional(),
    note: optText(200).optional(),
    paidById: oid.optional(),
    equalAmong: z.array(oid).optional(),
  }).strict(),
}), h(async (req, res) => {
  const { amount, itemIds, date, note, paidById, equalAmong } = req.valid.body;
  const items = await GroceryItem.find({ _id: { $in: itemIds }, familyId: req.ctx.familyId });
  const eachPrice = Math.round(amount / (items.length || 1));
  for (const g of items) {
    g.lastPrice = eachPrice;
    await g.save();
  }
  const { ids } = await loadMembers(req.ctx.familyId);
  const payer = paidById || req.ctx.me;
  const billNote = note || `Grocery: ${items.map((i) => i.name).join(', ')}`.slice(0, 200);
  const exp = await createExpense({
    familyId: req.ctx.familyId,
    amount,
    category: 'grocery',
    date: date || todayIn(req.ctx.family.timezone),
    paidById: payer,
    split: equalSplit(amount, equalAmong || ids),
    note: billNote,
    source: 'grocery',
    createdBy: req.ctx.me,
  });
  await systemMessage(
    req.ctx.familyId,
    `Grocery bill recorded: ₹${Math.round(amount / 100)} for ${items.length} item${items.length === 1 ? '' : 's'} by ${req.ctx.membership.displayName}`,
    { kind: 'grocery', title: 'Grocery bill' }
  );
  res.status(201).json({ success: true, expenseId: exp._id });
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
  }
  await g.save();
  if (req.valid.body?.price) {
    const { ids } = await loadMembers(req.ctx.familyId);
    await createExpense({
      familyId: req.ctx.familyId, amount: req.valid.body.price, category: 'grocery', date: req.valid.body.date || todayIn(req.ctx.family.timezone),
      paidById: req.ctx.me, split: equalSplit(req.valid.body.price, ids), note: g.name, source: 'grocery', sourceId: g._id, createdBy: req.ctx.me,
    });
  }
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
  await g.save();
  const { ids } = await loadMembers(req.ctx.familyId);
  await createExpense({
    familyId: req.ctx.familyId,
    amount: req.valid.body.price,
    category: 'grocery',
    date: req.valid.body.date || todayIn(req.ctx.family.timezone),
    paidById: req.ctx.me,
    split: equalSplit(req.valid.body.price, ids),
    note: g.name,
    source: 'grocery',
    sourceId: g._id,
    createdBy: req.ctx.me,
  });
  await systemMessage(
    req.ctx.familyId,
    `Added expense for ${g.name}: ₹${Math.round(req.valid.body.price / 100)} by ${req.ctx.membership.displayName}`,
    { kind: 'grocery', id: g._id, title: g.name }
  );
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(200).json(groceryDto(g, map));
}));

grocery.post('/:id/need', validate({ params: idParams }), h(async (req, res) => {
  const g = await GroceryItem.findOneAndUpdate({ _id: req.valid.params.id, familyId: req.ctx.familyId }, { $set: { status: 'needed' } }, { new: true });
  if (!g) throw notFound();
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(groceryDto(g, map));
}));

grocery.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const r = await GroceryItem.deleteOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!r.deletedCount) throw notFound();
  res.status(204).end();
}));
