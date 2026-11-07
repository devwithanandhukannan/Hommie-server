import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { validate, idParams, oid, text } from '../lib/validate.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { Family, Membership, Invite, User, Task, Bill, AuditLog, ChatMessage } from '../models/index.js';
import { familyDto, auditDto } from '../dto.js';
import { loadMembers, memberDto, COLORS } from '../services/members.js';
import { audit } from '../services/audit.js';
import { systemMessage } from '../services/chat.js';
import { authenticate, familyContext, requireAdmin, requireOwner, isAdmin } from '../middleware/auth.js';
import { inviteLimiter } from '../middleware/security.js';
import { deleteFamilyData } from './auth.js';

const TYPES = ['home', 'rent', 'other'];
const RELATIONS = ['self', 'father', 'mother', 'brother', 'sister', 'spouse', 'partner', 'child', 'grandparent', 'friend', 'other'];
const tz = z.string().max(60).refine((t) => { try { new Intl.DateTimeFormat('en', { timeZone: t }); return true; } catch { return false; } }, 'Unknown timezone');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newInviteCode() {
  let out = '';
  while (out.length < 16) out += CODE_ALPHABET[Number(BigInt('0x' + sha256(randomToken(16)).slice(0, 8)) % BigInt(CODE_ALPHABET.length))];
  return out.match(/.{4}/g).join('-');
}
const normCode = (c) => c.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export const families = Router();
families.use(authenticate);

families.post('/', validate({ body: z.object({ name: text(60), type: z.enum(TYPES).default('home'), timezone: tz.optional() }).strict() }), h(async (req, res) => {
  const count = await Membership.countDocuments({ userId: req.ctx.user._id, status: 'active' });
  if (count >= 10) throw badRequest('You can be part of at most 10 families');
  const fam = await Family.create({ ...req.valid.body, ownerUserId: req.ctx.user._id });
  const m = await Membership.create({
    familyId: fam._id, userId: req.ctx.user._id, linkKey: `${fam._id}:${req.ctx.user._id}`, displayName: req.ctx.user.name,
    relation: 'self', role: 'owner', color: COLORS[0],
  });
  const { map } = await loadMembers(fam._id);
  res.status(201).json(familyDto(fam, [...map.values()], m));
}));

families.post('/accept-invite', inviteLimiter, validate({ body: z.object({ code: z.string().trim().min(8).max(40) }).strict() }), h(async (req, res) => {
  const codeHash = sha256(normCode(req.valid.body.code));
  const inv = await Invite.findOne({ codeHash });
  if (!inv || inv.revokedAt || inv.expiresAt < new Date() || inv.usedCount >= inv.maxUses) throw badRequest('This invite is invalid or has expired');
  if (await Membership.exists({ familyId: inv.familyId, userId: req.ctx.user._id, status: 'active' })) throw conflict('You are already in this family');
  if ((await Membership.countDocuments({ userId: req.ctx.user._id, status: 'active' })) >= 10) throw badRequest('You can be part of at most 10 families');
  const claimed = await Invite.findOneAndUpdate({ _id: inv._id, usedCount: { $lt: inv.maxUses }, revokedAt: null }, { $inc: { usedCount: 1 } }, { new: true });
  if (!claimed) throw badRequest('This invite is invalid or has expired');
  const linkKey = `${inv.familyId}:${req.ctx.user._id}`;
  let m = null;
  if (inv.linkToMembershipId) {
    m = await Membership.findOneAndUpdate(
      { _id: inv.linkToMembershipId, familyId: inv.familyId, status: 'active', userId: null },
      { $set: { userId: req.ctx.user._id, linkKey } }, { new: true });
  }
  if (!m) {
    const n = await Membership.countDocuments({ familyId: inv.familyId });
    m = await Membership.create({ familyId: inv.familyId, userId: req.ctx.user._id, linkKey, displayName: req.ctx.user.name, relation: 'other', role: inv.role, color: COLORS[n % COLORS.length] });
  }
  const fam = await Family.findById(inv.familyId);
  await systemMessage(fam._id, `${m.displayName} joined the family`);
  const { map } = await loadMembers(fam._id);
  res.status(201).json(familyDto(fam, [...map.values()], m));
}));

