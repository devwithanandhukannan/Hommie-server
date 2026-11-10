import { config } from '../config.js';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const AI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcription: { type: 'STRING' },
    reply: { type: 'STRING' },
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: {
            type: 'STRING',
            enum: [
              'add_grocery',
              'add_task',
              'delete_task',
              'add_expense',
              'add_meal',
              'add_recipe',
              'add_calendar_event',
              'bill',
            ],
          },
          title: { type: 'STRING' },
          quantity: { type: 'STRING', nullable: true },
          category: { type: 'STRING', nullable: true },
          shop: { type: 'STRING', nullable: true },
          amount: { type: 'NUMBER', nullable: true },
          date: { type: 'STRING', nullable: true },
          dueDate: { type: 'STRING', nullable: true },
          slot: { type: 'STRING', nullable: true },
          cookName: { type: 'STRING', nullable: true },
          assigneeName: { type: 'STRING', nullable: true },
          targetId: { type: 'STRING', nullable: true },
          ingredients: {
            type: 'ARRAY',
            nullable: true,
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                qty: { type: 'STRING', nullable: true },
              },
              required: ['name'],
            },
          },
          steps: {
            type: 'ARRAY',
            nullable: true,
            items: { type: 'STRING' },
          },
        },
        required: ['type', 'title'],
      },
    },
    suggestedChips: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
  },
  required: ['transcription', 'reply', 'actions', 'suggestedChips'],
};

const SYSTEM_PROMPT = `You are Hommi AI, a fast, accurate household assistant.

LANGUAGE RULE (CRITICAL):
- Reply strictly in the EXACT language of THIS latest user message/audio (ignore UI language, kitchen item scripts, or earlier turns if different).
- English input -> 100% English across ALL fields: "reply", "actions[].title", "actions[].shop", "actions[].ingredients", "actions[].steps", and "suggestedChips" (e.g. "Chicken Biryani", "Onion", NEVER Malayalam script when user asked in English).
- Malayalam or Manglish input -> natural Malayalam script across ALL fields ("reply", "actions[].title", "actions[].shop", "actions[].ingredients", "actions[].steps", "suggestedChips"). Keep "transcription" clear and faithful to what was spoken.
- Tamil or Hindi input -> 100% Tamil or Hindi respectively across ALL fields.
- READABLE FORMATTING: Always use real newline breaks (\n) in "reply" — NEVER pack headings, bullets, and numbered steps onto one line. Format recipes with a brief intro line, a blank line, "Ingredients:\n- Item: qty (Already available in your kitchen)\n- Item: qty (need to buy)", a blank line, and "Steps:\n1. Step description (10 min)\n2. ..." (or local-language equivalent headings).

AUDIO / SPEECH RULES:
- Transcribe spoken voice accurately, including Malayalam, Indian English, and mixed Malayalam-English (Manglish) household terms (e.g. dish names, medicine names, groceries).
- Malayalam / Manglish vs Tamil disambiguation (CRITICAL): When short audio mixes English words ("morning", "breakfast", "dinner") with shared South-Indian words like "naale" or "puttu", check Malayalam endings/particles ("-aanu", "-aane", "-undo", "-illa", "-venam", "-cheyyam", "-alle") vs Tamil ("-irukku", "-illai", "-thaan", "naalaikku"). For example, "naale morning breakfast puttaane" (ending in "-aane") is Malayalam/Manglish -> transcribe in Malayalam ("നാളെ മോർണിംഗ് ബ്രേക്ക്ഫാസ്റ്റ് പുട്ടാണേ"), NOT Tamil.
- If audio is silent, noise-only, or unintelligible, return transcription: "", actions: [], and politely ask the user to speak clearly.

HOUSEHOLD RULES:
1. Cooking / Dish & Meal queries (FULL KITCHEN DETAIL — DO NOT COMPRESS):
   - NEVER limit or simplify recipes to 5 short/vague steps. Include as many clear, detailed numbered steps as the dish genuinely needs (all prep, marination, tempering/tadka, heat transitions, water ratios, whistles/simmer times, resting, and serving).
   - List EVERY ingredient with exact household measurements (including oil/ghee, spices like turmeric/chilli/coriander/garam masala, salt, water ratio, aromatics, curry leaves, garnish — not just main items) and cross-check against Kitchen Inventory.
   - Each step MUST give practical precision: exact ingredient amounts added at that stage, flame level (low / medium / high), timings in parentheses e.g. (10 min), and clear doneness cues (e.g. "until onions turn deep golden and oil separates").
   - Put the SAME complete detailed ingredients and full step-by-step instructions into the "add_recipe" action's "ingredients" and "steps" arrays so nothing is lost when saved.
   - Only add missing ingredients (not already in Kitchen Inventory) as "add_grocery" actions with short titles (<60 chars), quantity, category (vegetables|meat|spices|dairy|pantry|household|medical|other), and shop (Vegetable Stall | Meat & Poultry Stall | Supermarket / Grocery | Dairy & Bakery | Medical Store — or local-language equivalent).
   - Add "add_meal" (date YYYY-MM-DD, slot "morning"|"noon"|"night", cookName from Family Members) and "add_calendar_event" (dueDate, assigneeName) when scheduling or planning a meal.
2. "What can I cook fast / from my kitchen?" queries (Kitchen-stock meal ideas):
   - Inspect "Kitchen Stock" strictly! Never claim an item is in the kitchen unless it appears in Kitchen Stock (basic water/salt/oil may be noted as basic staples).
   - Rank 2-4 realistic quick meals sorted by speed & readiness: first dishes you can cook RIGHT NOW using only Kitchen Stock (0 items to buy, with estimated prep+cook time e.g. "~15 min"), then optional "needs 1-2 extra items" ideas.
   - If the user asks for one quick meal right now or picks one, also provide full detailed "Ingredients:" and kitchen-ready "Steps:", plus "add_recipe" (and "add_meal" / missing "add_grocery" if relevant). If they are only brainstorming options, return "actions": [] and put the top 2-3 dishes directly into "suggestedChips" (e.g. "Make Egg Roast (full recipe)", "Plan Puttu for dinner") so they can tap any option.
   - If Kitchen Stock is empty ("None"), clearly state the kitchen stock list is empty and suggest quick ideas they might make with basic pantry items or ask what ingredients they have on hand.
3. Ground-truth queries:
   - Groceries to buy, kitchen stock, meals today/tomorrow, open tasks, today's medicines, upcoming bills, or monthly expense totals: answer strictly from LIVE HOUSEHOLD GROUND-TRUTH. Never invent items or numbers.
   - For "delete_task", set targetId to the exact open task ID.
   - For "add_expense", amount must be a pure number in INR (not string).
4. Keep "suggestedChips" to 2-3 short, useful follow-up prompts in the active language.`;

