import https from 'https';
import { config } from '../config.js';
import { GroceryImageCache, GroceryItem } from '../models/index.js';

const ALLOWED_IMAGE_HOSTS = new Set([
  'www.themealdb.com',
  'upload.wikimedia.org',
  'thumb.wikimedia.org',
]);

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SKIP_WIKI_DESC_RE = /\b(disambiguation|film|movie|television|album|song|single|band|actor|actress|singer|musician|politician|software|operating system|video game|corporation|company|novelist|footballer|cricketer|city|town|village|river|district)\b/i;

// Common Indian / Kerala / Malayalam / Manglish grocery aliases -> English culinary / Wikipedia terms
const INDIAN_FOOD_ALIASES = {
  curd: ['Yogurt', 'Greek Yogurt'],
  dahi: ['Yogurt'],
  thayir: ['Yogurt'],
  'തൈര്': ['Yogurt'],
  milk: ['Milk'],
  paal: ['Milk'],
  pal: ['Milk'],
  'പാൽ': ['Milk'],
  egg: ['Eggs'],
  eggs: ['Eggs'],
  mutta: ['Eggs'],
  'മുട്ട': ['Eggs'],
  chicken: ['Chicken'],
  kozhi: ['Chicken'],
  'കോഴി': ['Chicken'],
  banana: ['Banana'],
  bananas: ['Banana'],
  pazham: ['Banana'],
  ethapazham: ['Banana'],
  nendrapazham: ['Banana'],
  'പഴം': ['Banana'],
  'ഏത്തപ്പഴം': ['Banana'],
  'biryani masala': ['Biryani Masala', 'Garam Masala'],
  'biriyani masala': ['Biryani Masala', 'Garam Masala'],
  'chicken masala': ['Garam Masala'],
  'meat masala': ['Garam Masala'],
  'fish masala': ['Garam Masala'],
  masala: ['Garam Masala'],
  'മസാല': ['Garam Masala'],
  'coriander and mint leaves': ['Coriander Leaves', 'Coriander', 'Mint'],
  'coriander leaves': ['Coriander Leaves', 'Coriander'],
  coriander: ['Coriander Leaves', 'Coriander'],
  cilantro: ['Coriander Leaves', 'Coriander'],
  malli: ['Coriander', 'Coriander Seeds'],
  malliyila: ['Coriander Leaves'],
  'മല്ലിയില': ['Coriander Leaves'],
  'mint leaves': ['Mint'],
  mint: ['Mint'],
  pudina: ['Mint'],
  'പുതിന': ['Mint'],
  'curry leaves': ['Curry tree'],
  kariveppila: ['Curry tree'],
  'കറിവേപ്പില': ['Curry tree'],
  'ginger garlic paste': ['Ginger Garlic Paste', 'Ginger', 'Garlic'],
  ginger: ['Ginger'],
  inji: ['Ginger'],
  'ഇഞ്ചി': ['Ginger'],
  garlic: ['Garlic'],
  veluthulli: ['Garlic'],
  'വെളുത്തുള്ളി': ['Garlic'],
  onion: ['Onion', 'Onions'],
  onions: ['Onions', 'Onion'],
  savala: ['Onion'],
  ulli: ['Red Onions', 'Onion'],
  'സവാള': ['Onion'],
  'ചുവന്നുള്ളി': ['Red Onions', 'Onion'],
  tomato: ['Tomato', 'Tomatoes'],
  tomatoes: ['Tomatoes', 'Tomato'],
  thakkali: ['Tomatoes'],
  'തക്കാളി': ['Tomatoes'],
  potato: ['Potatoes'],
  potatoes: ['Potatoes'],
  urulakizhangu: ['Potatoes'],
  'ഉരുളക്കിഴങ്ങ്': ['Potatoes'],
  rice: ['Basmati Rice', 'Rice'],
  'basmati rice': ['Basmati Rice', 'Rice'],
  'matta rice': ['Rice', 'Brown Rice'],
  ari: ['Rice'],
  'അരി': ['Rice'],
  ghee: ['Ghee', 'Butter'],
  neyyi: ['Ghee'],
  'നെയ്യ്': ['Ghee'],
  butter: ['Butter'],
  'വെണ്ണ': ['Butter'],
  'coconut oil': ['Coconut Oil', 'Coconut'],
  oil: ['Vegetable Oil'],
  'വെളിച്ചെണ്ണ': ['Coconut Oil'],
  coconut: ['Coconut'],
  thenga: ['Coconut'],
  'തേങ്ങ': ['Coconut'],
  'green chilli': ['Green Chilli'],
  'green chillies': ['Green Chilli'],
  chilli: ['Chilli', 'Green Chilli'],
  chili: ['Chilli'],
  pachamulaku: ['Green Chilli'],
  mulaku: ['Red Chilli', 'Chilli'],
  'പച്ചമുളക്': ['Green Chilli'],
  'മുളക്': ['Red Chilli'],
  turmeric: ['Turmeric', 'Turmeric Powder'],
  manjal: ['Turmeric'],
  'മഞ്ഞൾ': ['Turmeric'],
  'black pepper': ['Black Pepper'],
  pepper: ['Black Pepper'],
  kurumulaku: ['Black Pepper'],
  'കുരുമുളക്': ['Black Pepper'],
  sugar: ['Sugar'],
  panjasara: ['Sugar'],
  'പഞ്ചസാര': ['Sugar'],
  salt: ['Salt'],
  uppu: ['Salt'],
  'ഉപ്പ്': ['Salt'],
  tea: ['Tea'],
  chaya: ['Tea'],
  'ചായ': ['Tea'],
  coffee: ['Coffee'],
  kappi: ['Coffee'],
  'കാപ്പി': ['Coffee'],
  bread: ['Bread'],
  'ബ്രഡ്': ['Bread'],
  apple: ['Apples'],
  apples: ['Apples'],
  'ആപ്പിൾ': ['Apples'],
  lemon: ['Lemon', 'Lemons'],
  lime: ['Lime'],
  naranga: ['Lemon'],
  'ചെറുനാരങ്ങ': ['Lemon'],
  cashew: ['Cashews', 'Cashew Nuts'],
  cashews: ['Cashews', 'Cashew Nuts'],
  'അണ്ടിപ്പരിപ്പ്': ['Cashews'],
  raisin: ['Raisins'],
  raisins: ['Raisins'],
  'കിസ്മിസ്': ['Raisins'],
  payasam: ['Payasam', 'Kheer'],
  kheer: ['Kheer'],
  'പായസം': ['Payasam', 'Kheer'],
  fish: ['Salmon', 'Fish'],
  meen: ['Salmon'],
  'മീൻ': ['Salmon'],
  mutton: ['Lamb'],
  beef: ['Beef'],
  paneer: ['Paneer'],
  'പനീർ': ['Paneer'],
  dal: ['Lentils'],
  lentils: ['Lentils'],
  parippu: ['Lentils'],
  'പരിപ്പ്': ['Lentils'],
};

