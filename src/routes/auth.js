import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { h, HttpError, unauthorized, conflict, badRequest, notFound } from '../lib/errors.js';
import { validate, idParams, text } from '../lib/validate.js';
import crypto from 'node:crypto';
import { randomToken, sha256, safeEqual } from '../lib/crypto.js';
import { signAccess } from '../lib/tokens.js';
import { User, Session, Membership, Family, FAMILY_SCOPED, Notification, EmailOtp, allModels } from '../models/index.js';
import { userDto, notificationDto } from '../dto.js';
import { authenticate } from '../middleware/auth.js';
import { issueCsrf, cookieBase, authLimiter } from '../middleware/security.js';
import { sendOtpEmail, sendPasswordResetEmail } from '../services/mail.js';

const REFRESH_COOKIE = 'fh_refresh';
const refreshCookie = { ...cookieBase, httpOnly: true, path: '/api/auth', maxAge: config.refreshDays * 864e5 };

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, 'Use at least 10 characters').max(128);
const newOtp = () => String(crypto.randomInt(100000, 1000000));
const OTP_COOLDOWN_MS = 45_000;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptCost);

async function startSession(user, req, res) {
  const token = randomToken(48);
  const session = await Session.create({
    userId: user._id, refreshHash: sha256(token), device: (req.get('user-agent') || 'unknown').slice(0, 120),
    expiresAt: new Date(Date.now() + config.refreshDays * 864e5),
  });
  res.cookie(REFRESH_COOKIE, token, refreshCookie);
  return { accessToken: signAccess(user, session._id), user: userDto(user) };
}

export const publicAuth = Router();
publicAuth.get('/csrf', (req, res) => res.json({ csrfToken: issueCsrf(req, res) }));

// Step 1: Send registration OTP to email
publicAuth.post('/register/send-otp', authLimiter, validate({ body: z.object({ name: text(80), email, password }).strict() }), h(async (req, res) => {
  const { name, email: mail, password: pw } = req.valid.body;
  if (pw.toLowerCase() === mail) throw badRequest('Password must not be your email');
  if (await User.exists({ email: mail })) throw conflict('An account with this email already exists');

  const recent = await EmailOtp.findOne({ email: mail, type: 'register' }).select('createdAt');
  if (recent && Date.now() - recent.createdAt.getTime() < OTP_COOLDOWN_MS) {
    throw new HttpError(429, 'Please wait a moment before asking for another code.');
  }
  const otp = newOtp();
  const passwordHash = await bcrypt.hash(pw, config.bcryptCost);
  const otpHash = sha256(otp);

  await EmailOtp.deleteMany({ email: mail, type: 'register' });
  const otpRecord = await EmailOtp.create({
    email: mail,
    otpHash,
    type: 'register',
    payload: { name, passwordHash },
    expiresAt: new Date(Date.now() + 10 * 60_000), // 10 minutes
  });

  try {
    await sendOtpEmail(mail, otp, name);
  } catch (err) {
    await EmailOtp.deleteOne({ _id: otpRecord._id }).catch(() => {});
    console.error('[auth] Failed to send registration OTP email:', err);
    throw badRequest('Failed to send verification email. Please check your email address and try again.');
  }

  res.json({ status: 'otp_sent', email: mail, message: 'Verification code sent to your email' });
}));

// Step 2: Verify registration OTP and create account
publicAuth.post('/register/verify-otp', authLimiter, validate({ body: z.object({ email, otp: z.string().trim().min(4).max(10) }).strict() }), h(async (req, res) => {
  const { email: mail, otp } = req.valid.body;
  const record = await EmailOtp.findOne({ email: mail, type: 'register', expiresAt: { $gt: new Date() } });
  if (!record) throw badRequest('Verification code has expired or is invalid. Please request a new one.');

  const isMatch = safeEqual(record.otpHash, sha256(otp.trim()));
  if (!isMatch) {
    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts >= 5) {
      await EmailOtp.deleteOne({ _id: record._id });
      throw badRequest('Too many incorrect attempts. Please request a new verification code.');
    }
    await record.save();
    throw badRequest('Incorrect verification code. Please check your email and try again.');
  }

  if (await User.exists({ email: mail })) throw conflict('An account with this email already exists');

  const user = await User.create({
    name: record.payload.name,
    email: mail,
    passwordHash: record.payload.passwordHash,
  });

  await EmailOtp.deleteOne({ _id: record._id });
  res.status(201).json(await startSession(user, req, res));
}));

