import { invalidateAiContextCache } from './aiCache.js';

const userStreams = new Map();
const familyStreams = new Map();

function addStream(map, key, res) {
  if (!key) return;
  const k = String(key);
  let set = map.get(k);
  if (!set) {
    set = new Set();
    map.set(k, set);
  }
  set.add(res);
}

function removeStream(map, key, res) {
  if (!key) return;
  const k = String(key);
  const set = map.get(k);
  if (!set) return;
  set.delete(res);
  if (!set.size) map.delete(k);
}

function sendFrame(streams, event, payload) {
  if (!streams?.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...streams]) {
    try {
      res.write(msg);
    } catch {
      streams.delete(res);
    }
  }
}

/**
 * Registers a persistent Server-Sent Events stream for real-time updates
 * (new messages, notifications, and family list invalidations).
 */
export function subscribeSse(req, res) {
  const userId = req.ctx?.user?._id ? String(req.ctx.user._id) : null;
  const familyId = req.ctx?.familyId ? String(req.ctx.familyId) : null;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  addStream(userStreams, userId, res);
  addStream(familyStreams, familyId, res);

  try {
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, familyId })}\n\n`);
  } catch {
    // closed immediately
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    removeStream(userStreams, userId, res);
    removeStream(familyStreams, familyId, res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

/** Sends a real-time SSE update event to specific connected user accounts. */
export function publishToUsers(userIds, payload) {
  const uniq = [...new Set((userIds || []).filter(Boolean).map(String))];
  for (const uid of uniq) {
    sendFrame(userStreams.get(uid), 'update', { ...payload, ts: Date.now() });
  }
}

/**
 * Invalidates AI ground-truth context cache and notifies connected family
 * sessions so UI panels refresh immediately without rapid HTTP polling.
 */
export function publishFamilyChange(familyId, kind = 'family') {
  if (!familyId) return;
  const fid = String(familyId);
  invalidateAiContextCache(fid);
  sendFrame(familyStreams.get(fid), 'update', { kind, familyId: fid, ts: Date.now() });
}

