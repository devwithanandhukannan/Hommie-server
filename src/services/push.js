import webpush from 'web-push';
import { config } from '../config.js';
import { User, Notification, Membership } from '../models/index.js';
import { renderNotification } from '../lib/notifI18n.js';

const pushEnabled = !!(config.vapid.publicKey && config.vapid.privateKey);
if (pushEnabled) webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
export const isPushEnabled = () => pushEnabled;

/**
 * Creates an in-app notification (idempotent through dedupeKey) and sends a Web Push,
 * localized per recipient based on their chosen `user.language`.
 */
export async function notify({ userIds, familyId, type, title, body, url, dedupeKey, pushTitle, pushBody, i18nKey, params, coalesce = false }) {
  const unique = [...new Set((userIds || []).filter(Boolean).map(String))];
  for (const userId of unique) {
    const user = await User.findById(userId).select('push mutedFamilies language');
    if (!user) continue;
    if (familyId && (user.mutedFamilies || []).some((f) => String(f) === String(familyId)) && type === 'chat') continue;

    const localized = renderNotification({ i18nKey, params, title, body, pushTitle, pushBody }, user.language || 'en');
    if (!localized.title) continue;

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
      if (e?.code === 11000) continue; // already notified
      throw e;
    }

    if (!pushEnabled || !user.push?.length) continue;
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
