import https from 'https';
import { config } from '../config.js';

function callGemini(payload) {
  return new Promise((resolve, reject) => {
    const key = config.geminiApiKey;
    if (!key) {
      return reject(new Error('GEMINI_API_KEY is not configured on the server'));
    }

    // The key travels in a header, never in the URL (URLs end up in logs and proxies).
    const path = `/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`;
    const dataString = JSON.stringify(payload);

    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataString),
          'x-goog-api-key': key,
        },
        timeout: 25_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Gemini API error (${res.statusCode}): ${body.slice(0, 300)}`));
          }
          try {
            const parsed = JSON.parse(body);
            const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Failed to parse Gemini response: ${e.message}`));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Gemini request timed out')));
    req.on('error', (err) => reject(err));
    req.write(dataString);
    req.end();
  });
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

function formatContext(context = {}) {
  const neededGroceriesSummary = (context.neededGroceries || []).map((g) => `${g.name}${g.qty ? ` (${g.qty})` : ''}`).join(', ') || 'None';
  const inStockSummary = (context.inStockGroceries || []).map((g) => `${g.name}${g.qty ? ` (${g.qty})` : ''}`).join(', ') || 'None';
  const tasksSummary = (context.openTasks || []).map((t) => `ID:${t._id || t.id} - ${t.title}${t.assigneeName ? ` (for ${t.assigneeName})` : ''}${t.dueDate ? ` due ${t.dueDate}` : ''}`).join('; ') || 'No open tasks';
  const medicinesSummary = (context.todayMedicines || []).map((m) => `${m.forName || 'Member'}: ${m.name} at ${m.time || 'scheduled'} (${m.dosage || '1 dose'}) - Status: ${m.status || 'pending'}`).join('; ') || 'No medicines scheduled today';
  const expensesBreakdown = Object.entries(context.monthlyExpenseCategories || {}).map(([cat, amt]) => `${cat}: ₹${amt}`).join(', ') || 'None';
  const billsSummary = (context.upcomingBills || []).map((b) => `${b.title} due ${b.dueDate}${b.amount != null ? ` (₹${b.amount})` : ''}`).join('; ') || 'No bills due soon';
  const membersSummary = (context.familyMembers || []).map((m) => `${m.name} (relation: ${m.relation || 'member'})`).join(', ') || 'Family members';

  return `LIVE HOUSEHOLD GROUND-TRUTH:
- Today's Date: ${context.todayStr || new Date().toISOString().slice(0, 10)}
- Tomorrow's Date: ${context.tomorrowStr || new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
- Family Members: ${membersSummary}
- Needed Groceries (to buy): ${neededGroceriesSummary}
- Kitchen Inventory (already in stock): ${inStockSummary}
- Open Tasks: ${tasksSummary}
- Today's Medicines: ${medicinesSummary}
- Bills due within 14 days: ${billsSummary}
- Current Month Expenses: ₹${context.monthlyExpenseTotal || 0} (${expensesBreakdown})`;
}