function thinkingConfigForModel(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('gemini-3')) return { thinkingLevel: 'MINIMAL' };
  if (m.startsWith('gemini-2.5-flash')) return { thinkingBudget: 0 };
  return null;
}

async function callGemini(payload) {
  const key = config.geminiApiKey;
  if (!key) {
    throw new Error('GEMINI_API_KEY is not configured on the server');
  }

  const model = config.geminiModel;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const thinkingConfig = thinkingConfigForModel(model);

  const requestBody = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    ...payload,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: AI_RESPONSE_SCHEMA,
      ...(thinkingConfig ? { thinkingConfig } : {}),
      ...(payload.generationConfig || {}),
    },
  };

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(35_000),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const err = new Error(`Gemini API error (${res.status}): ${errBody.slice(0, 300)}`);
        if (RETRYABLE_STATUS.has(res.status) && attempt === 1) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 450));
          continue;
        }
        throw err;
      }

      const parsed = await res.json();
      return parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (err) {
      lastErr = err;
      const isTimeoutOrNet = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 'ECONNRESET' || err?.cause?.code === 'ECONNRESET';
      if (attempt === 1 && isTimeoutOrNet) {
        await new Promise((r) => setTimeout(r, 450));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

function cleanJson(rawText) {
  if (!rawText) return null;
  let cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {}
    }
    return null;
  }
}

/**
 * Formats compact live household ground-truth context for the Gemini prompt.
 */
