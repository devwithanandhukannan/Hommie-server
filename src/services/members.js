import { Membership } from '../models/index.js';

export const memberDto = (m) => ({
  membershipId: String(m._id),
  displayName: m.displayName,
  relation: m.relation,
  role: m.role,
  color: m.color,
  hasAccount: !!m.userId,
});

/** Active members of a family as Map(id -> MemberPublicDto) plus the raw docs. */
export async function loadMembers(familyId) {
  const docs = await Membership.find({ familyId, status: 'active' }).sort({ createdAt: 1 });
  const map = new Map(docs.map((m) => [String(m._id), memberDto(m)]));
  return { docs, map, ids: docs.map((d) => String(d._id)) };
}

/** A member DTO for an id, falling back to a placeholder for members who have left. */
export const pick = (map, id) => (id ? map.get(String(id)) || { membershipId: String(id), displayName: 'Former member', relation: 'other', role: 'member', color: '#7F938E', hasAccount: false } : null);

export const COLORS = ['#0B6B5D', '#2F5D9B', '#B4540A', '#7A3E9D', '#A61B3B', '#4D7C0F', '#0E7490', '#9A6700'];
