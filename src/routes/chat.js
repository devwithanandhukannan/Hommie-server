import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate, idParams, oid, optText } from '../lib/validate.js';
import { ChatMessage, Membership, Attachment, Family, Task, BillInstance, Bill, Recipe, GroceryItem } from '../models/index.js';
import { chatDto } from '../dto.js';
import { loadMembers } from '../services/members.js';
import { notify, userIdsOf } from '../services/push.js';
import { chatLimiter } from '../middleware/security.js';
import { isAdmin } from '../middleware/auth.js';

export const chat = Router();

/** Resolves the thing a chat card points at, inside this family only, and snapshots its title. */
async function resolveRef(familyId, ref) {
  if (ref.kind === 'task') {
    const t = await Task.findOne({ _id: ref.id, familyId }).select('title');
    return t && { kind: 'task', id: t._id, title: t.title };
  }
  if (ref.kind === 'recipe') {
    const r = await Recipe.findOne({ _id: ref.id, familyId }).select('title');
    return r && { kind: 'recipe', id: r._id, title: r.title };
  }
  if (ref.kind === 'grocery') {
    const g = await GroceryItem.findOne({ _id: ref.id, familyId }).select('name');
    return g && { kind: 'grocery', id: g._id, title: g.name };
  }
  const i = await BillInstance.findOne({ _id: ref.id, familyId });
  const b = i && (await Bill.findById(i.billId).select('title'));
  return i && { kind: 'bill_instance', id: i._id, title: `${b?.title || 'Bill'} · due ${i.dueDate}` };
}

chat.get('/messages', validate({
  query: z.object({ before: oid.optional(), after: oid.optional(), limit: z.coerce.number().int().min(1).max(60).default(30) }).strict(),
}), h(async (req, res) => {
  const { before, after, limit } = req.valid.query;
  const f = { familyId: req.ctx.familyId };
  let list;
  if (after) list = await ChatMessage.find({ ...f, _id: { $gt: after } }).sort({ _id: 1 }).limit(limit);
  else {
    if (before) f._id = { $lt: before };
    list = (await ChatMessage.find(f).sort({ _id: -1 }).limit(limit)).reverse();
  }
  const { docs, map } = await loadMembers(req.ctx.familyId);
  const readers = docs.map((m) => ({ id: String(m._id), at: m.lastChatReadAt?.getTime() || 0 }));

  const taskIds = list.filter((m) => m.ref?.kind === 'task' && m.ref?.id).map((m) => m.ref.id);
  const groceryIds = list.filter((m) => m.ref?.kind === 'grocery' && m.ref?.id).map((m) => m.ref.id);
  const billIds = list.filter((m) => (m.ref?.kind === 'bill_instance' || m.ref?.kind === 'bill') && m.ref?.id).map((m) => m.ref.id);

  const [tasks, groceries, bills] = await Promise.all([
    taskIds.length ? Task.find({ _id: { $in: taskIds } }).select('status') : [],
    groceryIds.length ? GroceryItem.find({ _id: { $in: groceryIds } }).select('status') : [],
    billIds.length ? BillInstance.find({ _id: { $in: billIds } }).select('status') : [],
  ]);

  const statusMap = new Map();
  tasks.forEach((t) => statusMap.set(String(t._id), t.status));
  groceries.forEach((g) => statusMap.set(String(g._id), g.status === 'stocked' ? 'done' : 'open'));
  bills.forEach((b) => statusMap.set(String(b._id), b.status === 'paid' ? 'done' : 'open'));

  const items = list.map((m) => {
    const liveStatus = m.ref?.id ? statusMap.get(String(m.ref.id)) : null;
    return chatDto(m, map, readers.filter((r) => r.id !== String(m.senderId) && r.at >= m.createdAt.getTime()).length, liveStatus);
  });
  const unread = await ChatMessage.countDocuments({ familyId: req.ctx.familyId, createdAt: { $gt: req.ctx.membership.lastChatReadAt }, senderId: { $ne: req.ctx.me } });
  res.json({ items, unread, hasMore: !after && list.length === limit });
}));

