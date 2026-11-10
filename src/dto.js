// Response DTOs. Mongoose documents are NEVER returned directly: every field sent to a client is listed here.
import { pick } from './services/members.js';
import { nextDue } from './lib/recurrence.js';
import { diffDays, addDays } from './lib/dates.js';

const s = (v) => (v == null ? null : String(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);

export const userDto = (u) => ({ id: s(u._id), name: u.name, email: u.email, language: u.language });

export const familyDto = (f, members, myMembership) => ({
  id: s(f._id), name: f.name, type: f.type, currency: f.currency, timezone: f.timezone,
  myMembershipId: s(myMembership._id), myRole: myMembership.role,
  members: members.map((m) => ({ ...m })),
});

export const taskDto = (t, map) => ({
  id: s(t._id), title: t.title, description: t.description || '', kind: t.kind,
  assignee: pick(map, t.assigneeId), dueDate: t.dueDate || null, status: t.status,
  completedBy: pick(map, t.completedBy), completedAt: iso(t.completedAt),
  createdBy: pick(map, t.createdBy),
  link: t.link?.id ? { kind: t.link.kind, id: s(t.link.id) } : null,
  repeat: t.repeat?.unit && t.repeat.unit !== 'none' ? { unit: t.repeat.unit, everyN: t.repeat.everyN } : null,
  rotation: t.rotation?.order?.length ? t.rotation.order.map((id) => pick(map, id)) : null,
});

export function groceryDto(g, map, nowMs = Date.now()) {
  const dates = (g.buyDates || []).map((d) => new Date(d).getTime()).sort((a, b) => a - b);
  let avg = null;
  if (dates.length >= 3) {
    const gaps = dates.slice(1).map((d, i) => (d - dates[i]) / 864e5);
    avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  }
  const since = g.lastBoughtAt ? (nowMs - new Date(g.lastBoughtAt).getTime()) / 864e5 : null;
  return {
    id: s(g._id), name: g.name, qty: g.qty || '', status: g.status,
    category: g.category || 'other', shop: g.shop || 'Supermarket',
    imageUrl: g.imageUrl && /^https:\/\//.test(g.imageUrl) ? g.imageUrl : null,
    lastPrice: g.lastPrice || null,
    lastBought: g.lastBoughtAt ? { by: pick(map, g.lastBoughtBy), at: iso(g.lastBoughtAt) } : null,
    avgIntervalDays: avg ? Math.round(avg * 10) / 10 : null,
    likelyLow: g.status === 'stocked' && avg !== null && since !== null && since >= avg * 0.85,
  };
}

export const recipeSummaryDto = (r, map) => ({
  id: s(r._id), title: r.title, tags: r.tags || [], hasPhoto: !!r.photoId, photoId: s(r.photoId), createdBy: pick(map, r.createdBy),
});
export const recipeDto = (r, map) => ({
  ...recipeSummaryDto(r, map),
  ingredients: (r.ingredients || []).map((i) => ({ name: i.name, qty: i.qty || '' })), steps: r.steps || [],
});

export const mealDto = (m, map, recipeTitle, guests = 0) => ({
  id: s(m._id), date: m.date, slot: m.slot, items: m.items || [],
  recipe: m.recipeId ? { id: s(m.recipeId), title: recipeTitle || 'Recipe' } : null,
  cook: pick(map, m.cookId),
  attendance: (m.attendance || []).map((a) => ({ member: pick(map, a.memberId), status: a.status })),
  guests,
});

export const billDto = (b, map, today) => ({
  id: s(b._id), title: b.title, category: b.category, amountMode: b.amountMode, fixedAmount: b.fixedAmount ?? null,
  rule: { unit: b.rule.unit, everyN: b.rule.everyN, anchorDate: b.rule.anchorDate, endDate: b.rule.endDate || null },
  payer: pick(map, b.payerId), reminderDaysBefore: b.reminderDaysBefore,
  splitAmong: (b.splitAmong || []).map((id) => pick(map, id)), active: b.active, note: b.note || '',
  createdBy: pick(map, b.createdBy),
  nextDue: nextDue(b.rule, today), isLoanEmi: !!b.loanId,
});

export function instanceDto(i, bill, map, today, task) {
  const overdue = i.status !== 'paid' && i.dueDate < today;
  return {
    id: s(i._id), billId: s(i.billId), billTitle: bill?.title || 'Bill', category: bill?.category || 'other',
    dueDate: i.dueDate, amount: i.amount ?? null, status: i.status, overdue,
    daysLeft: diffDays(i.dueDate, today),
    payer: pick(map, task?.assigneeId ?? bill?.payerId), taskId: s(i.taskId),
    paidBy: pick(map, i.paidBy), paidAt: iso(i.paidAt),
    createdBy: pick(map, bill?.createdBy),
    receipt: i.receiptDocumentId ? { documentId: s(i.receiptDocumentId) } : null,
  };
}

export const loanDto = (l, today, map) => {
  const paidPrincipal = l.principal - l.outstanding;
  const emiThisMonth = (() => {
    const [y, m] = today.split('-').map(Number);
    const cand = `${y}-${String(m).padStart(2, '0')}-${String(l.emiDay).padStart(2, '0')}`;
    if (cand >= today) return cand;
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    return `${ny}-${String(nm).padStart(2, '0')}-${String(l.emiDay).padStart(2, '0')}`;
  })();
  return {
    id: s(l._id), lender: l.lender, owner: pick(map, l.ownerId), principal: l.principal, interestRate: l.interestRate,
    emiAmount: l.emiAmount, emiDay: l.emiDay, startDate: l.startDate, tenureMonths: l.tenureMonths,
    outstanding: l.outstanding, progressPercent: Math.min(100, Math.round((paidPrincipal / l.principal) * 100)),
    nextEmiDate: l.closedAt ? null : emiThisMonth, visibility: l.visibility, closed: !!l.closedAt,
  };
};

export const loanPaymentDto = (p) => ({ id: s(p._id), paidOn: p.paidOn, amount: p.amount, interestPart: p.interestPart, principalPart: p.principalPart });

export const expenseDto = (e, map) => ({
  id: s(e._id), amount: e.amount, category: e.category, date: e.date, paidBy: pick(map, e.paidById),
  split: (e.split || []).map((x) => ({ member: pick(map, x.memberId), share: x.share })),
  note: e.note || '', source: e.source,
});

export const settlementDto = (x, map) => ({ id: s(x._id), from: pick(map, x.fromId), to: pick(map, x.toId), amount: x.amount, date: x.date, note: x.note || '' });

/** Visibility of a document for a given membership id. Owner-only for private; admins get no extra access. */
export function canViewDoc(d, me) {
  if (String(d.ownerId) === String(me)) return true;
  if (d.visibilityMode === 'family') return true;
  if (d.visibilityMode === 'custom') return (d.allowedIds || []).some((x) => String(x) === String(me));
  return false;
}
export const docDto = (d, me, map, today) => ({
  id: s(d._id), title: d.title, category: d.category, owner: pick(map, d.ownerId),
  visibilityMode: d.visibilityMode,
  allowed: String(d.ownerId) === String(me) ? (d.allowedIds || []).map((id) => pick(map, id)) : undefined,
  expiryDate: d.expiryDate || null,
  expiresInDays: d.expiryDate ? diffDays(d.expiryDate, today) : null,
  maskedNumber: d.maskedNumber || '', mime: d.mime, size: d.size, isOwner: String(d.ownerId) === String(me),
});

export const canSeeMedicine = (m, me) =>
  [m.forId, m.createdBy, ...(m.caregivers || [])].some((x) => x && String(x) === String(me));

export const medicineDto = (m, map) => ({
  id: s(m._id), forMember: pick(map, m.forId), name: m.name, dosage: m.dosage || '', times: m.times || [], days: m.days || [],
  startDate: m.startDate, endDate: m.endDate || null, stock: m.stock ?? null, lowStock: m.stock != null && m.stock <= 3,
  caregivers: (m.caregivers || []).map((id) => pick(map, id)), notes: m.notes || '', active: m.active,
});

export const specialDateDto = (d, map, nextDate, daysAway) => ({
  id: s(d._id), title: d.title, kind: d.kind, date: d.date, repeatYearly: d.repeatYearly, remindDaysBefore: d.remindDaysBefore,
  nextDate, daysAway,
  checklist: (d.checklist || []).map((c) => ({ id: s(c._id), text: c.text, done: c.done, assignee: pick(map, c.assigneeId) })),
});

export const guestDto = (g, map) => ({ id: s(g._id), name: g.name, from: g.from, to: g.to, notes: g.notes || '', host: pick(map, g.hostId) });
export const contactDto = (c) => ({ id: s(c._id), name: c.name, role: c.role, phone: c.phone, notes: c.notes || '' });

export const chatDto = (m, map, readByCount = 0, liveStatus = null) => ({
  id: s(m._id), type: m.type, text: m.text || '', sender: pick(map, m.senderId),
  attachmentId: s(m.attachmentId),
  audioDuration: m.audioDuration || null,
  replyTo: m.replyTo?.id ? { id: s(m.replyTo.id), senderName: m.replyTo.senderName || '', text: m.replyTo.text || '' } : null,
  ref: m.ref?.id ? { kind: m.ref.kind, id: s(m.ref.id), title: m.ref.title, status: liveStatus || m.ref.status || 'open' } : null,
  createdAt: iso(m.createdAt), readByCount,
});

export const notificationDto = (n) => ({
  id: s(n._id), type: n.type, title: n.title, body: n.body || '', url: n.url || '/', familyId: s(n.familyId), read: !!n.readAt, createdAt: iso(n.createdAt),
});

export const auditDto = (a, map) => ({ id: s(a._id), actor: pick(map, a.actorId), action: a.action, entity: a.entity || null, meta: a.meta || null, at: iso(a.createdAt) });
export { addDays };
