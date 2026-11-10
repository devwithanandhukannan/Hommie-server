import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { validate, idParams, oid, ymd, text, optText } from '../lib/validate.js';
import { Task, Membership } from '../models/index.js';
import { taskDto } from '../dto.js';
import { loadMembers } from '../services/members.js';
import { notify, otherFamilyUserIds } from '../services/push.js';
import { systemMessage } from '../services/chat.js';
import { isAdmin } from '../middleware/auth.js';
import { addDays, addMonths, todayIn } from '../lib/dates.js';

export const tasks = Router();

const repeat = z.object({ unit: z.enum(['none', 'day', 'week', 'month']), everyN: z.number().int().min(1).max(12).default(1) }).strict();

async function activeMember(familyId, id) {
  const m = await Membership.findOne({ _id: id, familyId, status: 'active' });
  if (!m) throw badRequest('That member is not in this family');
  return m;
}
async function loadTask(req) {
  const t = await Task.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (!t) throw notFound('Task not found');
  return t;
}
async function tell(req, task, assigneeId) {
  if (assigneeId) {
    if (String(assigneeId) === req.ctx.me) return;
    const m = await Membership.findById(assigneeId);
    if (m?.userId) {
      await notify({
        userIds: [m.userId],
        familyId: req.ctx.familyId,
        type: 'task',
        url: '/tasks',
        i18nKey: 'task_assigned',
        params: { by: req.ctx.membership.displayName, title: task.title },
      });
    }
    return;
  }
  const userIds = await otherFamilyUserIds(req.ctx.familyId, req.ctx.me);
  if (userIds.length) {
    await notify({
      userIds,
      familyId: req.ctx.familyId,
      type: 'task',
      url: '/tasks',
      i18nKey: 'task_open',
      params: { by: req.ctx.membership.displayName, title: task.title },
    });
  }
}

tasks.get('/', validate({ query: z.object({ scope: z.enum(['mine', 'open', 'done', 'all']).default('open') }).strict() }), h(async (req, res) => {
  const f = { familyId: req.ctx.familyId };
  const { scope } = req.valid.query;
  if (scope === 'mine') Object.assign(f, { status: 'open', assigneeId: req.ctx.me });
  else if (scope === 'open') f.status = 'open';
  else if (scope === 'done') f.status = 'done';
  const list = await Task.find(f).sort(scope === 'done' ? { completedAt: -1 } : { dueDate: 1, _id: -1 }).limit(200);
  const { map } = await loadMembers(req.ctx.familyId);
  // Undated tasks sort last for open lists.
  const items = list.map((t) => taskDto(t, map));
  if (scope !== 'done') items.sort((a, b) => (a.dueDate || '9999') .localeCompare(b.dueDate || '9999'));
  res.json(items);
}));

tasks.post('/', validate({
  body: z.object({
    title: text(140), description: optText(1000), dueDate: ymd.optional(), assigneeId: oid.nullable().optional(),
    repeat: repeat.optional(), rotationOrder: z.array(oid).min(2).max(12).optional(), kind: z.enum(['chore', 'custom']).default('custom'),
  }).strict(),
}), h(async (req, res) => {
  const b = req.valid.body;
  const doc = { familyId: req.ctx.familyId, title: b.title, description: b.description, kind: b.kind, dueDate: b.dueDate, createdBy: req.ctx.me, assigneeId: b.assigneeId ?? null };
  if (b.assigneeId) await activeMember(req.ctx.familyId, b.assigneeId);
  if (b.rotationOrder) {
    if (new Set(b.rotationOrder).size !== b.rotationOrder.length) throw badRequest('Rotation lists a member twice');
    const found = await Membership.countDocuments({ _id: { $in: b.rotationOrder }, familyId: req.ctx.familyId, status: 'active' });
    if (found !== b.rotationOrder.length) throw badRequest('Rotation includes someone who is not in this family');
    doc.rotation = { order: b.rotationOrder, index: 0 };
    doc.assigneeId = b.rotationOrder[0];
    doc.repeat = b.repeat?.unit && b.repeat.unit !== 'none' ? b.repeat : { unit: 'week', everyN: 1 };
    doc.kind = 'chore';
  } else if (b.repeat) doc.repeat = b.repeat;
  const t = await Task.create(doc);
  await tell(req, t, t.assigneeId);
  const { map } = await loadMembers(req.ctx.familyId);
  res.status(201).json(taskDto(t, map));
}));