publicAuth.post('/login', authLimiter, validate({ body: z.object({ email, password: z.string().min(1).max(128) }).strict() }), h(async (req, res) => {
  const { email: mail, password: pw } = req.valid.body;
  const user = await User.findOne({ email: mail }).select('+passwordHash');
  const ok = await bcrypt.compare(pw, user?.passwordHash || DUMMY_HASH);
  if (user?.lockedUntil && user.lockedUntil > new Date()) throw unauthorized('Too many failed attempts. Try again in a few minutes.');
  if (!user || !ok) {
    if (user) {
      const failed = (user.failedLogins || 0) + 1;
      await User.updateOne({ _id: user._id }, { $set: { failedLogins: failed, ...(failed >= 5 ? { lockedUntil: new Date(Date.now() + 15 * 60_000), failedLogins: 0 } : {}) } });
    }
    throw unauthorized('Incorrect email or password');
  }
  if (user.failedLogins || user.lockedUntil) await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0 }, $unset: { lockedUntil: 1 } });
  res.json(await startSession(user, req, res));
}));

// Rotates the refresh token on every use; a replayed old token (after the grace window) revokes the session.
publicAuth.post('/refresh', h(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token || typeof token !== 'string' || token.length > 200) throw unauthorized();
  const hash = sha256(token);
  const now = new Date();
  let session = await Session.findOne({ refreshHash: hash });
  let rotate = true;
  if (!session) {
    const reused = await Session.findOne({ prevHash: hash });
    if (!reused || reused.revokedAt) throw unauthorized();
    if (now - (reused.rotatedAt || 0) > 30_000) {
      await Session.updateOne({ _id: reused._id }, { $set: { revokedAt: now } });
      throw unauthorized('Session ended for your safety. Please sign in again.');
    }
    session = reused; rotate = false; // parallel refresh from another tab: the cookie jar already holds the new token
  }
  if (session.revokedAt || session.expiresAt < now) throw unauthorized();
  const user = await User.findById(session.userId);
  if (!user) throw unauthorized();
  if (rotate) {
    const next = randomToken(48);
    await Session.updateOne({ _id: session._id }, { $set: { prevHash: hash, refreshHash: sha256(next), rotatedAt: now, lastUsedAt: now } });
    res.cookie(REFRESH_COOKIE, next, refreshCookie);
  }
  res.json({ accessToken: signAccess(user, session._id), user: userDto(user) });
}));

publicAuth.post('/logout', h(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (typeof token === 'string' && token) await Session.updateOne({ refreshHash: sha256(token) }, { $set: { revokedAt: new Date() } });
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookie, maxAge: undefined });
  res.status(204).end();
}));

// Request password reset email link
publicAuth.post('/forgot-password', authLimiter, validate({ body: z.object({ email }).strict() }), h(async (req, res) => {
  const { email: mail } = req.valid.body;
  const user = await User.findOne({ email: mail });
  if (user) {
    const token = randomToken(32);
    await User.updateOne({ _id: user._id }, {
      $set: {
        resetHash: sha256(token),
        resetExpiresAt: new Date(Date.now() + 60 * 60_000), // 1 hour
      },
    });
    const resetUrl = `${config.webOrigin}/reset?token=${token}&email=${encodeURIComponent(user.email)}`;
    try {
      await sendPasswordResetEmail(user.email, resetUrl, user.name);
    } catch (err) {
      console.error('[auth] Failed to send password reset email:', err);
    }
  }
  res.json({ message: 'If an account exists with this email, a password reset link has been sent.' });
}));

// Reset password using token from email link
publicAuth.post('/reset-password', authLimiter, validate({
  body: z.object({
    email,
    token: z.string().trim().min(10).max(128),
    newPassword: password,
  }).strict(),
}), h(async (req, res) => {
  const { email: mail, token, newPassword } = req.valid.body;
  const user = await User.findOne({ email: mail }).select('+resetHash');
  const ok = user?.resetHash && user.resetExpiresAt > new Date() && user.resetHash === sha256(token);
  if (!ok) throw badRequest('This password reset link is invalid or has expired.');

  await User.updateOne({ _id: user._id }, {
    $set: { passwordHash: await bcrypt.hash(newPassword, config.bcryptCost), failedLogins: 0 },
    $inc: { tokenVersion: 1 },
    $unset: { resetHash: 1, resetExpiresAt: 1, lockedUntil: 1 },
  });
  await Session.updateMany({ userId: user._id }, { $set: { revokedAt: new Date() } });
  res.json({ success: true, message: 'Password updated successfully. You can now sign in.' });
}));

// ---------- authenticated account routes ----------
export const me = Router();
me.use(authenticate);

me.get('/', (req, res) => res.json(userDto(req.ctx.user)));

