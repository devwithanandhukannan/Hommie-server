import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { h, badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate, oid, optText, ymd } from '../lib/validate.js';
import { todayIn, addDays } from '../lib/dates.js';
import { isAdmin } from '../middleware/auth.js';
import { canSeeMedicine } from '../dto.js';
import { ensureInstances } from '../services/bills.js';
import { decryptFile } from '../lib/crypto.js';
import { scanObject } from '../lib/sanitize.js';
import { aiLimiter } from '../middleware/security.js';
import { attachImageToItem } from '../services/groceryImage.js';
import { sniff } from './documents.js';
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
  EXPENSE_CATEGORIES,
} from '../models/index.js';
import { analyzeWithGemini, agenticFamilyAssistant } from '../services/ai.js';
import { loadMembers } from '../services/members.js';
import { createExpense, equalSplit } from '../services/expenses.js';
import { notify, otherFamilyUserIds } from '../services/push.js';
import { getCachedAiContext, setCachedAiContext, invalidateAiContextCache } from '../services/aiCache.js';

export { invalidateAiContextCache };

export const ai = Router();

ai.use(aiLimiter);

const aiAudioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 8, fieldSize: 32_768 },
});

/**
 * Builds live family ground-truth context for AI using parallel DB queries,
 * server-side expense aggregation, and a short per-(family, member) TTL cache.
 */
export async function buildFamilyContext(family, me) {
  const familyId = String(family._id);
  const cacheKey = `${familyId}:${String(me)}`;
  const cached = getCachedAiContext(cacheKey);
  if (cached) return cached;

  const todayStr = todayIn(family.timezone);
  const tomorrowStr = addDays(todayStr, 1);
  const currentMonth = todayStr.slice(0, 7);

  const settled = await Promise.allSettled([
    loadMembers(family._id),
    GroceryItem.find({ familyId: family._id, status: 'needed' }).select('name qty category shop').limit(60).lean(),
    GroceryItem.find({ familyId: family._id, status: 'stocked' }).select('name qty category shop').limit(100).lean(),
    Task.find({ familyId: family._id, status: 'open', kind: { $ne: 'bill' } }).select('title dueDate kind assigneeId').limit(30).lean(),
    Medicine.find({ familyId: family._id, active: true }).select('name dosage times forId createdBy caregivers startDate endDate days').lean(),
    MedicineLog.find({ familyId: family._id, date: todayStr }).select('medicineId time status').lean(),
    BillInstance.find({ familyId: family._id, status: { $ne: 'paid' }, dueDate: { $lte: addDays(todayStr, 14) } }).sort({ dueDate: 1 }).limit(10).lean(),
    Expense.aggregate([
      { $match: { familyId: family._id, date: { $gte: `${currentMonth}-01`, $lte: `${currentMonth}-31` } } },
      { $group: { _id: { $ifNull: ['$category', 'other'] }, totalPaise: { $sum: '$amount' } } },
    ]),
    MealPlan.find({ familyId: family._id, date: { $in: [todayStr, tomorrowStr] } }).select('date slot items cookId').lean(),
  ]);

  const val = (i, fallback) => (settled[i].status === 'fulfilled' && settled[i].value ? settled[i].value : fallback);
  const mem = val(0, { docs: [], map: new Map() });
  const memberDocs = mem.docs || [];
  const memberMap = mem.map || new Map();
  const familyMembers = memberDocs.map((m) => ({
    id: String(m._id),
    name: m.displayName,
    relation: m.relation,
  }));

  const neededGroceries = val(1, []);
  const inStockGroceries = val(2, []);
  const openTasks = val(3, []).map((t) => ({
    ...t,
    assigneeName: memberMap.get(String(t.assigneeId))?.displayName || null,
  }));

  const allMeds = val(4, []);
  const medLogs = val(5, []);
  const todayMedicines = [];
  const weekday = new Date(`${todayStr}T00:00:00Z`).getUTCDay();
  for (const med of allMeds.filter((m) => canSeeMedicine(m, me))) {
    if (med.startDate > todayStr || (med.endDate && med.endDate < todayStr)) continue;
    if (med.days?.length && !med.days.includes(weekday)) continue;
    for (const time of med.times || []) {
      const log = medLogs.find((l) => String(l.medicineId) === String(med._id) && l.time === time);
      todayMedicines.push({
        id: String(med._id),
        name: med.name,
        dosage: med.dosage,
        time,
        forName: memberMap.get(String(med.forId))?.displayName || 'Member',
        status: log?.status || 'pending',
      });
    }
  }

  const insts = val(6, []);
  let upcomingBills = [];
  if (insts.length > 0) {
    try {
      const bills = new Map((await Bill.find({ _id: { $in: insts.map((i) => i.billId) } }).select('title').lean()).map((b) => [String(b._id), b.title]));
      upcomingBills = insts.map((i) => ({
        title: bills.get(String(i.billId)) || 'Bill',
        dueDate: i.dueDate,
        amount: i.amount == null ? null : Math.round(i.amount / 100),
      }));
    } catch {}
  }

  let monthlyExpenseTotalPaise = 0;
  const monthlyExpenseCategories = {};
  for (const row of val(7, [])) {
    monthlyExpenseTotalPaise += row.totalPaise || 0;
    const cat = row._id || 'other';
    monthlyExpenseCategories[cat] = Math.round((row.totalPaise || 0) / 100);
  }
  const monthlyExpenseTotal = Math.round(monthlyExpenseTotalPaise / 100);

  const todayMeals = val(8, []).map((m) => ({
    date: m.date,
    slot: m.slot,
    items: m.items || [],
    cookName: memberMap.get(String(m.cookId))?.displayName || null,
  }));

  const ctx = {
    todayStr,
    tomorrowStr,
    familyMembers,
    memberDocs,
    memberMap,
    neededGroceries,
    inStockGroceries,
    openTasks,
    todayMedicines,
    monthlyExpenseTotal,
    monthlyExpenseCategories,
    todayMeals,
    upcomingBills,
  };

  setCachedAiContext(cacheKey, ctx);
  return ctx;
}

