import webpush from 'web-push';
import { config } from '../config.js';
import { User, Notification, Membership } from '../models/index.js';
import { renderNotification } from '../lib/notifI18n.js';
import { publishToUsers } from './events.js';

const pushEnabled = !!(config.vapid.publicKey && config.vapid.privateKey);
if (pushEnabled) webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
export const isPushEnabled = () => pushEnabled;

/**
 * Creates in-app notifications (idempotent through dedupeKey) and sends Web Push,
 * batching user lookups and localizing per recipient based on `user.language`.
 */
export async function notify({ userIds, familyId, type, title, body, url, dedupeKey, pushTitle, pushBody, i18nKey, params, coalesce = false }) {
  const unique = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!unique.length) return;

  const users = await User.find({ _id: { $in: unique } }).select('push mutedFamilies language').lean();
  const notifiedUserIds = [];

  await Promise.all(users.map(async (user) => {
    const userId = String(user._id);
    if (familyId && (user.mutedFamilies || []).some((f) => String(f) === String(familyId)) && type === 'chat') return;

    const localized = renderNotification({ i18nKey, params, title, body, pushTitle, pushBody }, user.language || 'en');
    if (!localized.title) return;

    try {
      const merged = coalesce && await Notification.findOneAndUpdate(
        { userId, familyId, type, readAt: null },
        { $set: { title: localized.title, body: localized.body, url } }
      );
      if (!merged) {
        await Notification.create({
          userId,
          familyId,
          type,
          title: localized.title,
          body: localized.body,
          url,
          dedupeKey: dedupeKey ? `${userId}:${dedupeKey}` : undefined,
        });
      }
    } catch (e) {
      if (e?.code === 11000) return; // already notified
      throw e;
    }

    notifiedUserIds.push(userId);
    if (!pushEnabled || !user.push?.length) return;

    const payload = JSON.stringify({
      title: localized.pushTitle,
      body: localized.pushBody,
      url: url || '/',
      familyId: familyId ? String(familyId) : undefined,
      tag: dedupeKey || type,
    });
    const dead = [];
    await Promise.all(user.push.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(s._id);
      }
    }));
    if (dead.length) await User.updateOne({ _id: userId }, { $pull: { push: { _id: { $in: dead } } } });
  }));

  if (notifiedUserIds.length) {
    publishToUsers(notifiedUserIds, { kind: 'notification', type, familyId: familyId ? String(familyId) : null });
  }
}

export const userIdsOf = (members) => members.filter((m) => m.userId).map((m) => String(m.userId));

/** Returns active linked userIds in a family, optionally excluding the acting member. */
export async function otherFamilyUserIds(familyId, excludeMemberId = null) {
  const filter = { familyId, status: 'active', userId: { $ne: null } };
  if (excludeMemberId) filter._id = { $ne: excludeMemberId };
  const others = await Membership.find(filter).select('userId').lean();
  return userIdsOf(others);
}