chat.post('/messages', chatLimiter, validate({
  body: z.object({
    text: optText(2000),
    attachmentId: oid.optional(),
    audioDuration: z.number().min(1).max(60).optional(),
    // Only the id is trusted: the quoted sender and text are always read from the original message.
    replyTo: z.object({ id: oid, senderName: optText(80), text: optText(400) }).strict().optional(),
    ref: z.object({ kind: z.enum(['task', 'bill_instance', 'recipe', 'grocery']), id: oid }).strict().optional(),
  }).strict().refine((b) => (b.text && b.text.length) || b.attachmentId || b.ref, { message: 'Write a message or attach something' }),
}), h(async (req, res) => {
  const b = req.valid.body;
  let attachmentId;
  let isAudio = false;
  if (b.attachmentId) {
    const a = await Attachment.findOne({ _id: b.attachmentId, familyId: req.ctx.familyId, uploaderId: req.ctx.me }).select('mime');
    if (!a) throw badRequest('Attachment not found');
    attachmentId = a._id;
    if (a.mime?.startsWith('audio/')) isAudio = true;
  }
  const ref = b.ref ? await resolveRef(req.ctx.familyId, b.ref) : undefined;
  if (b.ref && !ref) throw badRequest('That item was not found');
  const type = ref ? 'card' : isAudio ? 'audio' : attachmentId ? 'image' : 'text';
  let replyTo;
  if (b.replyTo) {
    const orig = await ChatMessage.findOne({ _id: b.replyTo.id, familyId: req.ctx.familyId });
    if (!orig) throw badRequest('The message you replied to no longer exists');
    const { map: names } = await loadMembers(req.ctx.familyId);
    const who = orig.senderId ? (names.get(String(orig.senderId))?.displayName || 'Former member') : 'Hommi';
    replyTo = { id: orig._id, senderName: who, text: (orig.text || (orig.type === 'audio' ? 'Voice message' : orig.type === 'image' ? 'Photo' : '')).slice(0, 200) };
  }
  const msg = await ChatMessage.create({
    familyId: req.ctx.familyId,
    senderId: req.ctx.me,
    text: b.text,
    attachmentId,
    audioDuration: b.audioDuration,
    replyTo,
    ref,
    type,
  });
  await Membership.updateOne({ _id: req.ctx.me }, { $set: { lastChatReadAt: new Date() } });
  const others = await Membership.find({ familyId: req.ctx.familyId, status: 'active', _id: { $ne: req.ctx.me }, userId: { $ne: null } });
  const notifBody = type === 'audio'
    ? `${req.ctx.membership.displayName} sent a voice message`
    : b.text
    ? `${req.ctx.membership.displayName}: ${b.text.slice(0, 100)}`
    : `${req.ctx.membership.displayName} sent an attachment`;
  await notify({
    userIds: userIdsOf(others), familyId: req.ctx.familyId, type: 'chat', url: '/chat', coalesce: true,
    title: `${req.ctx.family.name}: new messages`, body: notifBody, dedupeKey: undefined,
  });
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(chatDto(msg, map, 0));
}));

chat.post('/read', h(async (req, res) => {
  await Membership.updateOne({ _id: req.ctx.me }, { $set: { lastChatReadAt: new Date() } });
  res.status(204).end();
}));

chat.delete('/messages/:id', validate({ params: idParams }), h(async (req, res) => {
  const m = await ChatMessage.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!m) throw notFound();
  if (m.type === 'system') throw forbidden('Automatic messages cannot be deleted');
  if (String(m.senderId) !== req.ctx.me && !isAdmin(req)) throw forbidden('You can only delete your own messages');
  await m.deleteOne();
  if (m.attachmentId) {
    // Free the encrypted file and give its bytes back to the family quota (they were leaking before).
    const gone = await Attachment.findOneAndDelete({ _id: m.attachmentId, familyId: req.ctx.familyId }).select('size');
    if (gone) await Family.updateOne({ _id: req.ctx.familyId }, { $inc: { storageBytes: -gone.size } });
  }
  res.status(204).end();
}));
