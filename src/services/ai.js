import https from 'https';
import { config } from '../config.js';

const SYSTEM_PROMPT = `You are Hommi AI, a helpful and accurate intelligent family assistant for households in Kerala and India.
Family members communicate in Malayalam, Manglish (Malayalam in English script), English, Tamil, or Hindi.
Your job is to analyze their spoken voice notes or written messages and extract actionable household tasks.

Categories of Actions:
1. "grocery": Food, groceries, vegetables, milk, essentials to purchase.
2. "task": Chores, house cleaning, errands, repairs, reminders, laundry, trash.
3. "expense": Money spent today (e.g. "auto 80", "fish 300", "petrol 500", "bought eggs 70").
4. "bill": Utility/household bills paid or due (KSEB electricity, water, internet, gas, rent).
5. "meal": Cooking plan for morning, noon, or night.
6. "medicine": Taking tablets/pills or buying medical supplies.

Rules:
- Keep the title and summary natural, clear, and friendly (in Malayalam or English).
- Amounts should be pure numbers in INR (e.g. 850, not "Rs 850").
- If the message is just a casual chat or greeting ("hi", "good morning", "where are you?"), set actions to [].
- Respond with pure JSON only without any markdown formatting or backticks:
{
  "transcription": "<what the user said or typed>",
  "summary": "<friendly 1-line summary in Malayalam or English>",
  "actions": [
    {
      "type": "grocery" | "task" | "expense" | "bill" | "meal" | "medicine",
      "title": "<item or task title>",
      "amount": <number or null>,
      "quantity": "<e.g. 1 kg, 500 ml, 2 packets, or null>"
    }
  ]
}`;

function callGemini(payload) {
  return new Promise((resolve, reject) => {
    const key = config.geminiApiKey;
    if (!key) {
      return reject(new Error('GEMINI_API_KEY is not configured on the server'));
    }

    // gemini-3.5-flash-lite is the fast, free-tier multimodal model
    const path = `/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${encodeURIComponent(key)}`;
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
        },
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

    req.on('error', (err) => reject(err));
    req.write(dataString);
    req.end();
  });
}

function cleanJson(rawText) {
  if (!rawText) return null;
  // Remove ```json and ``` codeblocks if returned
  let cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to locate JSON object substring
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
 * Analyzes text or raw audio buffer using Gemini Flash.
 * @param {Object} opts
 * @param {string} [opts.text] - Plain text message
 * @param {Buffer} [opts.audioBuffer] - Decrypted audio file buffer
 * @param {string} [opts.mimeType] - e.g. 'audio/webm', 'audio/mp4', 'audio/wav'
 */
export async function analyzeWithGemini({ text, audioBuffer, mimeType = 'audio/webm' }) {
  const parts = [];

  if (audioBuffer && audioBuffer.length > 0) {
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: audioBuffer.toString('base64'),
      },
    });
    parts.push({
      text: `${SYSTEM_PROMPT}\n\nListen carefully to this audio voice note from a family member and extract actionable household tasks into JSON:`,
    });
  } else if (text && text.trim().length > 0) {
    parts.push({
      text: `${SYSTEM_PROMPT}\n\nAnalyze this message from a family member and extract actionable household tasks into JSON:\n"${text.trim()}"`,
    });
  } else {
    throw new Error('Either text or audio is required for AI analysis');
  }

  const rawResult = await callGemini({ contents: [{ parts }] });
  const result = cleanJson(rawResult);

  if (!result || typeof result !== 'object') {
    return {
      transcription: text || '',
      summary: 'Could not extract actions from this message',
      actions: [],
    };
  }

  return {
    transcription: result.transcription || text || '',
    summary: result.summary || '',
    actions: Array.isArray(result.actions)
      ? result.actions.filter((a) => a && typeof a.title === 'string' && a.title.trim().length > 0)
      : [],
  };
}

/**
 * Agentic Household Assistant with full live family context.
 * Understands what to buy, kitchen inventory, recipes, missing items, tasks, expenses, and medicines.
 */