const COMPOUND_PROMPT = `You are Hommi AI, a friendly, intelligent household assistant.

LANGUAGE RULE (CRITICAL — ALWAYS OBEY):
- ALWAYS respond in the EXACT language the user wrote or spoke in THIS LATEST message/audio.
- Ignore the app UI language setting and ignore the language of earlier turns in conversation history if the current message uses a different language.
- If the user wrote/spoke English -> respond 100% in English (reply, ingredient names, step text, shop names, headings, and suggestedChips MUST all be English).
- If the user wrote/spoke Malayalam (Malayalam script or Manglish) -> respond in natural Malayalam.
- If the user wrote/spoke Tamil or Hindi -> respond in Tamil or Hindi respectively.

CRITICAL HOUSEHOLD RULES:
1. Multi-Intent Compound Handling:
   When user asks to prepare or cook a dish (e.g. "how to make biryani", "suggest biryani recipe, add to recipe, add tomorrow meals, and add grocery list..."):
   a) Suggest the recipe clearly in your reply with key ingredients and numbered steps (include realistic duration for every cooking step, e.g., "Marinate chicken for 30 min", "Sauté onions (~10 min)").
   b) Action "add_recipe": create recipe with title, ingredients list ({ name, qty }), and steps array (each step including realistic cooking time).
   c) Action "add_meal": schedule the meal (e.g. for tomorrow date, slot "noon" or "night", cookName matching one of the Family Members).
   d) Action "add_calendar_event": schedule a calendar reminder for the meal with dueDate and assigneeName tagged.
   e) Action "add_grocery": break down missing ingredients into individual items (concise item titles under 60 chars, NEVER giant strings in title).
      Cross-check against Kitchen Inventory! For in-stock ingredients in the reply, mark them cleanly as "(Already available in your kitchen)" (or local language equivalent when responding in Malayalam/Hindi/Tamil), and only add missing ones to grocery actions.
      SHOP GROUPING: Assign realistic shop names matching the reply language:
      - "Vegetable Stall": Onions, tomatoes, green chillies, ginger, garlic, coriander, mint, vegetables.
      - "Meat & Poultry Stall": Chicken, mutton, beef, fish, seafood.
      - "Supermarket / Grocery": Basmati/Kaima rice, ghee, curd, whole spices, biryani masala, dry fruits, grocery essentials.
      - "Dairy & Bakery": Milk, bread, eggs.
      - "Medical Store": Tablets, medicines.
      Assign intelligent category ("vegetables", "meat", "spices", "dairy", "pantry", "household", "medical", "other").

2. Single Intent & Queries:
   - What to buy: Summarize Needed Groceries.
   - What's in my kitchen: Summarize in-stock items.
   - Monthly expense: Report ground-truth expense total and breakdown.
   - Tasks: Summarize open tasks.
   - Add task: Action "add_task" with title, optional dueDate, optional assigneeName.
   - Delete task: Action "delete_task" with targetId matching the task ID.
   - Medicine: Report medicine status.

3. Formatting Rules:
   - Clean titles: titles must be concise item/task names (e.g. "Biryani Rice", "Chicken", "Onions"), NOT paragraphs.
   - Quantities go into "quantity" (e.g. "1 kg", "500 g", "1 bunch").
   - Amounts must be pure numbers in INR (e.g. 850, not "Rs 850").

OUTPUT FORMAT:
Respond strictly in JSON without markdown codeblocks or backticks:
{
  "transcription": "<spoken transcription or typed text>",
  "reply": "<Friendly, clear explanation in the SAME language as this latest user message>",
  "actions": [
    {
      "type": "add_grocery" | "add_task" | "delete_task" | "add_expense" | "add_meal" | "add_recipe" | "add_calendar_event" | "bill",
      "title": "<concise title under 80 chars>",
      "quantity": "<e.g. 1 kg, or null>",
      "category": "<e.g. vegetables, meat, dairy, spices, pantry, etc.>",
      "shop": "<e.g. Vegetable Stall, Meat & Poultry Stall, Supermarket / Grocery, etc.>",
      "amount": <number or null>,
      "date": "<YYYY-MM-DD or null>",
      "dueDate": "<YYYY-MM-DD or null>",
      "slot": "morning" | "noon" | "night" | null,
      "cookName": "<member name or null>",
      "assigneeName": "<member name or null>",
      "targetId": "<task id if delete_task, or null>",
      "ingredients": [ { "name": "<item>", "qty": "<quantity>" } ],
      "steps": [ "<step 1>", "<step 2>" ]
    }
  ],
  "suggestedChips": ["<short follow-up 1 in same language>", "<short follow-up 2 in same language>"]
}`;

const MANGLISH_RE = /\b(entha|enthu|enthokke|engane|undakkam|cheyyam|evide|enna|aano|alle|vendath|vaangan|chilavu|veetil|chaya|kanji|choru|curry|ari|meen|irachi|pachakkari|innathe|naale|innale|ningal|njan|njammale)\b/i;

function detectMessageLang(msg, fallback = 'en') {
  const s = String(msg || '').trim();
  if (!s) return fallback || 'en';
  if (/[\u0D00-\u0D7F]/.test(s)) return 'ml';
  if (/[\u0B80-\u0BFF]/.test(s)) return 'ta';
  if (/[\u0900-\u097F]/.test(s)) return 'hi';
  if (MANGLISH_RE.test(s)) return 'ml';
  return 'en';
}

