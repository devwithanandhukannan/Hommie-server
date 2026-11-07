import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, notFound } from '../lib/errors.js';
import { validate, oid, optText } from '../lib/validate.js';
import { decryptFile } from '../lib/crypto.js';
import { aiLimiter } from '../middleware/security.js';
import { Attachment, GroceryItem, Task, Expense, Bill, BillInstance, MealPlan, Medicine, MedicineLog, ChatMessage } from '../models/index.js';
import { analyzeWithGemini, agenticFamilyAssistant } from '../services/ai.js';
import { loadMembers } from '../services/members.js';
import { chatDto } from '../dto.js';

export const ai = Router();

ai.use(aiLimiter);

/**
 * Agentic Household Assistant with full live family context.
 * Understands what to buy, kitchen inventory, recipes, missing items, tasks, expenses, and medicines.
 */
ai.post(
  '/agent',
  validate({
    body: z
      .object({
        message: z.string().max(1000).optional(),
        attachmentId: oid.optional(),
        history: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              content: z.string().max(2000),
            })
          )
          .max(20)
          .optional(),
      })
      .strict()
      .refine((b) => (b.message && b.message.trim().length > 0) || b.attachmentId, {
        message: 'Either message or attachmentId is required',
      }),
  }),
  h(async (req, res) => {
    const { message, attachmentId, history } = req.valid.body;
    const familyId = req.ctx.familyId;
    const todayStr = new Date().toISOString().slice(0, 10);
    const currentMonth = todayStr.slice(0, 7);

    let audioBuffer = null;
    let mimeType = 'audio/webm';

    if (attachmentId) {
      const a = await Attachment.findOne({
        _id: attachmentId,
        familyId,
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

    // 1. Needed Groceries & Kitchen Stock (Strictly scoped to familyId)
    const [neededGroceries, inStockGroceries] = await Promise.all([
      GroceryItem.find({ familyId, status: 'needed' }).select('name qty category').limit(50).lean(),
      GroceryItem.find({ familyId, status: 'in_stock' }).select('name qty category').limit(50).lean(),
    ]);

    // 2. Open Tasks
    const openTasks = await Task.find({ familyId, status: 'open' })
      .select('title dueDate kind assigneeId')
      .populate('assigneeId', 'displayName')
      .limit(30)
      .lean();

    // 3. Medicines Today
    const [medicines, medLogs] = await Promise.all([
      Medicine.find({ familyId, active: true }).select('name dosage times instructions forMemberId').populate('forMemberId', 'displayName').lean(),
      MedicineLog.find({ familyId, date: todayStr }).select('medicineId time status').lean(),
    ]);

    const todayMedicines = [];
    for (const med of medicines) {
      for (const time of med.times || []) {
        const log = medLogs.find((l) => String(l.medicineId) === String(med._id) && l.time === time);
        todayMedicines.push({
          id: String(med._id),
          name: med.name,
          dosage: med.dosage,
          time,
          forMemberId: med.forMemberId,
          status: log?.status || 'pending',
        });
      }
    }

    // 4. Monthly Expenses (Strictly scoped to familyId)
    const expenses = await Expense.find({
      familyId,
      date: { $regex: `^${currentMonth}` },
    }).select('amount category note date').lean();

    let monthlyExpenseTotalPaise = 0;
    const monthlyExpenseCategories = {};
    for (const exp of expenses) {
      monthlyExpenseTotalPaise += exp.amount || 0;
      const cat = exp.category || 'other';
      monthlyExpenseCategories[cat] = (monthlyExpenseCategories[cat] || 0) + Math.round((exp.amount || 0) / 100);
    }
    const monthlyExpenseTotal = Math.round(monthlyExpenseTotalPaise / 100);

    // 5. Meals Today
    const todayMeals = await MealPlan.find({ familyId, date: todayStr }).select('slot items').lean();

    // 6. Upcoming Bills
    const upcomingBills = await BillInstance.find({ familyId, status: { $ne: 'paid' } })
      .select('billTitle dueDate amount status')
      .limit(5)
      .lean();

    const context = {
      neededGroceries,
      inStockGroceries,
      openTasks,
      todayMedicines,
      monthlyExpenseTotal,
      monthlyExpenseCategories,
      todayMeals,
      upcomingBills,
    };

    const agentResponse = await agenticFamilyAssistant({
      message: message || '',
      audioBuffer,
      mimeType,
      context,
      history: history || [],
    });

    res.json(agentResponse);
  })
);

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
            type: z.enum(['grocery', 'add_grocery', 'task', 'add_task', 'delete_task', 'expense', 'add_expense', 'bill', 'meal', 'medicine']),
            title: z.string().min(1).max(120),
            category: z.string().max(40).optional(),
            amount: z.number().nullable().optional(),
            quantity: z.string().max(30).nullable().optional(),
            dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            targetId: oid.optional(),
          })
        ).min(1).max(25),
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

      if (a.type === 'grocery' || a.type === 'add_grocery') {
        const nameKey = cleanTitle.toLowerCase();
        let item = await GroceryItem.findOne({ familyId, nameKey });
        if (item) {
          item.status = 'needed';
          if (a.quantity) item.qty = a.quantity;
          if (a.category) item.category = a.category;
          await item.save();
        } else {
          item = await GroceryItem.create({
            familyId,
            name: cleanTitle,
            nameKey,
            qty: a.quantity || '',
            status: 'needed',
            category: a.category || 'other',
            addedBy: me,
          });
        }
        added.push({ type: 'grocery', id: String(item._id), title: cleanTitle });
      } else if (a.type === 'task' || a.type === 'add_task') {
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
      } else if (a.type === 'delete_task' && a.targetId) {
        await Task.findOneAndDelete({ _id: a.targetId, familyId });
        added.push({ type: 'task', id: String(a.targetId), title: `Deleted: ${cleanTitle}` });
      } else if ((a.type === 'expense' || a.type === 'add_expense') && a.amount && a.amount > 0) {
        const exp = await Expense.create({
          familyId,
          amount: Math.round(a.amount * 100), // in paise
          note: cleanTitle,
          date: todayStr,
          paidById: me,
          createdBy: me,
          source: 'manual',
          category: a.category || 'other',
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
        const titles = added.map((x) => x.title).join(', ');
        const firstKind = added[0].type.includes('grocery') ? 'grocery' : added[0].type.includes('task') ? 'task' : added[0].type.includes('bill') ? 'bill' : 'general';
        const sysText = added.length === 1
          ? `Added to ${firstKind}: ${added[0].title}`
          : `Added ${added.length} items to family list (${titles})`;

        await ChatMessage.create({
          familyId,
          senderId: null, // NO user attribution/credit!
          text: sysText,
          type: 'system',
          ref: { kind: firstKind === 'grocery' ? 'grocery' : 'task', title: titles },
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

