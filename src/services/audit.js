import { AuditLog } from '../models/index.js';

export async function audit(req, action, entity, entityId, meta) {
  try {
    await AuditLog.create({ familyId: req.ctx.familyId, actorId: req.ctx.me, action, entity, entityId, meta });
  } catch (e) { console.warn('[audit] failed:', e.message); }
}