me.patch('/', validate({ body: z.object({ name: text(80).optional(), language: z.enum(['en', 'hi', 'ta', 'ml']).optional() }).strict() }), h(async (req, res) => {
  Object.assign(req.ctx.user, req.valid.body);
  await req.ctx.user.save();
  res.json(userDto(req.ctx.user));
}));

me.post('/password', validate({ body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).strict() }), h(async (req, res) => {
  const user = await User.findById(req.ctx.user._id).select('+passwordHash');
  if (!(await bcrypt.compare(req.valid.body.currentPassword, user.passwordHash))) throw unauthorized('Current password is incorrect');
  user.passwordHash = await bcrypt.hash(req.valid.body.newPassword, config.bcryptCost);
  user.tokenVersion += 1;
  await user.save();
  await Session.updateMany({ userId: user._id }, { $set: { revokedAt: new Date() } });
  res.status(204).end();
}));

me.get('/sessions', h(async (req, res) => {
  const list = await Session.find({ userId: req.ctx.user._id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastUsedAt: -1 });
  res.json(list.map((x) => ({ id: String(x._id), device: x.device, lastUsedAt: x.lastUsedAt, current: String(x._id) === req.ctx.sessionId })));
}));
me.delete('/sessions/:id', validate({ params: idParams }), h(async (req, res) => {
  const r = await Session.updateOne({ _id: req.valid.params.id, userId: req.ctx.user._id }, { $set: { revokedAt: new Date() } });
  if (!r.matchedCount) throw notFound();
  res.status(204).end();
}));

me.post('/push-subscriptions', validate({
  body: z.object({
    endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'Push endpoint must be https'),
    keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).strict(),
    deviceName: z.string().trim().max(60).optional(),
  }).strict(),
}), h(async (req, res) => {
  const { endpoint, keys, deviceName } = req.valid.body;
  await User.updateOne({ _id: req.ctx.user._id }, { $pull: { push: { endpoint } } });
  const fresh = await User.findById(req.ctx.user._id).select('push');
  if ((fresh.push || []).length >= 20) throw badRequest('Too many registered devices');
  await User.updateOne({ _id: req.ctx.user._id }, { $push: { push: { endpoint, p256dh: keys.p256dh, auth: keys.auth, deviceName } } });
  res.status(201).end();
}));

me.delete('/', validate({ body: z.object({ password: z.string().min(1).max(128) }).strict() }), h(async (req, res) => {
  const user = await User.findById(req.ctx.user._id).select('+passwordHash');
  if (!(await bcrypt.compare(req.valid.body.password, user.passwordHash))) throw unauthorized('Password is incorrect');
  const mine = await Membership.find({ userId: user._id, status: 'active' });
  for (const m of mine) {
    const others = await Membership.countDocuments({ familyId: m.familyId, status: 'active', userId: { $ne: user._id }, _id: { $ne: m._id } });
    if (m.role === 'owner' && others > 0) {
      const fam = await Family.findById(m.familyId);
      throw badRequest(`Transfer ownership of "${fam?.name}" before deleting your account`);
    }
  }
  for (const m of mine) {
    const others = await Membership.countDocuments({ familyId: m.familyId, status: 'active', _id: { $ne: m._id } });
    if (others === 0) { await deleteFamilyData(m.familyId); } else {
      await Membership.updateOne({ _id: m._id }, { $set: { status: 'left' }, $unset: { linkKey: 1 } });
    }
  }
  await Promise.all([Session.deleteMany({ userId: user._id }), Notification.deleteMany({ userId: user._id }), User.deleteOne({ _id: user._id })]);
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookie, maxAge: undefined });
  res.status(204).end();
}));

export async function deleteFamilyData(familyId) {
  await Promise.all(FAMILY_SCOPED.map((M) => M.deleteMany({ familyId })));
  await Notification.deleteMany({ familyId });
  await allModels.Family.deleteOne({ _id: familyId });
}

me.get('/notifications', h(async (req, res) => {
  const list = await Notification.find({ userId: req.ctx.user._id }).sort({ _id: -1 }).limit(40);
  const unread = await Notification.countDocuments({ userId: req.ctx.user._id, readAt: null });
  res.json({ unread, items: list.map(notificationDto) });
}));
me.post('/notifications/read-all', h(async (req, res) => {
  await Notification.updateMany({ userId: req.ctx.user._id, readAt: null }, { $set: { readAt: new Date() } });
  res.status(204).end();
}));
me.post('/notifications/:id/read', validate({ params: idParams }), h(async (req, res) => {
  await Notification.updateOne({ _id: req.valid.params.id, userId: req.ctx.user._id }, { $set: { readAt: new Date() } });
  res.status(204).end();
}));