export function formatContext(context = {}) {
  const neededGroceriesSummary = (context.neededGroceries || []).map((g) => `${g.name}${g.qty ? ` (${g.qty})` : ''}`).join(', ') || 'None';
  const inStockSummary = (context.inStockGroceries || []).map((g) => `${g.name}${g.qty ? ` (${g.qty})` : ''}`).join(', ') || 'None';
  const tasksSummary = (context.openTasks || []).map((t) => `ID:${t._id || t.id} - ${t.title}${t.assigneeName ? ` (for ${t.assigneeName})` : ''}${t.dueDate ? ` due ${t.dueDate}` : ''}`).join('; ') || 'No open tasks';
  const medicinesSummary = (context.todayMedicines || []).map((m) => `${m.forName || 'Member'}: ${m.name} at ${m.time || 'scheduled'} (${m.dosage || '1 dose'}) - ${m.status || 'pending'}`).join('; ') || 'No medicines scheduled today';
  const expensesBreakdown = Object.entries(context.monthlyExpenseCategories || {}).map(([cat, amt]) => `${cat}: ₹${amt}`).join(', ') || 'None';
  const billsSummary = (context.upcomingBills || []).map((b) => `${b.title} due ${b.dueDate}${b.amount != null ? ` (₹${b.amount})` : ''}`).join('; ') || 'No bills due soon';
  const mealsSummary = (context.todayMeals || [])
    .map((m) => `${m.date} ${m.slot}: ${(m.items || []).join(', ') || 'Planned'}${m.cookName ? ` (cook: ${m.cookName})` : ''}`)
    .join('; ') || 'None planned';
  const membersSummary = (context.familyMembers || []).map((m) => `${m.name} (${m.relation || 'member'})`).join(', ') || 'Family members';

  return `LIVE HOUSEHOLD GROUND-TRUTH:
- Today: ${context.todayStr || new Date().toISOString().slice(0, 10)}, Tomorrow: ${context.tomorrowStr || new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
- Members: ${membersSummary}
- Groceries Needed: ${neededGroceriesSummary}
- Kitchen Stock: ${inStockSummary}
- Meals Planned (Today/Tomorrow): ${mealsSummary}
- Open Tasks: ${tasksSummary}
- Today Medicines: ${medicinesSummary}
- Upcoming Bills (14d): ${billsSummary}
- Month Expenses: ₹${context.monthlyExpenseTotal || 0} (${expensesBreakdown})`;
}

const MANGLISH_RE = /\b(entha|enthu|enthokke|engane|undakkam|cheyyam|cheythu|evide|enna|aano|aanu|aane|alle|venam|veeno|vendath|undo|illa|ille|kittum|vaangam|vaangikko|medikkam|medikkanam|vekkam|vekkanam|chilavu|veetil|chaya|kanji|choru|curry|ari|meen|irachi|pachakkari|puttu|appam|dosa|idli|porotta|paal|mutta|thenga|savala|thakkali|innu|innathe|naale|innale|ningal|njan|njammale)\b/i;
const MANGLISH_SUFFIX_RE = /\b[a-z]+(?:aane|aanu|ikkanam|akkanam|ukayanu|undallo)\b/i;

function detectMessageLang(msg, fallback = 'en') {
  const s = String(msg || '').trim();
  if (!s) return fallback || 'en';
  if (/[\u0D00-\u0D7F]/.test(s)) return 'ml';
  if (/[\u0B80-\u0BFF]/.test(s)) return 'ta';
  if (/[\u0900-\u097F]/.test(s)) return 'hi';
  if (MANGLISH_RE.test(s) || MANGLISH_SUFFIX_RE.test(s)) return 'ml';
  return 'en';
}

function languageDirective({ text = '', audioBuffer = null, speechLang = '' }) {
  const cleanHint = String(speechLang || '').trim().slice(0, 12);
  if (audioBuffer && audioBuffer.length > 0 && !String(text || '').trim()) {
    const hintNote = cleanHint ? ` (speaker UI/speech preference hint if ambiguous: ${cleanHint})` : '';
    return `LANGUAGE: Detect the exact language spoken in this voice note${hintNote} and respond in that language.`;
  }
  const detected = detectMessageLang(text);
  const label = detected === 'ml'
    ? 'Malayalam'
    : detected === 'ta'
    ? 'Tamil'
    : detected === 'hi'
    ? 'Hindi'
    : 'English (100% English, NOT Malayalam)';
  return `LANGUAGE: Respond strictly in ${label}.`;
}

function fallbackResponse(kind, lang) {
  if (lang === 'ml') {
    return {
      reply: kind === 'error'
        ? 'ക്ഷമിക്കണം, എഐ പ്രോസസ്സ് ചെയ്യുന്നതിൽ തടസ്സമുണ്ടായി. ദയവായി വീണ്ടും ശ്രമിക്കുക.'
        : 'ക്ഷമിക്കണം, എനിക്ക് അത് മനസ്സിലാക്കാൻ സാധിച്ചില്ല. ദയവായി ഒന്നുകൂടി പറയാമോ?',
      chips: ['എന്തൊക്കെ വാങ്ങാനുണ്ട്?', 'ഈ മാസത്തെ ചിലവ് എത്ര?'],
    };
  }
  if (lang === 'hi') {
    return {
      reply: kind === 'error'
        ? 'माफ़ कीजिए, अनुरोध प्रोसेस करने में समस्या हुई। कृपया फिर से कोशिश करें।'
        : 'माफ़ कीजिए, मैं इसे समझ नहीं पाया। कृपया दोबारा कहें?',
      chips: ['क्या खरीदना है?', 'इस महीने का खर्च'],
    };
  }
  if (lang === 'ta') {
    return {
      reply: kind === 'error'
        ? 'மன்னிக்கவும், கோரிக்கையை செயல்படுத்த முடியவில்லை. மீண்டும் முயற்சிக்கவும்.'
        : 'மன்னிக்கவும், அதை புரிந்துகொள்ள முடியவில்லை. மீண்டும் சொல்ல முடியுமா?',
      chips: ['என்ன வாங்க வேண்டும்?', 'இந்த மாத செலவு'],
    };
  }
  return {
    reply: kind === 'error'
      ? 'Sorry, I could not process that request right now. Please try again.'
      : 'Sorry, I could not understand that. Could you rephrase it?',
    chips: ['What to buy?', 'Monthly expenses'],
  };
}