function parseAiMultipart(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  aiAudioUpload.single('file')(req, res, (err) => {
    if (err) return next(err);
    try {
      req.body = req.body ? { ...req.body } : {};
      if (typeof req.body.history === 'string') {
        req.body.history = JSON.parse(req.body.history);
      }
      scanObject(req.body);
      next();
    } catch (e) {
      next(e instanceof SyntaxError ? badRequest('Invalid history JSON') : e);
    }
  });
}

async function resolveAudioInput(req, attachmentId) {
  if (req.file) {
    if (!req.file.buffer?.length) throw badRequest('Audio recording is empty');
    const detected = sniff(req.file.buffer);
    if (!detected || !detected.startsWith('audio/')) {
      throw badRequest('Uploaded file must be a supported audio recording');
    }
    return { audioBuffer: req.file.buffer, mimeType: detected };
  }

  if (attachmentId) {
    const a = await Attachment.findOne({
      _id: attachmentId,
      familyId: req.ctx.familyId,
    }).select('+data +enc');

    if (!a) throw notFound('Audio attachment not found');
    if (!a.mime?.startsWith('audio/')) throw badRequest('Attachment must be an audio file');

    try {
      return { audioBuffer: decryptFile(a.data, a.enc), mimeType: a.mime };
    } catch {
      throw new Error('Could not decrypt audio attachment');
    }
  }

  return { audioBuffer: null, mimeType: 'audio/webm' };
}

/**
 * Agentic Household Assistant with full live family context.
 * Accepts either JSON ({ message, attachmentId, history, speechLang }) or
 * multipart/form-data (audio `file` processed in RAM with zero DB storage overhead).
 */