export async function agenticFamilyAssistant({ message = '', audioBuffer, mimeType = 'audio/webm', context = {}, history = [] }) {
  const parts = [];

  const neededGroceriesSummary = (context.neededGroceries || []).map((g) => `${g.name}${g.qty ? ` (${g.qty})` : ''}`).join(', ') || 'None';
  const inStockSummary = (context.inStockGroceries || []).map((g) => `${g.name}${g.qty ? ` (${g.qty})` : ''}`).join(', ') || 'None';
  const tasksSummary = (context.openTasks || []).map((t) => `ID:${t._id || t.id} - ${t.title}${t.assigneeId?.displayName ? ` (for ${t.assigneeId.displayName})` : ''}`).join('; ') || 'No open tasks';
  const medicinesSummary = (context.todayMedicines || []).map((m) => `${m.forMemberId?.displayName || 'Member'}: ${m.name} at ${m.time || 'scheduled'} (${m.dosage || '1 dose'}) - Status: ${m.status || 'pending'}`).join('; ') || 'No medicines scheduled today';
  const expensesBreakdown = Object.entries(context.monthlyExpenseCategories || {}).map(([cat, amt]) => `${cat}: ₹${amt}`).join(', ') || 'None';

  const agentPrompt = `You are Hommi AI, a friendly, intelligent, and proactive household assistant for a family.
Family members communicate in Malayalam, Manglish (Malayalam in English script), English, Tamil, or Hindi.
Respond in the language the user used (default to natural Malayalam/Manglish if Malayalam was used, or English if English was used). Keep responses concise, warm, helpful, and clear.

LIVE HOUSEHOLD GROUND-TRUTH CONTEXT:
1. Needed Groceries (Items to buy): ${neededGroceriesSummary}
2. Kitchen Inventory (Items in stock at home): ${inStockSummary}
3. Open Tasks: ${tasksSummary}
4. Today's Medicines & Status: ${medicinesSummary}
5. Current Month Total Expenses: ₹${context.monthlyExpenseTotal || 0} (Breakdown: ${expensesBreakdown})
6. Today's Planned Meals: ${JSON.stringify(context.todayMeals || [])}
7. Upcoming Bills: ${JSON.stringify(context.upcomingBills || [])}

YOUR AGENTIC CAPABILITIES:
1. Groceries & Kitchen:
   - "What to buy / എന്തൊക്കെ വാങ്ങാനുണ്ട്?": List the currently Needed Groceries.
   - "What's in my kitchen / അടുക്കളയിൽ എന്തൊക്കെയുണ്ട്?": List the items currently in stock in the kitchen.
2. Smart Recipe & Missing-Ingredients:
   - When user asks to make a recipe (e.g. "I want to make biriyani / ബിരിയാണി ഉണ്ടാക്കണം", "സാമ്പാർ ഉണ്ടാക്കണം", "ദോശ..."):
     a) List key ingredients required for the dish.
     b) Cross-check with Kitchen Inventory (items in stock). Explicitly state which ingredients are ALREADY at home ("നിങ്ങളുടെ അടുക്കളയിൽ [items] ഉണ്ട്").
     c) Identify which ingredients are MISSING.
     d) Propose "add_grocery" actions ONLY for the missing ingredients.
     e) DYNAMIC CATEGORIZATION: For each item, assign an intelligent category (e.g. "vegetables", "dairy", "spices", "meat", "pantry", "bakery", "fruits", "household") using AI common sense (NOT fixed rules).
3. Tasks:
   - If asked what tasks are pending, summarize from Open Tasks.
   - If asked to add a task, propose an "add_task" action with title.
   - If asked to delete/complete a task, match from Open Tasks and propose a "delete_task" action with targetId!
4. Monthly Expense:
   - If asked about expenses / spending ("ഈ മാസം എത്ര ചിലവായി?"), report the exact ground-truth total (₹${context.monthlyExpenseTotal || 0}) and category breakdown.
5. Medicine Tracking:
   - If asked about medicines today ("മരുന്ന് കഴിച്ചോ?", "ഇന്ന് എന്തൊക്കെ മരുന്നുണ്ട്?"), report the schedule, dosage, and status.

OUTPUT FORMAT:
Respond strictly in JSON without markdown codeblocks or backticks:
{
  "transcription": "<if audio was provided, the transcribed text, else empty string>",
  "reply": "<Friendly, clear conversational answer in user's language>",
  "actions": [
    {
      "type": "add_grocery" | "add_task" | "delete_task" | "add_expense",
      "title": "<item or task title>",
      "category": "<dynamic category like vegetables, dairy, spices, meat, etc.>",
      "quantity": "<optional e.g. 1 kg, 500 ml, or null>",
      "amount": <number or null>,
      "targetId": "<id of item if delete_task>"
    }
  ],
  "suggestedChips": ["<short relevant follow-up question or chip 1>", "<short relevant follow-up question or chip 2>"]
}`;

  if (audioBuffer && audioBuffer.length > 0) {
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: audioBuffer.toString('base64'),
      },
    });
    parts.push({
      text: `${agentPrompt}\n\nListen carefully to this voice note from the user and respond in JSON:`,
    });
  } else {
    let histText = '';
    if (history.length > 0) {
      histText = `\nRecent Conversation History:\n${history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n')}\n`;
    }
    parts.push({
      text: `${agentPrompt}${histText}\nUser Message: "${(message || '').trim()}"\n\nRespond in JSON:`,
    });
  }

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
    reply: result.reply || '',
    actions: Array.isArray(result.actions) ? result.actions : [],
    suggestedChips: Array.isArray(result.suggestedChips) ? result.suggestedChips : [],
  };
}