let catalogCache = { map: null, fetchedAt: 0, loading: null };
const inFlightResolves = new Map();

export function isSafeImageUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 500) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_IMAGE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function cleanGroceryQuery(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:kgs?|grams?|gms?|g|ml|litres?|liters?|ltrs?|l|pcs?|pieces?|packs?|packets?|pkt|bunche?s?|doz|dozen|box(?:es)?|bottles?)\b/gi, ' ')
    .replace(/[^\p{L}\p{M}\p{N}\s&/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildCandidateQueries(rawName) {
  const cleaned = cleanGroceryQuery(rawName);
  const lower = cleaned.toLowerCase();
  const list = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !list.some((x) => x.toLowerCase() === s.toLowerCase())) list.push(s);
  };

  if (INDIAN_FOOD_ALIASES[lower]) {
    for (const a of INDIAN_FOOD_ALIASES[lower]) push(a);
  }
  push(cleaned);

  // Split compound phrases like "Coriander and Mint Leaves" or "Cashews & Raisins"
  const parts = cleaned.split(/\s+(?:and|&|\/|,)\s+/i).map((p) => p.trim()).filter((p) => p.length >= 2);
  if (parts.length > 1) {
    for (const p of parts) {
      const pl = p.toLowerCase();
      if (INDIAN_FOOD_ALIASES[pl]) for (const a of INDIAN_FOOD_ALIASES[pl]) push(a);
      push(p);
    }
  }

  return list;
}

