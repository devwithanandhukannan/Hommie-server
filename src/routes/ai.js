import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, notFound } from '../lib/errors.js';
import { validate, oid, optText } from '../lib/validate.js';
import { decryptFile } from '../lib/crypto.js';
import { aiLimiter } from '../middleware/security.js';
import { Attachment, GroceryItem, Task, Expense, Bill, ChatMessage } from '../models/index.js';
import { analyzeWithGemini } from '../services/ai.js';
import { loadMembers } from '../services/members.js';
import { chatDto } from '../dto.js';

export const ai = Router();

ai.use(aiLimiter);

/**
 * Analyzes a text message or an audio attachment using Gemini AI.
 * Returns the extracted actions (grocery, task, expense, bill, meal, medicine).
 */
ai.post(
  '/analyze',
  validate({
    body: z
      .object({
        text: optText(1000),
        attachmentId: oid.optional(),
      })
      .strict()
      .refine((b) => (b.text && b.text.trim().length > 0) || b.attachmentId, {
        message: 'Either text or attachmentId is required',
      }),
  }),
  h(async (req, res) => {
    const { text, attachmentId } = req.valid.body;
    let audioBuffer = null;
    let mimeType = 'audio/webm';

    if (attachmentId) {
      const a = await Attachment.findOne({
        _id: attachmentId,
        familyId: req.ctx.familyId,
      }).select('+data +enc');

      if (!a) throw notFound('Audio attachment not found');
      if (!a.mime?.startsWith('audio/')) throw badRequest('Attachment must be an audio file');

      try {
        audioBuffer = decryptFile(a.data, a.enc);
      } catch {
        throw new Error('Could not decrypt audio attachment');
      }
      mimeType = a.mime;
    }

    const result = await analyzeWithGemini({ text, audioBuffer, mimeType });
    res.json(result);
  })
);

/**
 * Applies the approved actions directly into the family database.
 */
ai.post(
  '/apply',
  validate({
    body: z
      .object({
        actions: z.array(
          z.object({
            type: z.enum(['grocery', 'task', 'expense', 'bill', 'meal', 'medicine']),
            title: z.string().min(1).max(120),
            amount: z.number().nullable().optional(),
            quantity: z.string().max(30).nullable().optional(),
            dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          })
        ).min(1).max(15),
        notifyInChat: z.boolean().default(true),
      })
      .strict(),
  }),
  h(async (req, res) => {
    const { actions, notifyInChat } = req.valid.body;
    const familyId = req.ctx.familyId;
    const me = req.ctx.me;
    const added = [];

    const todayStr = new Date().toISOString().slice(0, 10);

    for (const a of actions) {
      const cleanTitle = a.title.trim();
      if (!cleanTitle) continue;

      if (a.type === 'grocery') {
        const nameKey = cleanTitle.toLowerCase();
        let item = await GroceryItem.findOne({ familyId, nameKey });
        if (item) {
          item.status = 'needed';
          if (a.quantity) item.qty = a.quantity;
          await item.save();
        } else {
          item = await GroceryItem.create({
            familyId,
            name: cleanTitle,
            nameKey,
            qty: a.quantity || '',
            status: 'needed',
            addedBy: me,
          });
        }
        added.push({ type: 'grocery', id: String(item._id), title: cleanTitle });
      } else if (a.type === 'task') {
        const task = await Task.create({
          familyId,
          title: cleanTitle,
          kind: 'custom',
          assigneeId: null,
          createdBy: me,
          dueDate: a.dueDate || undefined,
          status: 'open',
        });
        added.push({ type: 'task', id: String(task._id), title: cleanTitle });
      } else if (a.type === 'expense' && a.amount && a.amount > 0) {
        const exp = await Expense.create({
          familyId,
          amount: Math.round(a.amount * 100), // in paise
          note: cleanTitle,
          date: todayStr,
          paidById: me,
          createdBy: me,
          source: 'manual',
          category: 'other',
        });
        added.push({ type: 'expense', id: String(exp._id), title: cleanTitle, amount: a.amount });
      } else if (a.type === 'bill') {
        const bill = await Bill.create({
          familyId,
          title: cleanTitle,
          category: 'other',
          rule: { unit: 'month', everyN: 1, anchorDate: todayStr },
          createdBy: me,
        });
        added.push({ type: 'bill', id: String(bill._id), title: cleanTitle });
      } else {
        // Fallback: save as a task so nothing is lost
        const task = await Task.create({
          familyId,
          title: cleanTitle,
          kind: 'custom',
          assigneeId: null,
          createdBy: me,
          status: 'open',
        });
        added.push({ type: 'task', id: String(task._id), title: cleanTitle });
      }
    }

    if (notifyInChat && added.length > 0) {
      try {
        const summaryLines = added.map((x) => {
          const icon = x.type === 'grocery' ? '🛒' : x.type === 'expense' ? '💸' : x.type === 'bill' ? '⚡' : '✓';
          const amt = x.amount ? ` (₹${x.amount})` : '';
          return `${icon} ${x.title}${amt}`;
        });

        const sysMsg = await ChatMessage.create({
          familyId,
          senderId: me,
          text: `🤖 Hommi AI added:\n${summaryLines.join('\n')}`,
          type: 'system',
        });
      } catch {
        // ignore notification error
      }
    }

    res.status(201).json({
      success: true,
      count: added.length,
      items: added,
    });
  })
);