tasks.patch('/:id', validate({
  params: idParams,
  body: z.object({
    title: text(140).optional(),
    description: optText(1000),
    dueDate: ymd.nullable().optional(),
    repeat: repeat.optional(),
    assigneeId: oid.nullable().optional(),
    kind: z.enum(['chore', 'custom', 'grocery']).optional(),
    status: z.enum(['open', 'done']).optional(),
  }).strict(),
}), h(async (req, res) => {
  const t = await loadTask(req);
  if (t.kind === 'bill') throw badRequest('Bill tasks are managed from the bill');
  if (String(t.createdBy) !== req.ctx.me && !isAdmin(req)) throw forbidden('Only the creator or an admin can edit this task');
  const { dueDate, assigneeId, status, ...rest } = req.valid.body;
  const prevAssignee = t.assigneeId ? String(t.assigneeId) : null;
  Object.assign(t, rest);
  if (dueDate !== undefined) t.dueDate = dueDate || undefined;
  if (assigneeId !== undefined) {
    if (assigneeId) await activeMember(req.ctx.familyId, assigneeId);
    t.assigneeId = assigneeId || null;
  }
  if (status !== undefined) {
    t.status = status;
    if (status === 'open') {
      t.completedBy = null;
      t.completedAt = null;
    } else if (status === 'done') {
      t.completedBy = req.ctx.me;
      t.completedAt = new Date();
    }
  }
  await t.save();
  if (t.status === 'open' && assigneeId !== undefined && (t.assigneeId ? String(t.assigneeId) : null) !== prevAssignee) {
    await tell(req, t, t.assigneeId);
  }
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(taskDto(t, map));
}));

tasks.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const t = await loadTask(req);
  if (t.kind === 'bill') throw badRequest('Bill tasks are removed with the bill');
  if (String(t.createdBy) !== req.ctx.me && !isAdmin(req)) throw forbidden('Only the creator or an admin can delete this task');
  await t.deleteOne();
  res.status(204).end();
}));

// "I'll do it": atomically takes an unassigned task so two people cannot both claim it.
tasks.post('/:id/claim', validate({ params: idParams }), h(async (req, res) => {
  const t = await Task.findOneAndUpdate(
    { _id: req.valid.params.id, familyId: req.ctx.familyId, status: 'open', assigneeId: null },
    { $set: { assigneeId: req.ctx.me } }, { new: true });
  if (!t) {
    const exists = await Task.exists({ _id: req.valid.params.id, familyId: req.ctx.familyId });
    throw exists ? conflict('Someone already took this task') : notFound('Task not found');
  }
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(taskDto(t, map));
}));

tasks.post('/:id/assign', validate({ params: idParams, body: z.object({ membershipId: oid.nullable() }).strict() }), h(async (req, res) => {
  const t = await loadTask(req);
  if (t.status !== 'open') throw conflict('This task is already done');
  if (req.valid.body.membershipId) await activeMember(req.ctx.familyId, req.valid.body.membershipId);
  t.assigneeId = req.valid.body.membershipId;
  await t.save();
  await tell(req, t, t.assigneeId);
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(taskDto(t, map));
}));

tasks.post('/:id/complete', validate({ params: idParams, body: z.object({ note: optText(200) }).strict().optional().default({}) }), h(async (req, res) => {
  const t = await loadTask(req);
  if (t.kind === 'bill') throw badRequest('Record the payment on the bill to complete this task');
  if (t.assigneeId && String(t.assigneeId) !== req.ctx.me && !isAdmin(req)) throw forbidden('This task is assigned to someone else');
  const done = await Task.findOneAndUpdate(
    { _id: t._id, status: 'open' },
    { $set: { status: 'done', completedBy: req.ctx.me, completedAt: new Date(), ...(t.assigneeId ? {} : { assigneeId: req.ctx.me }) } }, { new: true });
  if (!done) throw conflict('This task is already done');
  if (t.repeat?.unit && t.repeat.unit !== 'none') {
    const today = todayIn(req.ctx.family.timezone);
    const step = (d) => (t.repeat.unit === 'month' ? addMonths(d, t.repeat.everyN) : addDays(d, t.repeat.everyN * (t.repeat.unit === 'week' ? 7 : 1)));
    let due = step(t.dueDate || today);
    for (let i = 0; i < 200 && due < today; i++) due = step(due);
    const order = t.rotation?.order || [];
    const index = order.length ? (t.rotation.index + 1) % order.length : 0;
    let assignee = t.assigneeId;
    if (order.length) {
      // Skip anyone who has left the family.
      const active = new Set((await Membership.find({ _id: { $in: order }, status: 'active' })).map((m) => String(m._id)));
      let k = index;
      for (let n = 0; n < order.length && !active.has(String(order[k])); n++) k = (k + 1) % order.length;
      assignee = active.size ? order[k] : null;
      await Task.create({ familyId: t.familyId, title: t.title, description: t.description, kind: t.kind, assigneeId: assignee, createdBy: t.createdBy, dueDate: due, repeat: t.repeat, rotation: { order, index: k } });
    } else {
      await Task.create({ familyId: t.familyId, title: t.title, description: t.description, kind: t.kind, assigneeId: assignee, createdBy: t.createdBy, dueDate: due, repeat: t.repeat });
    }
  }
  await systemMessage(req.ctx.familyId, `${req.ctx.membership.displayName} completed: ${t.title}`, { kind: 'task', id: t._id, title: t.title });
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(taskDto(done, map));
}));
