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
