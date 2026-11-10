import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { formatContext, agenticFamilyAssistant, analyzeWithGemini } from '../src/services/ai.js';
import { sniff } from '../src/routes/documents.js';

function withMockedGemini(handler) {
  const prevFetch = globalThis.fetch;
  const prevKey = config.geminiApiKey;
  const prevModel = config.geminiModel;
  config.geminiApiKey = 'test-gemini-key';
  config.geminiModel = 'gemini-3.5-flash-lite';
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = prevFetch;
    config.geminiApiKey = prevKey;
    config.geminiModel = prevModel;
  };
}

test('formatContext includes planned meals with cook names', () => {
  const txt = formatContext({
    todayStr: '2026-11-10',
    tomorrowStr: '2026-11-11',
    familyMembers: [{ name: 'Anandhu', relation: 'owner' }],
    todayMeals: [
      { date: '2026-11-10', slot: 'noon', items: ['Fish Curry', 'Rice'], cookName: 'Anandhu' },
    ],
    monthlyExpenseTotal: 2500,
    monthlyExpenseCategories: { groceries: 2500 },
  });
  assert.match(txt, /Meals Planned \(Today\/Tomorrow\): 2026-11-10 noon: Fish Curry, Rice \(cook: Anandhu\)/);
  assert.match(txt, /Month Expenses: ₹2500 \(groceries: ₹2500\)/);
});

test('agenticFamilyAssistant sends structured schema, systemInstruction, minimal thinking, and compacted history', async () => {
  let capturedBody = null;
  let capturedUrl = '';
  const restore = withMockedGemini(async (url, opts) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(opts.body);
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    transcription: 'Buy 1 kg onions',
                    reply: 'Added onions to your grocery list.',
                    actions: [{ type: 'add_grocery', title: 'Onions', quantity: '1 kg', category: 'vegetables', shop: 'Vegetable Stall' }],
                    suggestedChips: ['What to buy?'],
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200 }
    );
  });

  try {
    const longHistory = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'x'.repeat(500) },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'turn 3' },
      { role: 'assistant', content: 'reply 3' },
    ];
    const res = await agenticFamilyAssistant({
      message: 'Buy 1 kg onions',
      context: { todayStr: '2026-11-10', tomorrowStr: '2026-11-11' },
      history: longHistory,
    });

    assert.match(capturedUrl, /gemini-3\.5-flash-lite:generateContent/);
    assert.ok(capturedBody.systemInstruction?.parts?.[0]?.text?.includes('Hommi AI'));
    assert.match(capturedBody.systemInstruction.parts[0].text, /actions\[\]\.title/);
    assert.equal(capturedBody.generationConfig.responseMimeType, 'application/json');
    assert.equal(capturedBody.generationConfig.responseSchema.type, 'OBJECT');
    assert.equal(capturedBody.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');

    // Only last 4 history turns should be included
    const userPrompt = capturedBody.contents[0].parts[0].text;
    assert.ok(!userPrompt.includes('turn 1'));
    assert.ok(userPrompt.includes('turn 2'));

    assert.equal(res.reply, 'Added onions to your grocery list.');
    assert.equal(res.actions.length, 1);
    assert.equal(res.actions[0].title, 'Onions');
  } finally {
    restore();
  }
});

test('agenticFamilyAssistant retries once on transient 503 and handles direct audio inlineData', async () => {
  let calls = 0;
  let capturedBody = null;
  const restore = withMockedGemini(async (_url, opts) => {
    calls++;
    capturedBody = JSON.parse(opts.body);
    if (calls === 1) {
      return new Response('Service temporarily unavailable', { status: 503 });
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    transcription: 'നാളെ പാൽ വാങ്ങണം',
                    reply: 'നാളത്തേക്ക് പാൽ ലിസ്റ്റിൽ ചേർക്കാം.',
                    actions: [{ type: 'add_grocery', title: 'പാൽ', quantity: '1 L', category: 'dairy', shop: 'Dairy & Bakery' }],
                    suggestedChips: ['എന്തൊക്കെ വാങ്ങാനുണ്ട്?'],
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200 }
    );
  });

  try {
    const fakeWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    assert.equal(sniff(fakeWebm), 'audio/webm');

    const res = await analyzeWithGemini({
      audioBuffer: fakeWebm,
      mimeType: 'audio/webm;codecs=opus',
      speechLang: 'ml-IN',
      context: { uiLang: 'ml', todayStr: '2026-11-10', tomorrowStr: '2026-11-11' },
    });

    assert.equal(calls, 2);
    assert.equal(capturedBody.contents[0].parts[0].inlineData.mimeType, 'audio/webm');
    assert.equal(capturedBody.contents[0].parts[0].inlineData.data, fakeWebm.toString('base64'));
    assert.match(capturedBody.contents[0].parts[1].text, /ml-IN/);
    assert.equal(res.transcription, 'നാളെ പാൽ വാങ്ങണം');
    assert.equal(res.actions[0].title, 'പാൽ');
  } finally {
    restore();
  }
});

test('agenticFamilyAssistant returns localized error fallback without retrying on 400', async () => {
  let calls = 0;
  const restore = withMockedGemini(async () => {
    calls++;
    return new Response('Bad request', { status: 400 });
  });

  try {
    const res = await agenticFamilyAssistant({
      message: 'പാൽ വാങ്ങണം',
      context: { uiLang: 'ml' },
    });
    assert.equal(calls, 1);
    assert.equal(res.actions.length, 0);
    assert.match(res.reply, /ക്ഷമിക്കണം/);
  } finally {
    restore();
  }
});

test('Manglish phrases and audio prompt rules select Malayalam over English/Tamil', async () => {
  const captured = [];
  const restore = withMockedGemini(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    captured.push(body);
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    transcription: 'നാളെ മോർണിംഗ് ബ്രേക്ക്ഫാസ്റ്റ് പുട്ടാണേ',
                    reply: 'നാളെ രാവിലെ പുട്ട് തയ്യാറാക്കാം.',
                    actions: [],
                    suggestedChips: [],
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200 }
    );
  });

  try {
    await agenticFamilyAssistant({ message: 'Naale morning breakfast puttaane', context: { uiLang: 'en' } });
    await agenticFamilyAssistant({ message: 'paal venam', context: { uiLang: 'en' } });
    await agenticFamilyAssistant({ message: 'How to make biryani', context: { uiLang: 'en' } });

    assert.match(captured[0].systemInstruction.parts[0].text, /Malayalam \/ Manglish vs Tamil disambiguation/);
    assert.match(captured[0].contents[0].parts[0].text, /LANGUAGE: Respond strictly in Malayalam\./);
    assert.match(captured[1].contents[0].parts[0].text, /LANGUAGE: Respond strictly in Malayalam\./);
    assert.match(captured[2].contents[0].parts[0].text, /LANGUAGE: Respond strictly in English/);
  } finally {
    restore();
  }
});