function normalizeActions(rawActions) {
  if (!Array.isArray(rawActions)) return [];
  return rawActions
    .filter((a) => a && typeof a.title === 'string' && a.title.trim().length > 0)
    .map((a) => ({
      ...a,
      title: a.title.trim().slice(0, 140),
      amount: typeof a.amount === 'number' && Number.isFinite(a.amount) && a.amount > 0 ? a.amount : null,
      slot: ['morning', 'noon', 'night'].includes(a.slot) ? a.slot : null,
    }));
}

function compactHistory(history = []) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const recent = history.slice(-4).map((h) => {
    const content = String(h?.content || '').replace(/\s+/g, ' ').trim();
    const limit = h?.role === 'assistant' ? 280 : 400;
    const clipped = content.length > limit ? `${content.slice(0, limit)}…` : content;
    return `${h?.role === 'user' ? 'User' : 'Assistant'}: ${clipped}`;
  });
  return `\nRecent Conversation History (topic context only):\n${recent.join('\n')}\n`;
}

async function runAssistant({ message = '', audioBuffer = null, mimeType = 'audio/webm', speechLang = '', context = {}, history = [] }) {
  const cleanText = String(message || '').trim();
  const hasAudio = Boolean(audioBuffer && audioBuffer.length > 0);
  if (!hasAudio && !cleanText) {
    throw new Error('Either text or audio is required for AI analysis');
  }

  const parts = [];
  const ctxString = formatContext(context);
  const histText = compactHistory(history);
  const langRule = languageDirective({ text: cleanText, audioBuffer, speechLang });
  const hintBase = String(speechLang || '').split('-')[0].toLowerCase();
  const fbLang = hasAudio && !cleanText
    ? (['ml', 'hi', 'ta', 'en'].includes(hintBase) ? hintBase : (context.uiLang || 'en'))
    : detectMessageLang(cleanText, context.uiLang || 'en');

  if (hasAudio) {
    const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim();
    parts.push({
      inlineData: {
        mimeType: cleanMime,
        data: audioBuffer.toString('base64'),
      },
    });
    parts.push({
      text: `${ctxString}${histText}\n${langRule}\nListen carefully to this voice message${cleanText ? ` (user note: "${cleanText}")` : ''} and respond in JSON:`,
    });
  } else {
    parts.push({
      text: `${ctxString}${histText}\n${langRule}\nUser Message: "${cleanText}"\n\nRespond in JSON:`,
    });
  }

  try {
    const rawResult = await callGemini({ contents: [{ parts }] });
    const result = cleanJson(rawResult);

    if (!result || typeof result !== 'object') {
      const fb = fallbackResponse('parse', fbLang);
      return {
        transcription: cleanText,
        summary: fb.reply,
        reply: fb.reply,
        actions: [],
        suggestedChips: fb.chips,
      };
    }

    const reply = result.reply || result.summary || '';
    return {
      transcription: String(result.transcription || cleanText || '').trim(),
      summary: reply,
      reply,
      actions: normalizeActions(result.actions),
      suggestedChips: Array.isArray(result.suggestedChips) ? result.suggestedChips.slice(0, 4) : [],
    };
  } catch (err) {
    console.error('[Gemini AI error]:', err?.message);
    const fb = fallbackResponse('error', fbLang);
    return {
      transcription: cleanText,
      summary: fb.reply,
      reply: fb.reply,
      actions: [],
      suggestedChips: fb.chips,
    };
  }
}

/**
 * Analyzes text or raw audio buffer into structured household actions using Gemini.
 */
export function analyzeWithGemini({ text, audioBuffer, mimeType = 'audio/webm', speechLang = '', context = {} }) {
  return runAssistant({ message: text || '', audioBuffer, mimeType, speechLang, context });
}

/**
 * Agentic Household Assistant with live family context and recent conversation history.
 */
export function agenticFamilyAssistant({ message = '', audioBuffer, mimeType = 'audio/webm', speechLang = '', context = {}, history = [] }) {
  return runAssistant({ message, audioBuffer, mimeType, speechLang, context, history });
}