function languageDirective({ text = '', audioBuffer = null }) {
  if (audioBuffer && audioBuffer.length > 0 && !String(text || '').trim()) {
    return 'LANGUAGE INSTRUCTION: Detect the spoken language in this audio message (English, Malayalam, Tamil, Hindi, etc.) and write "reply", "ingredients", "steps", and "suggestedChips" strictly in that same spoken language.';
  }
  const detected = detectMessageLang(text);
  const label = detected === 'ml'
    ? 'Malayalam (user wrote Malayalam/Manglish)'
    : detected === 'ta'
    ? 'Tamil'
    : detected === 'hi'
    ? 'Hindi'
    : 'English (user wrote English — reply 100% in English, NOT Malayalam)';
  return `LANGUAGE INSTRUCTION: Respond strictly in ${label}.`;
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

/**
 * Analyzes text or raw audio buffer using Gemini.
 */
export async function analyzeWithGemini({ text, audioBuffer, mimeType = 'audio/webm', context = {} }) {
  const parts = [];
  const ctxString = formatContext(context);
  const langRule = languageDirective({ text, audioBuffer });
  const fbLang = detectMessageLang(text, context.uiLang || 'en');

  if (audioBuffer && audioBuffer.length > 0) {
    const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim();
    parts.push({
      inlineData: {
        mimeType: cleanMime,
        data: audioBuffer.toString('base64'),
      },
    });
    parts.push({
      text: `${COMPOUND_PROMPT}\n\n${ctxString}\n\n${langRule}\nListen carefully to this audio voice note from a family member and extract actionable household tasks into JSON:`,
    });
  } else if (text && text.trim().length > 0) {
    parts.push({
      text: `${COMPOUND_PROMPT}\n\n${ctxString}\n\n${langRule}\nAnalyze this message from a family member and extract actionable household tasks into JSON:\n"${text.trim()}"`,
    });
  } else {
    throw new Error('Either text or audio is required for AI analysis');
  }

  try {
    const rawResult = await callGemini({ contents: [{ parts }] });
    const result = cleanJson(rawResult);

    if (!result || typeof result !== 'object') {
      const fb = fallbackResponse('parse', fbLang);
      return {
        transcription: text || '',
        summary: fb.reply,
        reply: fb.reply,
        actions: [],
        suggestedChips: fb.chips,
      };
    }

    return {
      transcription: result.transcription || text || '',
      summary: result.reply || result.summary || '',
      reply: result.reply || result.summary || '',
      actions: Array.isArray(result.actions)
        ? result.actions.filter((a) => a && typeof a.title === 'string' && a.title.trim().length > 0)
        : [],
      suggestedChips: Array.isArray(result.suggestedChips) ? result.suggestedChips : [],
    };
  } catch (err) {
    console.error('[Gemini AI analyze error]:', err?.message);
    const fb = fallbackResponse('error', fbLang);
    return {
      transcription: text || '',
      summary: fb.reply,
      reply: fb.reply,
      actions: [],
      suggestedChips: fb.chips,
    };
  }
}

/**
 * Agentic Household Assistant with full live family context and history.
 */
export async function agenticFamilyAssistant({ message = '', audioBuffer, mimeType = 'audio/webm', context = {}, history = [] }) {
  const parts = [];
  const ctxString = formatContext(context);
  const langRule = languageDirective({ text: message, audioBuffer });
  const fbLang = detectMessageLang(message, context.uiLang || 'en');

  let histText = '';
  if (history.length > 0) {
    histText = `\nRecent Conversation History (for topic context only; always follow THIS latest message's language):\n${history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n')}\n`;
  }

  if (audioBuffer && audioBuffer.length > 0) {
    const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim();
    parts.push({
      inlineData: {
        mimeType: cleanMime,
        data: audioBuffer.toString('base64'),
      },
    });
    parts.push({
      text: `${COMPOUND_PROMPT}\n\n${ctxString}${histText}\n${langRule}\nListen carefully to this voice note from the user and respond in JSON:`,
    });
  } else {
    parts.push({
      text: `${COMPOUND_PROMPT}\n\n${ctxString}${histText}\n${langRule}\nUser Message: "${(message || '').trim()}"\n\nRespond in JSON:`,
    });
  }

  try {
    const rawResult = await callGemini({ contents: [{ parts }] });
    const result = cleanJson(rawResult);

    if (!result || typeof result !== 'object') {
      const fb = fallbackResponse('parse', fbLang);
      return {
        transcription: '',
        reply: fb.reply,
        actions: [],
        suggestedChips: fb.chips,
      };
    }

    return {
      transcription: result.transcription || '',
      reply: result.reply || result.summary || '',
      actions: Array.isArray(result.actions) ? result.actions : [],
      suggestedChips: Array.isArray(result.suggestedChips) ? result.suggestedChips : [],
    };
  } catch (err) {
    console.error('[Gemini AI agent error]:', err?.message);
    const fb = fallbackResponse('error', fbLang);
    return {
      transcription: '',
      reply: fb.reply,
      actions: [],
      suggestedChips: fb.chips,
    };
  }
}
