import { ChatMessage } from '../models/index.js';

/** Posts an automatic message into the family chat (e.g. "Eggs bought by Amma"). */
export async function systemMessage(familyId, text, ref) {
  try {
    return await ChatMessage.create({ familyId, type: 'system', text: text.slice(0, 300), ref });
  } catch (e) { console.warn('[chat] system message failed:', e.message); return null; }
}