function matchInCatalog(catalog, query) {
  if (!catalog || !query) return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if (catalog.has(q)) return catalog.get(q);

  const variants = new Set([q]);
  if (q.endsWith('s') && q.length > 3) variants.add(q.slice(0, -1));
  if (q.endsWith('es') && q.length > 4) variants.add(q.slice(0, -2));
  if (q.endsWith('ies') && q.length > 4) variants.add(`${q.slice(0, -3)}y`);
  if (!q.endsWith('s')) {
    variants.add(`${q}s`);
    variants.add(`${q}es`);
    if (q.endsWith('y')) variants.add(`${q.slice(0, -1)}ies`);
  }
  for (const v of variants) {
    if (catalog.has(v)) return catalog.get(v);
  }
  return null;
}

async function fetchJson(url, { headers = {}, timeoutMs = 2500 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'HommieApp/1.0', Accept: 'application/json', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;
  return res.json();
}

async function loadMealDbCatalog() {
  const now = Date.now();
  if (catalogCache.map && now - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.map;
  }
  if (catalogCache.loading) return catalogCache.loading;

  catalogCache.loading = (async () => {
    try {
      const data = await fetchJson('https://www.themealdb.com/api/json/v1/1/list.php?i=list', { timeoutMs: 3500 });
      const map = new Map();
      for (const row of data?.meals || []) {
        const str = row?.strIngredient?.trim();
        if (str) map.set(str.toLowerCase(), str);
      }
      if (map.size > 0) {
        catalogCache.map = map;
        catalogCache.fetchedAt = Date.now();
      }
      return catalogCache.map;
    } catch {
      return catalogCache.map;
    } finally {
      catalogCache.loading = null;
    }
  })();

  return catalogCache.loading;
}

async function verifyMealDbImageUrl(exactIngredient) {
  const slug = encodeURIComponent(exactIngredient.replace(/ /g, '_'));
  const url = `https://www.themealdb.com/images/ingredients/${slug}-Small.png`;
  if (!isSafeImageUrl(url)) return null;
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2200) });
    if (res.ok && /^image\//i.test(res.headers.get('content-type') || '')) return url;
  } catch {}
  return null;
}

