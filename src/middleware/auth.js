import { verifyAccess } from '../lib/tokens.js';
import { unauthorized, forbidden, badRequest, h } from '../lib/errors.js';
import { oid } from '../lib/validate.js';
import { User, Session, Membership, Family } from '../models/index.js';

/** Verifies the bearer token, the server-side session and the token version (instant revocation). */
export const authenticate = h(async (req, _res, next) => {
  const header = req.get('authorization') || '';
  const m = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header);
  if (!m) throw unauthorized();
  let payload;
  try { payload = verifyAccess(m[1]); } catch { throw unauthorized('Session expired'); }
  const [user, session] = await Promise.all([
    User.findById(payload.sub),
    Session.findById(payload.sid).select('revokedAt expiresAt userId'),
  ]);
  if (!user || user.tokenVersion !== payload.tv) throw unauthorized('Session expired');
  if (!session || session.revokedAt || session.expiresAt < new Date() || String(session.userId) !== String(user._id)) {
    throw unauthorized('Session expired');
  }
  req.ctx = { user, sessionId: String(session._id) };
  next();
});

/** Resolves X-Family-Id to an *active membership of the caller*. The client can never choose a familyId it does not belong to. */
export const familyContext = h(async (req, _res, next) => {
  const raw = req.get('x-family-id');
  if (!raw || !oid.safeParse(raw).success) throw badRequest('X-Family-Id header is required');
  const membership = await Membership.findOne({ familyId: raw, userId: req.ctx.user._id, status: 'active' });
  if (!membership) throw forbidden('You are not a member of this family');
  const family = await Family.findById(raw);
  if (!family) throw forbidden('You are not a member of this family');
  Object.assign(req.ctx, { membership, family, familyId: String(family._id), me: String(membership._id) });
  next();
});

export const isAdmin = (req) => ['owner', 'admin'].includes(req.ctx.membership.role);
export const requireAdmin = (req, _res, next) => (isAdmin(req) ? next() : next(forbidden('Only a family admin can do this')));
export const requireOwner = (req, _res, next) => (req.ctx.membership.role === 'owner' ? next() : next(forbidden('Only the family owner can do this')));