// ---------- everything below is scoped to the family named in X-Family-Id ----------
const cur = Router();
families.use('/current', familyContext, cur);

cur.get('/', h(async (req, res) => {
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(familyDto(req.ctx.family, [...map.values()], req.ctx.membership));
}));

cur.patch('/', requireAdmin, validate({ body: z.object({ name: text(60).optional(), type: z.enum(TYPES).optional(), timezone: tz.optional() }).strict() }), h(async (req, res) => {
  Object.assign(req.ctx.family, req.valid.body);
  await req.ctx.family.save();
  await audit(req, 'family.update', 'family', req.ctx.family._id, req.valid.body);
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(familyDto(req.ctx.family, [...map.values()], req.ctx.membership));
}));

cur.delete('/', requireOwner, validate({ body: z.object({ confirmName: z.string().max(60) }).strict() }), h(async (req, res) => {
  if (req.valid.body.confirmName !== req.ctx.family.name) throw badRequest('Type the family name exactly to confirm');
  await deleteFamilyData(req.ctx.familyId);
  res.status(204).end();
}));

cur.post('/mute-chat', validate({ body: z.object({ muted: z.boolean() }).strict() }), h(async (req, res) => {
  const op = req.valid.body.muted ? { $addToSet: { mutedFamilies: req.ctx.family._id } } : { $pull: { mutedFamilies: req.ctx.family._id } };
  await User.updateOne({ _id: req.ctx.user._id }, op);
  res.status(204).end();
}));

cur.post('/members', requireAdmin, validate({
  body: z.object({ displayName: text(60), relation: z.enum(RELATIONS).default('other'), role: z.enum(['admin', 'member']).default('member') }).strict(),
}), h(async (req, res) => {
  if (req.valid.body.role === 'admin' && req.ctx.membership.role !== 'owner') throw forbidden('Only the owner can add an admin');
  const n = await Membership.countDocuments({ familyId: req.ctx.familyId });
  if (n >= 30) throw badRequest('A family can have at most 30 members');
  const m = await Membership.create({ familyId: req.ctx.familyId, ...req.valid.body, color: COLORS[n % COLORS.length] });
  await audit(req, 'member.add', 'membership', m._id, { displayName: m.displayName });
  res.status(201).json(memberDto(m));
}));

cur.patch('/members/:id', requireAdmin, validate({
  params: idParams,
  body: z.object({ displayName: text(60).optional(), relation: z.enum(RELATIONS).optional(), role: z.enum(['admin', 'member']).optional() }).strict(),
}), h(async (req, res) => {
  const m = await Membership.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId, status: 'active' });
  if (!m) throw notFound();
  const { role, ...rest } = req.valid.body;
  if (m.role === 'owner' && role) throw badRequest('Transfer ownership to change the owner role');
  if (role && req.ctx.membership.role !== 'owner') throw forbidden('Only the owner can change roles');
  if (m.role === 'admin' && req.ctx.membership.role !== 'owner' && String(m._id) !== req.ctx.me) throw forbidden('Only the owner can edit an admin');
  Object.assign(m, rest, role ? { role } : {});
  await m.save();
  await audit(req, 'member.update', 'membership', m._id, req.valid.body);
  res.json(memberDto(m));
}));

cur.delete('/members/:id', validate({ params: idParams }), h(async (req, res) => {
  const m = await Membership.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId, status: 'active' });
  if (!m) throw notFound();
  const self = String(m._id) === req.ctx.me;
  if (m.role === 'owner') throw badRequest('Transfer ownership before the owner leaves');
  if (!self) {
    if (!isAdmin(req)) throw forbidden();
    if (m.role === 'admin' && req.ctx.membership.role !== 'owner') throw forbidden('Only the owner can remove an admin');
  }
  await Membership.updateOne({ _id: m._id }, { $set: { status: 'left' }, $unset: { linkKey: 1 } });
  await Task.updateMany({ familyId: req.ctx.familyId, assigneeId: m._id, status: 'open' }, { $set: { assigneeId: null } });
  await Bill.updateMany({ familyId: req.ctx.familyId, payerId: m._id }, { $set: { payerId: self ? (await Membership.findOne({ familyId: req.ctx.familyId, role: 'owner' }))._id : req.ctx.membership._id } });
  await audit(req, self ? 'member.leave' : 'member.remove', 'membership', m._id, { displayName: m.displayName });
  res.status(204).end();
}));

