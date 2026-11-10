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

const COMPOUND_PROMPT = `You are Hommi AI, a friendly, intelligent, proactive family assistant for households in Kerala and India.
Family members communicate in Malayalam, Manglish (Malayalam in English script), English, Tamil, or Hindi.
Respond in the language the user used (default to natural Malayalam/Manglish if Malayalam was used, or English if English was used).

CRITICAL HOUSEHOLD RULES:
1. Multi-Intent Compound Handling:
   When user asks to prepare or cook a dish (e.g. "suggest biryani recipe, add to recipe, add tomorrow meals, and add grocery list grouped by shop..."):
   a) Suggest the recipe clearly in your reply with key ingredients and simple steps.
   b) Action "add_recipe": create recipe with title, ingredients list ({ name, qty }), and steps array.
   c) Action "add_meal": schedule the meal (e.g. for tomorrow date, slot "noon" or "night", cookName matching one of the Family Members).
   d) Action "add_calendar_event": schedule a calendar reminder for the meal with dueDate and assigneeName tagged.
   e) Action "add_grocery": break down missing ingredients into individual items (concise item titles under 60 chars, NEVER giant strings in title).
      Cross-check against Kitchen Inventory! If an ingredient is already in stock, mention in reply that it is already in the kitchen, and only add missing ones.
      SHOP GROUPING: Assign realistic shop names based on Kerala/Indian shopping habits:
      - "Vegetable Stall" (പച്ചക്കറി കട): Onions, tomatoes, green chillies, ginger, garlic, coriander, mint, vegetables.
      - "Meat & Poultry Stall" (ഇറച്ചി / മീൻ കട): Chicken, mutton, beef, fish, seafood.
      - "Supermarket / Grocery" (പലചരക്ക് കട): Basmati/Kaima rice, ghee, curd, whole spices, biryani masala, dry fruits, grocery essentials.
      - "Dairy & Bakery" (ബേക്കറി / മിൽമ): Milk, bread, eggs.
      - "Medical Store" (മെഡിക്കൽ സ്റ്റോർ): Tablets, medicines.
      Assign intelligent category ("vegetables", "meat", "spices", "dairy", "pantry", "household", "medical", "other").

2. Single Intent & Queries:
   - "What to buy? / എന്തൊക്കെ വാങ്ങാനുണ്ട്?": Summarize Needed Groceries.
   - "What's in my kitchen? / അടുക്കളയിൽ എന്തൊക്കെയുണ്ട്?": Summarize in-stock items.
   - "Monthly expense / ഈ മാസത്തെ ചിലവ്": Report ground-truth expense total and breakdown.
   - "Tasks / ജോലികൾ": Summarize open tasks.
   - "Add task / ജോലി": Action "add_task" with title, optional dueDate, optional assigneeName.
   - "Delete task": Action "delete_task" with targetId matching the task ID.
   - "Medicine / മരുന്ന്": Report medicine status.

3. Formatting Rules:
   - Clean titles: titles must be concise item/task names (e.g. "Biryani Rice", "Chicken", "Onions"), NOT paragraphs.
   - Quantities go into "quantity" (e.g. "1 kg", "500 g", "1 bunch").
   - Amounts must be pure numbers in INR (e.g. 850, not "Rs 850").

OUTPUT FORMAT:
Respond strictly in JSON without markdown codeblocks or backticks:
{
  "transcription": "<spoken transcription or typed text>",
  "reply": "<Friendly, clear explanation in user's language>",
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
  "suggestedChips": ["<short follow-up 1>", "<short follow-up 2>"]
}`;

/**
 * Analyzes text or raw audio buffer using Gemini.
 */
export async function analyzeWithGemini({ text, audioBuffer, mimeType = 'audio/webm', context = {} }) {
  const parts = [];
  const ctxString = formatContext(context);

  if (audioBuffer && audioBuffer.length > 0) {
    const cleanMime = (mimeType || 'audio/webm').split(';')[0].trim();
    parts.push({
      inlineData: {
        mimeType: cleanMime,
        data: audioBuffer.toString('base64'),
      },
    });
    parts.push({
      text: `${COMPOUND_PROMPT}\n\n${ctxString}\n\nListen carefully to this audio voice note from a family member and extract actionable household tasks into JSON:`,
    });
  } else if (text && text.trim().length > 0) {
    parts.push({
      text: `${COMPOUND_PROMPT}\n\n${ctxString}\n\nAnalyze this message from a family member and extract actionable household tasks into JSON:\n"${text.trim()}"`,
    });
  } else {
    throw new Error('Either text or audio is required for AI analysis');
  }

  try {
    const rawResult = await callGemini({ contents: [{ parts }] });
    const result = cleanJson(rawResult);

    if (!result || typeof result !== 'object') {
      return {
        transcription: text || '',
        summary: 'Could not extract actions from this message',
        reply: 'Could not extract actions from this message',
        actions: [],
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
    return {
      transcription: text || '',
      summary: 'ക്ഷമിക്കണം, എഐ പ്രോസസ്സ് ചെയ്യുന്നതിൽ തടസ്സമുണ്ടായി. ദയവായി വീണ്ടും ശ്രമിക്കുക.',
      reply: 'ക്ഷമിക്കണം, എഐ പ്രോസസ്സ് ചെയ്യുന്നതിൽ തടസ്സമുണ്ടായി. ദയവായി വീണ്ടും ശ്രമിക്കുക.',
      actions: [],
      suggestedChips: ['എന്തൊക്കെ വാങ്ങാനുണ്ട്?', 'ഈ മാസത്തെ ചിലവ് എത്ര?'],
    };
  }
}

/**
 * Agentic Household Assistant with full live family context and history.
 */
export async function agenticFamilyAssistant({ message = '', audioBuffer, mimeType = 'audio/webm', context = {}, history = [] }) {
  const parts = [];
  const ctxString = formatContext(context);

  let histText = '';
  if (history.length > 0) {
    histText = `\nRecent Conversation History:\n${history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n')}\n`;
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
      text: `${COMPOUND_PROMPT}\n\n${ctxString}${histText}\n\nListen carefully to this voice note from the user and respond in JSON:`,
    });
  } else {
    parts.push({
      text: `${COMPOUND_PROMPT}\n\n${ctxString}${histText}\nUser Message: "${(message || '').trim()}"\n\nRespond in JSON:`,
    });
  }

  try {
    const rawResult = await callGemini({ contents: [{ parts }] });
    const result = cleanJson(rawResult);

    if (!result || typeof result !== 'object') {
      return {
        transcription: '',
        reply: 'ക്ഷമിക്കണം, എനിക്ക് അത് മനസ്സിലാക്കാൻ സാധിച്ചില്ല. ദയവായി ഒന്നുകൂടി പറയാമോ?',
        actions: [],
        suggestedChips: ['എന്തൊക്കെ വാങ്ങാനുണ്ട്?', 'ഈ മാസത്തെ ചിലവ് എത്ര?'],
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
    return {
      transcription: '',
      reply: 'ക്ഷമിക്കണം, എഐ പ്രോസസ്സ് ചെയ്യുന്നതിൽ തടസ്സമുണ്ടായി. ദയവായി വീണ്ടും ശ്രമിക്കുക.',
      actions: [],
      suggestedChips: ['എന്തൊക്കെ വാങ്ങാനുണ്ട്?', 'ഈ മാസത്തെ ചിലവ് എത്ര?'],
    };
  }
}