async function lookupWikipediaThumb(query) {
  const clean = String(query || '').trim();
  if (!clean || clean.length < 2) return null;
  const slug = encodeURIComponent(clean.replace(/\s+/g, '_'));
  try {
    const data = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${slug}`, { timeoutMs: 2500 });
    if (!data || data.type !== 'standard') return null;
    if (SKIP_WIKI_DESC_RE.test(data.description || '')) return null;
    const src = data.thumbnail?.source;
    if (isSafeImageUrl(src)) return src;
  } catch {}
  return null;
}

function normalizeWithGemini(rawName) {
  return new Promise((resolve) => {
    const key = config.geminiApiKey;
    if (!key) return resolve(null);

    const payload = JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{
          text: `Map this household grocery item (may be Malayalam/Indian/misspelled) to a simple English ingredient or food product name for finding a clean thumbnail. Return JSON only: {"ingredient":"1-3 words","wiki":"optional exact Wikipedia food/product title"}. Item: ${String(rawName).slice(0, 80)}`,
        }],
      }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 60 },
    });

    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-goog-api-key': key,
        },
        timeout: 3000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try {
            const parsed = JSON.parse(body);
            const txt = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const json = JSON.parse(txt.replace(/```json|```/gi, '').trim());
            resolve(json && typeof json === 'object' ? json : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

async function resolveExternalImageUrl(rawName) {
  const candidates = buildCandidateQueries(rawName);
  const catalog = await loadMealDbCatalog();

  // 1. Direct / alias match against TheMealDB transparent PNG catalog
  if (catalog) {
    for (const c of candidates) {
      const hit = matchInCatalog(catalog, c);
      if (hit) {
        const url = await verifyMealDbImageUrl(hit);
        if (url) return url;
      }
    }
  }

  // 2. Gemini normalization (Malayalam, local dishes, typos) -> retry TheMealDB
  const ai = await normalizeWithGemini(rawName);
  if (ai?.ingredient && catalog) {
    const hit = matchInCatalog(catalog, ai.ingredient);
    if (hit) {
      const url = await verifyMealDbImageUrl(hit);
      if (url) return url;
    }
  }

  // 3. Wikipedia thumbnail fallback (great for dishes/household goods like Payasam -> Kheer)
  const wikiCandidates = [ai?.wiki, ...candidates, ai?.ingredient].filter(Boolean);
  const seen = new Set();
  for (const w of wikiCandidates) {
    const wl = String(w).trim().toLowerCase();
    if (!wl || seen.has(wl)) continue;
    seen.add(wl);
    const thumb = await lookupWikipediaThumb(w);
    if (thumb) return thumb;
  }

  return '';
}

function isFreshCacheEntry(doc) {
  if (!doc) return false;
  if (doc.imageUrl && isSafeImageUrl(doc.imageUrl)) return true;
  if (doc.imageUrl === '' && doc.resolvedAt) {
    return Date.now() - new Date(doc.resolvedAt).getTime() < NEGATIVE_CACHE_TTL_MS;
  }
  return false;
}

export async function getCachedGroceryImages(nameKeys) {
  const keys = [...new Set((nameKeys || []).filter(Boolean))];
  const out = new Map();
  if (!keys.length) return out;
  const rows = await GroceryImageCache.find({ nameKey: { $in: keys } }).lean();
  for (const r of rows) {
    if (isFreshCacheEntry(r)) out.set(r.nameKey, r.imageUrl || '');
  }
  return out;
}

export async function resolveAndCacheGroceryImage(name, nameKey) {
  if (process.env.NODE_ENV === 'test') return '';
  if (!nameKey) return '';

  const cached = await GroceryImageCache.findOne({ nameKey }).lean();
  if (isFreshCacheEntry(cached)) return cached.imageUrl || '';

  if (inFlightResolves.has(nameKey)) return inFlightResolves.get(nameKey);

  const task = (async () => {
    try {
      const resolved = await resolveExternalImageUrl(name);
      const safe = resolved && isSafeImageUrl(resolved) ? resolved : '';
      await GroceryImageCache.findOneAndUpdate(
        { nameKey },
        { $set: { imageUrl: safe, resolvedAt: new Date() } },
        { upsert: true }
      ).catch(() => {});
      return safe;
    } catch {
      return '';
    } finally {
      inFlightResolves.delete(nameKey);
    }
  })();

  inFlightResolves.set(nameKey, task);
  return task;
}

/**
 * Resolves and saves only the image URL string onto the GroceryItem document.
 * Optionally waits up to awaitMs so fast lookups return immediately on create.
 */
export async function attachImageToItem(item, { awaitMs = 0 } = {}) {
  if (!item || process.env.NODE_ENV === 'test') return;
  const work = (async () => {
    const url = await resolveAndCacheGroceryImage(item.name, item.nameKey);
    await GroceryItem.updateOne({ _id: item._id }, { $set: { imageUrl: url } }).catch(() => {});
    item.imageUrl = url;
    return url;
  })();

  if (awaitMs > 0) {
    await Promise.race([
      work,
      new Promise((resolve) => setTimeout(resolve, awaitMs)),
    ]).catch(() => {});
  } else {
    work.catch(() => {});
  }
}

/**
 * Applies cached URLs immediately on read and lazily resolves missing legacy items in the background.
 */
export async function backfillMissingGroceryImages(items) {
  if (!Array.isArray(items) || !items.length || process.env.NODE_ENV === 'test') return;
  const missing = items.filter((g) => g.imageUrl == null);
  if (!missing.length) return;

  const cachedMap = await getCachedGroceryImages(missing.map((g) => g.nameKey)).catch(() => new Map());
  const toResolve = [];

  for (const g of missing) {
    if (cachedMap.has(g.nameKey)) {
      const url = cachedMap.get(g.nameKey);
      g.imageUrl = url;
      GroceryItem.updateOne({ _id: g._id }, { $set: { imageUrl: url } }).catch(() => {});
    } else {
      toResolve.push(g);
    }
  }

  if (!toResolve.length) return;

  // Throttle background fills cleanly (at most 12 uncached items per list fetch, 3 concurrent)
  const batch = toResolve.slice(0, 12);
  (async () => {
    for (let i = 0; i < batch.length; i += 3) {
      await Promise.all(
        batch.slice(i, i + 3).map(async (g) => {
          const url = await resolveAndCacheGroceryImage(g.name, g.nameKey);
          await GroceryItem.updateOne({ _id: g._id }, { $set: { imageUrl: url } }).catch(() => {});
        })
      );
    }
  })().catch(() => {});
}
