const CONTEXT_TTL_MS = 20_000;
const CONTEXT_MAX_ENTRIES = 200;
const contextCache = new Map();

export function getCachedAiContext(key) {
  const cached = contextCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    contextCache.delete(key);
    return null;
  }
  return cached.value;
}

export function setCachedAiContext(key, value) {
  if (contextCache.size >= CONTEXT_MAX_ENTRIES) {
    const oldest = contextCache.keys().next().value;
    if (oldest) contextCache.delete(oldest);
  }
  contextCache.set(key, { expiresAt: Date.now() + CONTEXT_TTL_MS, value });
}

/** Invalidates cached AI ground-truth context for a family after mutations. */
export function invalidateAiContextCache(familyId) {
  if (!familyId) return;
  const prefix = `${String(familyId)}:`;
  for (const k of contextCache.keys()) {
    if (k.startsWith(prefix)) contextCache.delete(k);
  }
}