cur.post('/transfer', requireOwner, validate({ body: z.object({ membershipId: oid }).strict() }), h(async (req, res) => {
  const target = await Membership.findOne({ _id: req.valid.body.membershipId, familyId: req.ctx.familyId, status: 'active', userId: { $ne: null } });
  if (!target || String(target._id) === req.ctx.me) throw badRequest('Choose another member who has an account');
  await Membership.updateOne({ _id: target._id }, { $set: { role: 'owner' } });
  await Membership.updateOne({ _id: req.ctx.me }, { $set: { role: 'admin' } });
  await Family.updateOne({ _id: req.ctx.familyId }, { $set: { ownerUserId: target.userId } });
  await audit(req, 'family.transfer', 'membership', target._id);
  res.status(204).end();
}));

cur.post('/invites', requireAdmin, validate({
  body: z.object({
    role: z.enum(['admin', 'member']).default('member'),
    expiresInHours: z.number().int().min(1).max(168).default(48),
    maxUses: z.number().int().min(1).max(20).default(1),
    linkToMembershipId: oid.optional(),
  }).strict(),
}), h(async (req, res) => {
  const b = req.valid.body;
  if (b.role === 'admin' && req.ctx.membership.role !== 'owner') throw forbidden('Only the owner can invite an admin');
  if (b.linkToMembershipId) {
    const t = await Membership.findOne({ _id: b.linkToMembershipId, familyId: req.ctx.familyId, status: 'active', userId: null });
    if (!t) throw badRequest('That member already has an account or does not exist');
  }
  const code = newInviteCode();
  const inv = await Invite.create({
    familyId: req.ctx.familyId, codeHash: sha256(normCode(code)), role: b.role, linkToMembershipId: b.linkToMembershipId,
    maxUses: b.maxUses, expiresAt: new Date(Date.now() + b.expiresInHours * 3600_000), createdBy: req.ctx.me,
  });
  await audit(req, 'invite.create', 'invite', inv._id, { role: b.role });
  res.status(201).json({ id: String(inv._id), code, expiresAt: inv.expiresAt, maxUses: inv.maxUses });
}));

cur.get('/invites', requireAdmin, h(async (req, res) => {
  const list = await Invite.find({ familyId: req.ctx.familyId, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ _id: -1 }).limit(20);
  res.json(list.filter((i) => i.usedCount < i.maxUses).map((i) => ({ id: String(i._id), role: i.role, expiresAt: i.expiresAt, usedCount: i.usedCount, maxUses: i.maxUses, linkToMembershipId: i.linkToMembershipId ? String(i.linkToMembershipId) : null })));
}));
cur.delete('/invites/:id', requireAdmin, validate({ params: idParams }), h(async (req, res) => {
  await Invite.updateOne({ _id: req.valid.params.id, familyId: req.ctx.familyId }, { $set: { revokedAt: new Date() } });
  res.status(204).end();
}));

// Admin issues a one-time password reset code for a member who has an account.
cur.post('/members/:id/reset-code', requireAdmin, validate({ params: idParams }), h(async (req, res) => {
  const m = await Membership.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId, status: 'active', userId: { $ne: null } });
  if (!m || String(m._id) === req.ctx.me) throw badRequest('Choose another member who has an account');
  if (m.role === 'owner' || (m.role === 'admin' && req.ctx.membership.role !== 'owner')) throw forbidden();
  const code = newInviteCode().slice(0, 14);
  await User.updateOne({ _id: m.userId }, { $set: { resetHash: sha256(normCode(code)), resetExpiresAt: new Date(Date.now() + 30 * 60_000) } });
  await audit(req, 'member.reset-code', 'membership', m._id);
  res.status(201).json({ code, expiresInMinutes: 30 });
}));

cur.get('/audit', requireAdmin, h(async (req, res) => {
  const { map } = await loadMembers(req.ctx.familyId);
  const list = await AuditLog.find({ familyId: req.ctx.familyId }).sort({ _id: -1 }).limit(100);
  res.json(list.map((a) => auditDto(a, map)));
}));
