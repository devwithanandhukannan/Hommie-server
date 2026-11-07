import { Router } from 'express';
import { z } from 'zod';
import { h, badRequest, notFound } from '../lib/errors.js';
import { validate, oid, optText } from '../lib/validate.js';
import { decryptFile } from '../lib/crypto.js';
import { aiLimiter } from '../middleware/security.js';
import {
  Attachment,
  GroceryItem,
  Task,
  Expense,
  Bill,
  BillInstance,
  MealPlan,
  Recipe,
  Medicine,
  MedicineLog,
  ChatMessage,
  Membership,
} from '../models/index.js';
import { analyzeWithGemini, agenticFamilyAssistant } from '../services/ai.js';
import { loadMembers } from '../services/members.js';

export const ai = Router();

ai.use(aiLimiter);

/**
 * Builds live family ground-truth context for AI.
 */
async function buildFamilyContext(familyId) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const currentMonth = todayStr.slice(0, 7);

  let familyMembers = [];
  let memberDocs = [];
  let memberMap = new Map();
  let neededGroceries = [];
  let inStockGroceries = [];
  let openTasks = [];
  let todayMedicines = [];
  let monthlyExpenseTotal = 0;
  let monthlyExpenseCategories = {};
  let todayMeals = [];
  let upcomingBills = [];

  try {
    const mem = await loadMembers(familyId);
    memberDocs = mem.docs || [];
    memberMap = mem.map || new Map();
    familyMembers = memberDocs.map((m) => ({
      id: String(m._id),
      name: m.displayName,
      relation: m.relation,
    }));
  } catch {}

  try {
    [neededGroceries, inStockGroceries] = await Promise.all([
      GroceryItem.find({ familyId, status: 'needed' }).select('name qty category shop').limit(60).lean(),
      GroceryItem.find({ familyId, status: 'stocked' }).select('name qty category shop').limit(60).lean(),
    ]);
  } catch {}

  try {
    openTasks = await Task.find({ familyId, status: 'open' })
      .select('title dueDate kind assigneeId')
      .populate('assigneeId', 'displayName')
      .limit(30)
      .lean();
  } catch {}

  try {
    const [medicines, medLogs] = await Promise.all([
      Medicine.find({ familyId, active: true })
        .select('name dosage times instructions forMemberId')
        .populate('forMemberId', 'displayName')
        .lean(),
      MedicineLog.find({ familyId, date: todayStr }).select('medicineId time status').lean(),
    ]);

    for (const med of medicines || []) {
      for (const time of med.times || []) {
        const log = (medLogs || []).find((l) => String(l.medicineId) === String(med._id) && l.time === time);
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
  } catch {}

  try {
    const expenses = await Expense.find({
      familyId,
      date: { $regex: `^${currentMonth}` },
    }).select('amount category note date').lean();

    let monthlyExpenseTotalPaise = 0;
    for (const exp of expenses || []) {
      monthlyExpenseTotalPaise += exp.amount || 0;
      const cat = exp.category || 'other';
      monthlyExpenseCategories[cat] = (monthlyExpenseCategories[cat] || 0) + Math.round((exp.amount || 0) / 100);
    }
    monthlyExpenseTotal = Math.round(monthlyExpenseTotalPaise / 100);
  } catch {}

  try {
    todayMeals = await MealPlan.find({ familyId, date: { $in: [todayStr, tomorrowStr] } })
      .select('date slot items cookId')
      .lean();
  } catch {}

  return {
    todayStr,
    tomorrowStr,
    familyMembers,
    memberDocs,
    memberMap,
    neededGroceries: neededGroceries || [],
    inStockGroceries: inStockGroceries || [],
    openTasks: openTasks || [],
    todayMedicines: todayMedicines || [],
    monthlyExpenseTotal,
    monthlyExpenseCategories,
    todayMeals: todayMeals || [],
    upcomingBills: upcomingBills || [],
  };
}

/**
 * Agentic Household Assistant with full live family context.
 * Handles multi-intent compound queries, shop-based groceries, recipes, meals, and calendar tags.
 */
ai.post(
  '/agent',
  validate({
    body: z
      .object({
        message: z.string().max(2000).optional(),
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

    const context = await buildFamilyContext(familyId);

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
 * Analyzes a text message or audio attachment using Gemini AI with live context.
 */
ai.post(
  '/analyze',
  validate({
    body: z
      .object({
        text: optText(2000),
        attachmentId: oid.optional(),
      })
      .strict()
      .refine((b) => (b.text && b.text.trim().length > 0) || b.attachmentId, {
        message: 'Either text or attachmentId is required',
      }),
  }),
  h(async (req, res) => {
    const { text, attachmentId } = req.valid.body;
    const familyId = req.ctx.familyId;
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

    const context = await buildFamilyContext(familyId);
    const result = await analyzeWithGemini({ text, audioBuffer, mimeType, context });
    res.json(result);
  })
);

/**
 * Action Schema for /apply.
 * Tolerates auxiliary fields from AI via passthrough and allows nulls gracefully.
 */
const actionItemSchema = z
  .object({
    type: z.enum([
      'grocery',
      'add_grocery',
      'task',
      'add_task',
      'delete_task',
      'expense',
      'add_expense',
      'bill',
      'meal',
      'add_meal',
      'recipe',
      'add_recipe',
      'calendar',
      'add_calendar_event',
      'medicine',
    ]),
    title: z.string().min(1).max(250),
    category: z.string().max(80).nullable().optional(),
    shop: z.string().max(80).nullable().optional(),
    amount: z.number().nullable().optional(),
    quantity: z.string().max(80).nullable().optional(),
    dueDate: z.string().max(30).nullable().optional(),
    slot: z.enum(['morning', 'noon', 'night']).nullable().optional(),
    date: z.string().max(30).nullable().optional(),
    cookId: oid.nullable().optional(),
    cookName: z.string().max(80).nullable().optional(),
    assigneeId: oid.nullable().optional(),
    assigneeName: z.string().max(80).nullable().optional(),
    targetId: oid.nullable().optional(),
    ingredients: z
      .array(
        z
          .object({
            name: z.string().max(140),
            qty: z.string().max(80).optional(),
          })
          .passthrough()
      )
      .optional(),
    steps: z.array(z.string().max(1000)).optional(),
  })
  .passthrough();

/**
 * Applies the approved actions directly into the family database.
 */
ai.post(
  '/apply',
  validate({
    body: z
      .object({
        actions: z.array(actionItemSchema).min(1).max(35),
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
    const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

    const { docs: memberDocs } = await loadMembers(familyId);
    const findMemberId = (nameOrId) => {
      if (!nameOrId) return null;
      const clean = String(nameOrId).trim().toLowerCase();
      const byId = memberDocs.find((m) => String(m._id) === clean);
      if (byId) return byId._id;
      const byName = memberDocs.find((m) => (m.displayName || '').toLowerCase().includes(clean) || clean.includes((m.displayName || '').toLowerCase()));
      return byName ? byName._id : null;
    };

    let lastCreatedRecipeId = null;
    let scheduledMealInfo = null;
    let addedGroceryCount = 0;
    const shopsInvolved = new Set();

    for (const a of actions) {
      const cleanTitle = (a.title || '').trim();
      if (!cleanTitle) continue;

      const safeTitle = cleanTitle.slice(0, 140);
      const safeQty = (a.quantity || '').trim().slice(0, 60);
      const safeCat = (a.category || 'other').trim().slice(0, 50);
      const safeShop = (a.shop || 'Supermarket').trim().slice(0, 60);

      if (a.type === 'grocery' || a.type === 'add_grocery') {
        const nameKey = safeTitle.toLowerCase().replace(/\s+/g, ' ');
        let item = await GroceryItem.findOne({ familyId, nameKey });
        if (item) {
          item.status = 'needed';
          if (safeQty) item.qty = safeQty;
          if (safeCat) item.category = safeCat;
          if (safeShop) item.shop = safeShop;
          await item.save();
        } else {
          item = await GroceryItem.create({
            familyId,
            name: safeTitle,
            nameKey,
            qty: safeQty,
            status: 'needed',
            category: safeCat,
            shop: safeShop,
            addedBy: me,
          });
        }
        addedGroceryCount++;
        shopsInvolved.add(safeShop);
        added.push({ type: 'grocery', id: String(item._id), title: safeTitle, shop: safeShop });
      } else if (a.type === 'recipe' || a.type === 'add_recipe') {
        const recipe = await Recipe.create({
          familyId,
          title: safeTitle,
          ingredients: Array.isArray(a.ingredients)
            ? a.ingredients.map((ing) => ({ name: String(ing.name || '').slice(0, 120), qty: String(ing.qty || '').slice(0, 60) }))
            : [],
          steps: Array.isArray(a.steps) ? a.steps.map((st) => String(st).slice(0, 900)) : [],
          tags: ['AI Suggested'],
          createdBy: me,
        });
        lastCreatedRecipeId = recipe._id;
        added.push({ type: 'recipe', id: String(recipe._id), title: safeTitle });
      } else if (a.type === 'meal' || a.type === 'add_meal') {
        const mealDate = a.date || tomorrowStr;
        const mealSlot = a.slot || 'noon';
        const matchedCookId = a.cookId || findMemberId(a.cookName);
        const cookDoc = matchedCookId ? memberDocs.find((m) => String(m._id) === String(matchedCookId)) : null;

        const m = await MealPlan.findOneAndUpdate(
          { familyId, date: mealDate, slot: mealSlot },
          {
            $set: {
              items: [safeTitle],
              cookId: matchedCookId || null,
              recipeId: lastCreatedRecipeId || null,
            },
            $setOnInsert: { attendance: [] },
          },
          { new: true, upsert: true }
        );

        scheduledMealInfo = {
          title: safeTitle,
          date: mealDate,
          slot: mealSlot,
          cookName: cookDoc?.displayName || null,
        };

        added.push({
          type: 'meal',
          id: String(m._id),
          title: `${safeTitle} (${mealDate} ${mealSlot})`,
          cookName: cookDoc?.displayName || null,
        });
      } else if (a.type === 'calendar' || a.type === 'add_calendar_event') {
        const eventDate = a.dueDate || a.date || tomorrowStr;
        const matchedAssigneeId = a.assigneeId || findMemberId(a.assigneeName);
        const assigneeDoc = matchedAssigneeId ? memberDocs.find((m) => String(m._id) === String(matchedAssigneeId)) : null;

        const task = await Task.create({
          familyId,
          title: safeTitle,
          kind: 'custom',
          assigneeId: matchedAssigneeId || null,
          createdBy: me,
          dueDate: eventDate,
          status: 'open',
        });
        added.push({
          type: 'calendar',
          id: String(task._id),
          title: safeTitle,
          dueDate: eventDate,
          assigneeName: assigneeDoc?.displayName || null,
        });
      } else if (a.type === 'task' || a.type === 'add_task') {
        const matchedAssigneeId = a.assigneeId || findMemberId(a.assigneeName);
        const task = await Task.create({
          familyId,
          title: safeTitle,
          kind: 'custom',
          assigneeId: matchedAssigneeId || null,
          createdBy: me,
          dueDate: a.dueDate || undefined,
          status: 'open',
        });
        added.push({ type: 'task', id: String(task._id), title: safeTitle });
      } else if (a.type === 'delete_task' && a.targetId) {
        await Task.findOneAndDelete({ _id: a.targetId, familyId });
        added.push({ type: 'task', id: String(a.targetId), title: `Deleted: ${safeTitle}` });
      } else if ((a.type === 'expense' || a.type === 'add_expense') && a.amount && a.amount > 0) {
        const exp = await Expense.create({
          familyId,
          amount: Math.round(a.amount * 100),
          note: safeTitle,
          date: todayStr,
          paidById: me,
          createdBy: me,
          source: 'manual',
          category: safeCat,
        });
        added.push({ type: 'expense', id: String(exp._id), title: safeTitle, amount: a.amount });
      } else if (a.type === 'bill') {
        const bill = await Bill.create({
          familyId,
          title: safeTitle,
          category: 'other',
          rule: { unit: 'month', everyN: 1, anchorDate: todayStr },
          createdBy: me,
        });
        added.push({ type: 'bill', id: String(bill._id), title: safeTitle });
      } else {
        const task = await Task.create({
          familyId,
          title: safeTitle,
          kind: 'custom',
          assigneeId: null,
          createdBy: me,
          status: 'open',
        });
        added.push({ type: 'task', id: String(task._id), title: safeTitle });
      }
    }

    // Chat Notification without user credit / attribution (senderId: null)
    if (notifyInChat && added.length > 0) {
      try {
        let sysText = '';
        if (scheduledMealInfo) {
          const slotLabel = scheduledMealInfo.slot === 'noon' ? 'Lunch' : scheduledMealInfo.slot === 'morning' ? 'Breakfast' : 'Dinner';
          const cookStr = scheduledMealInfo.cookName ? ` (Cook: ${scheduledMealInfo.cookName})` : '';
          sysText = `Hommi AI scheduled ${scheduledMealInfo.title} for ${scheduledMealInfo.date} ${slotLabel}${cookStr}.`;
          if (addedGroceryCount > 0) {
            const shopsList = Array.from(shopsInvolved).slice(0, 3).join(', ');
            sysText += ` Added ${addedGroceryCount} ingredients to Grocery list (${shopsList}).`;
          }
        } else if (addedGroceryCount > 0 && added.length === addedGroceryCount) {
          const shopsList = Array.from(shopsInvolved).slice(0, 3).join(', ');
          sysText = addedGroceryCount === 1
            ? `Hommi AI added to Grocery (${shopsList}): ${added[0].title}`
            : `Hommi AI added ${addedGroceryCount} items to Grocery (${shopsList})`;
        } else {
          const titles = added.slice(0, 3).map((x) => x.title).join(', ');
          const more = added.length > 3 ? ` and ${added.length - 3} more` : '';
          sysText = `Hommi AI added ${added.length} item(s): ${titles}${more}`;
        }

        await ChatMessage.create({
          familyId,
          senderId: null,
          text: sysText,
          type: 'system',
          ref: {
            kind: scheduledMealInfo ? 'meal' : added[0]?.type?.includes('grocery') ? 'grocery' : 'task',
            title: scheduledMealInfo?.title || added[0]?.title || 'Items added',
          },
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