ai.post(
  '/agent',
  parseAiMultipart,
  h(async (req, res, next) => {
    if (!req.file && (!req.body?.message || !String(req.body.message).trim()) && !req.body?.attachmentId) {
      throw badRequest('Either message, audio file, or attachmentId is required');
    }
    next();
  }),
  validate({
    body: z
      .object({
        message: z.string().max(2000).optional(),
        attachmentId: oid.optional(),
        speechLang: z.string().max(16).optional(),
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
      .strict(),
  }),
  h(async (req, res) => {
    const { message, attachmentId, history, speechLang } = req.valid.body;
    const { audioBuffer, mimeType } = await resolveAudioInput(req, attachmentId);

    const context = await buildFamilyContext(req.ctx.family, req.ctx.me);
    context.uiLang = req.ctx.user?.language || 'en';

    const agentResponse = await agenticFamilyAssistant({
      message: message || '',
      audioBuffer,
      mimeType,
      speechLang: speechLang || '',
      context,
      history: history || [],
    });

    res.json(agentResponse);
  })
);

/**
 * Analyzes a text message, direct audio upload, or legacy audio attachment using Gemini AI.
 */
ai.post(
  '/analyze',
  parseAiMultipart,
  h(async (req, res, next) => {
    if (!req.file && (!req.body?.text || !String(req.body.text).trim()) && !req.body?.attachmentId) {
      throw badRequest('Either text, audio file, or attachmentId is required');
    }
    next();
  }),
  validate({
    body: z
      .object({
        text: optText(2000),
        attachmentId: oid.optional(),
        speechLang: z.string().max(16).optional(),
      })
      .strict(),
  }),
  h(async (req, res) => {
    const { text, attachmentId, speechLang } = req.valid.body;
    const { audioBuffer, mimeType } = await resolveAudioInput(req, attachmentId);

    const context = await buildFamilyContext(req.ctx.family, req.ctx.me);
    context.uiLang = req.ctx.user?.language || 'en';
    const result = await analyzeWithGemini({ text, audioBuffer, mimeType, speechLang: speechLang || '', context });
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

    const todayStr = todayIn(req.ctx.family.timezone);
    const tomorrowStr = addDays(todayStr, 1);
    // The model's output is untrusted: accept only real YYYY-MM-DD dates, otherwise fall back.
    const goodDate = (d, fallback) => (typeof d === 'string' && ymd.safeParse(d).success ? d : fallback);

    const { docs: memberDocs } = await loadMembers(familyId);
    const findMemberId = (nameOrId) => {
      if (!nameOrId) return null;
      const clean = String(nameOrId).trim().toLowerCase();
      const byId = memberDocs.find((m) => String(m._id) === clean);
      if (byId) return byId._id;
      const exact = memberDocs.filter((m) => (m.displayName || '').trim().toLowerCase() === clean);
      if (exact.length === 1) return exact[0]._id;
      if (clean.length < 3) return null;
      const first = memberDocs.filter((m) => (m.displayName || '').trim().toLowerCase().split(/\s+/)[0] === clean.split(/\s+/)[0]);
      return first.length === 1 ? first[0]._id : null; // ambiguous names are left unassigned instead of guessed
    };

    let lastCreatedRecipeId = null;
    let scheduledMealInfo = null;
    let addedGroceryCount = 0;
    const addedGroceries = [];
    const createdTasks = [];
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
          item.unbilled = false;
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
        if (item.imageUrl == null) attachImageToItem(item);
        addedGroceryCount++;
        addedGroceries.push({ name: safeTitle, qty: safeQty });
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
        const mealDate = goodDate(a.date, tomorrowStr);
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
        const eventDate = goodDate(a.dueDate || a.date, tomorrowStr);
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
        createdTasks.push(task);
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
          dueDate: goodDate(a.dueDate, undefined),
          status: 'open',
        });
        createdTasks.push(task);
        added.push({ type: 'task', id: String(task._id), title: safeTitle });
      } else if (a.type === 'delete_task' && a.targetId) {
        const target = await Task.findOne({ _id: a.targetId, familyId });
        if (!target) continue;
        if (target.kind === 'bill') throw badRequest('Bill tasks are managed from the bill');
        if (String(target.createdBy) !== me && !isAdmin(req)) throw forbidden('Only the creator or an admin can delete this task');
        await target.deleteOne();
        added.push({ type: 'task', id: String(a.targetId), title: `Deleted: ${target.title}` });
      } else if ((a.type === 'expense' || a.type === 'add_expense') && Number.isFinite(a.amount) && a.amount > 0 && a.amount <= 10_000_000) {
        const paise = Math.round(a.amount * 100);
        const exp = await createExpense({
          familyId,
          amount: paise,
          note: safeTitle.slice(0, 200),
          date: todayStr,
          paidById: me,
          createdBy: me,
          source: 'manual',
          category: EXPENSE_CATEGORIES.includes(safeCat.toLowerCase()) ? safeCat.toLowerCase() : 'other',
          split: equalSplit(paise, memberDocs.map((m) => String(m._id))),
        });
        added.push({ type: 'expense', id: String(exp._id), title: safeTitle, amount: a.amount });
      } else if (a.type === 'bill') {
        const bill = await Bill.create({
          familyId,
          title: safeTitle,
          category: 'other',
          amountMode: 'ask',
          rule: { unit: 'month', everyN: 1, anchorDate: goodDate(a.dueDate || a.date, todayStr) },
          payerId: me,
          createdBy: me,
        });
        await ensureInstances(req.ctx.family);
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
        createdTasks.push(task);
        added.push({ type: 'task', id: String(task._id), title: safeTitle });
      }
    }

    // Send localized push & in-app notifications for grocery additions and created tasks.
    if (addedGroceries.length > 0 || createdTasks.length > 0) {
      try {
        const needFamilyUsers = addedGroceries.length > 0 || createdTasks.some((t) => !t.assigneeId);
        const otherUserIds = needFamilyUsers ? await otherFamilyUserIds(familyId, me) : [];
        const by = req.ctx.membership.displayName;

        if (addedGroceries.length === 1 && otherUserIds.length) {
          await notify({
            userIds: otherUserIds,
            familyId,
            type: 'grocery',
            url: '/grocery',
            coalesce: true,
            i18nKey: 'grocery_added',
            params: { by, name: addedGroceries[0].name, qty: addedGroceries[0].qty },
          });
        } else if (addedGroceries.length > 1 && otherUserIds.length) {
          const preview = addedGroceries.slice(0, 3).map((g) => g.name).join(', ')
            + (addedGroceries.length > 3 ? ` (+${addedGroceries.length - 3})` : '');
          await notify({
            userIds: otherUserIds,
            familyId,
            type: 'grocery',
            url: '/grocery',
            coalesce: true,
            i18nKey: 'grocery_batch',
            params: { by, count: addedGroceries.length, preview },
          });
        }

        for (const task of createdTasks) {
          if (task.assigneeId) {
            if (String(task.assigneeId) === me) continue;
            const assigneeDoc = memberDocs.find((m) => String(m._id) === String(task.assigneeId));
            if (assigneeDoc?.userId) {
              await notify({
                userIds: [assigneeDoc.userId],
                familyId,
                type: 'task',
                url: '/tasks',
                i18nKey: 'task_assigned',
                params: { by, title: task.title },
              });
            }
          } else if (otherUserIds.length) {
            await notify({
              userIds: otherUserIds,
              familyId,
              type: 'task',
              url: '/tasks',
              i18nKey: 'task_open',
              params: { by, title: task.title },
            });
          }
        }
      } catch {
        // ignore notification error
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
        });
      } catch {
        // ignore notification error
      }
    }

    invalidateAiContextCache(familyId);

    res.status(201).json({
      success: true,
      count: added.length,
      items: added,
    });
  })
);
