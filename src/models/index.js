import mongoose from 'mongoose';
// Query operators in user input are blocked by zod strict schemas + the sanitize middleware (rejects any $-key).

mongoose.set('strictQuery', true);

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const opts = { timestamps: true, versionKey: false };
const mk = (name, def, indexes = []) => {
  const s = new Schema(def, opts);
  for (const [fields, o] of indexes) s.index(fields, o);
  return mongoose.models[name] || mongoose.model(name, s);
};

export const RELATIONS = ['self', 'father', 'mother', 'brother', 'sister', 'spouse', 'partner', 'child', 'grandparent', 'friend', 'other'];
export const ROLES = ['owner', 'admin', 'member'];
export const BILL_CATEGORIES = ['electricity', 'water', 'internet', 'phone', 'gas', 'rent', 'tax', 'insurance', 'emi', 'subscription', 'school', 'other'];
export const EXPENSE_CATEGORIES = ['grocery', 'food', 'bills', 'rent', 'tax', 'emi', 'medical', 'transport', 'shopping', 'education', 'entertainment', 'household', 'other'];
export const DOC_CATEGORIES = ['identity', 'insurance', 'vehicle', 'property', 'medical', 'bank', 'tax', 'education', 'other'];

const Rule = new Schema({
  unit: { type: String, enum: ['once', 'day', 'week', 'month', 'year'], required: true },
  everyN: { type: Number, min: 1, max: 60, default: 1 },
  anchorDate: { type: String, required: true },
  endDate: { type: String },
}, { _id: false });

export const User = mk('User', {
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true, maxlength: 254 },
  passwordHash: { type: String, required: true, select: false },
  language: { type: String, enum: ['en', 'hi', 'ta', 'ml'], default: 'en' },
  tokenVersion: { type: Number, default: 0 },
  failedLogins: { type: Number, default: 0 },
  lockedUntil: { type: Date },
  resetHash: { type: String, select: false },
  resetExpiresAt: { type: Date },
  push: [new Schema({
    endpoint: { type: String, required: true, maxlength: 1000 },
    p256dh: { type: String, required: true, maxlength: 200 },
    auth: { type: String, required: true, maxlength: 100 },
    deviceName: { type: String, maxlength: 60 },
    createdAt: { type: Date, default: Date.now },
  }, { _id: true })],
  mutedFamilies: [{ type: ObjectId }],
});

export const Session = mk('Session', {
  userId: { type: ObjectId, required: true, index: true },
  refreshHash: { type: String, required: true, unique: true },
  prevHash: { type: String },
  rotatedAt: { type: Date },
  device: { type: String, maxlength: 120 },
  lastUsedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date },
});

export const Family = mk('Family', {
  name: { type: String, required: true, trim: true, maxlength: 60 },
  type: { type: String, enum: ['home', 'rent', 'other'], default: 'home' },
  currency: { type: String, default: 'INR' },
  timezone: { type: String, default: 'Asia/Kolkata' },
  ownerUserId: { type: ObjectId, required: true },
  storageBytes: { type: Number, default: 0 },
  defaultSplit: { type: String, enum: ['equal', 'payer_only'], default: 'equal' },
});

export const Membership = mk('Membership', {
  familyId: { type: ObjectId, required: true, index: true },
  userId: { type: ObjectId, index: true },
  linkKey: { type: String, unique: true, sparse: true }, // `${familyId}:${userId}`; one account once per family
  displayName: { type: String, required: true, trim: true, maxlength: 60 },
  relation: { type: String, enum: RELATIONS, default: 'other' },
  role: { type: String, enum: ROLES, default: 'member' },
  status: { type: String, enum: ['active', 'left'], default: 'active' },
  color: { type: String, default: '#0B6B5D' },
  lastChatReadAt: { type: Date, default: () => new Date(0) },
});

export const Invite = mk('Invite', {
  familyId: { type: ObjectId, required: true, index: true },
  codeHash: { type: String, required: true, unique: true },
  role: { type: String, enum: ['admin', 'member'], default: 'member' },
  linkToMembershipId: { type: ObjectId },
  expiresAt: { type: Date, required: true },
  maxUses: { type: Number, default: 1, min: 1, max: 20 },
  usedCount: { type: Number, default: 0 },
  createdBy: { type: ObjectId, required: true },
  revokedAt: { type: Date },
});

export const Task = mk('Task', {
  familyId: { type: ObjectId, required: true },
  title: { type: String, required: true, maxlength: 140 },
  description: { type: String, maxlength: 1000 },
  kind: { type: String, enum: ['chore', 'bill', 'grocery', 'custom', 'calendar', 'meal'], default: 'custom' },
  assigneeId: { type: ObjectId, default: null },
  createdBy: { type: ObjectId },
  dueDate: { type: String },
  status: { type: String, enum: ['open', 'done'], default: 'open' },
  completedBy: { type: ObjectId },
  completedAt: { type: Date },
  link: { kind: { type: String, enum: ['bill_instance'] }, id: { type: ObjectId } },
  repeat: { unit: { type: String, enum: ['none', 'day', 'week', 'month'], default: 'none' }, everyN: { type: Number, default: 1, min: 1, max: 12 } },
  rotation: { order: [{ type: ObjectId }], index: { type: Number, default: 0 } },
}, [[{ familyId: 1, status: 1, assigneeId: 1 }, {}]]);

export const GroceryItem = mk('GroceryItem', {
  familyId: { type: ObjectId, required: true },
  name: { type: String, required: true, maxlength: 140 },
  nameKey: { type: String, required: true },
  qty: { type: String, maxlength: 60 },
  category: { type: String, maxlength: 50, default: 'other' },
  shop: { type: String, maxlength: 60, default: 'Supermarket' },
  status: { type: String, enum: ['needed', 'stocked'], default: 'needed' },
  addedBy: { type: ObjectId },
  lastBoughtBy: { type: ObjectId },
  lastBoughtAt: { type: Date },
  buyDates: [{ type: Date }],
}, [[{ familyId: 1, nameKey: 1 }, { unique: true }]]);

export const Recipe = mk('Recipe', {
  familyId: { type: ObjectId, required: true, index: true },
  title: { type: String, required: true, maxlength: 140 },
  ingredients: [new Schema({ name: { type: String, maxlength: 120 }, qty: { type: String, maxlength: 60 } }, { _id: false })],
  steps: [{ type: String, maxlength: 1000 }],
  tags: [{ type: String, maxlength: 50 }],
  photoId: { type: ObjectId },
  createdBy: { type: ObjectId },
});

export const MealPlan = mk('MealPlan', {
  familyId: { type: ObjectId, required: true },
  date: { type: String, required: true },
  slot: { type: String, enum: ['morning', 'noon', 'night'], required: true },
  items: [{ type: String, maxlength: 120 }],
  recipeId: { type: ObjectId },
  cookId: { type: ObjectId },
  attendance: [new Schema({ memberId: ObjectId, status: { type: String, enum: ['in', 'out'] } }, { _id: false })],
}, [[{ familyId: 1, date: 1, slot: 1 }, { unique: true }]]);

export const Bill = mk('Bill', {
  familyId: { type: ObjectId, required: true, index: true },
  title: { type: String, required: true, maxlength: 80 },
  category: { type: String, enum: BILL_CATEGORIES, default: 'other' },
  amountMode: { type: String, enum: ['fixed', 'ask'], default: 'ask' },
  fixedAmount: { type: Number },
  rule: { type: Rule, required: true },
  payerId: { type: ObjectId, required: true },
  reminderDaysBefore: { type: Number, default: 3, min: 0, max: 30 },
  splitAmong: [{ type: ObjectId }], // empty = all active members
  active: { type: Boolean, default: true },
  note: { type: String, maxlength: 300 },
  loanId: { type: ObjectId },
  createdBy: { type: ObjectId },
});

export const BillInstance = mk('BillInstance', {
  familyId: { type: ObjectId, required: true },
  billId: { type: ObjectId, required: true },
  dueDate: { type: String, required: true },
  amount: { type: Number, default: null },
  status: { type: String, enum: ['awaiting_amount', 'pending', 'paid'], required: true },
  paidBy: { type: ObjectId },
  paidAt: { type: Date },
  receiptDocumentId: { type: ObjectId },
  taskId: { type: ObjectId },
  expenseId: { type: ObjectId },
  reminderSentAt: { type: Date },
  overdueSentAt: { type: Date },
}, [[{ billId: 1, dueDate: 1 }, { unique: true }], [{ familyId: 1, status: 1, dueDate: 1 }, {}]]);

export const Loan = mk('Loan', {
  familyId: { type: ObjectId, required: true, index: true },
  ownerId: { type: ObjectId, required: true },
  lender: { type: String, required: true, maxlength: 80 },
  principal: { type: Number, required: true },
  interestRate: { type: Number, default: 0, min: 0, max: 60 },
  emiAmount: { type: Number, required: true },
  emiDay: { type: Number, min: 1, max: 28, required: true },
  startDate: { type: String, required: true },
  tenureMonths: { type: Number, min: 1, max: 600, required: true },
  outstanding: { type: Number, required: true },
  visibility: { type: String, enum: ['private', 'family'], default: 'private' },
  billId: { type: ObjectId },
  closedAt: { type: Date },
});

export const LoanPayment = mk('LoanPayment', {
  familyId: { type: ObjectId, required: true },
  loanId: { type: ObjectId, required: true, index: true },
  paidOn: { type: String, required: true },
  amount: { type: Number, required: true },
  interestPart: { type: Number, required: true },
  principalPart: { type: Number, required: true },
  billInstanceId: { type: ObjectId },
});

export const Expense = mk('Expense', {
  familyId: { type: ObjectId, required: true },
  amount: { type: Number, required: true },
  category: { type: String, enum: EXPENSE_CATEGORIES, default: 'other' },
  date: { type: String, required: true },
  paidById: { type: ObjectId, required: true },
  split: [new Schema({ memberId: ObjectId, share: Number }, { _id: false })],
  note: { type: String, maxlength: 200 },
  source: { type: String, enum: ['manual', 'bill', 'grocery'], default: 'manual' },
  sourceId: { type: ObjectId },
  createdBy: { type: ObjectId },
}, [[{ familyId: 1, date: 1 }, {}]]);

export const Settlement = mk('Settlement', {
  familyId: { type: ObjectId, required: true, index: true },
  fromId: { type: ObjectId, required: true },
  toId: { type: ObjectId, required: true },
  amount: { type: Number, required: true },
  date: { type: String, required: true },
  note: { type: String, maxlength: 200 },
});

const encMeta = { iv: String, tag: String, wrapIv: String, wrapTag: String, wrappedKey: String };

export const Document = mk('Document', {
  familyId: { type: ObjectId, required: true, index: true },
  ownerId: { type: ObjectId, required: true },
  title: { type: String, required: true, maxlength: 100 },
  category: { type: String, enum: DOC_CATEGORIES, default: 'other' },
  visibilityMode: { type: String, enum: ['private', 'family', 'custom'], default: 'private' },
  allowedIds: [{ type: ObjectId }],
  expiryDate: { type: String },
  maskedNumber: { type: String, maxlength: 24 },
  mime: { type: String, required: true },
  size: { type: Number, required: true },
  enc: { type: encMeta, select: false },
  data: { type: Buffer, select: false },
});

export const DocumentAccessLog = mk('DocumentAccessLog', {
  familyId: { type: ObjectId, required: true },
  documentId: { type: ObjectId, required: true, index: true },
  byId: { type: ObjectId, required: true },
  action: { type: String, enum: ['view', 'download', 'visibility', 'delete'], required: true },
});

export const Attachment = mk('Attachment', {
  familyId: { type: ObjectId, required: true, index: true },
  uploaderId: { type: ObjectId, required: true },
  mime: { type: String, required: true },
  size: { type: Number, required: true },
  enc: { type: encMeta, select: false },
  data: { type: Buffer, select: false },
});

export const Medicine = mk('Medicine', {
  familyId: { type: ObjectId, required: true, index: true },
  forId: { type: ObjectId, required: true },
  name: { type: String, required: true, maxlength: 80 },
  dosage: { type: String, maxlength: 60 },
  times: [{ type: String }],
  days: [{ type: Number, min: 0, max: 6 }],
  startDate: { type: String, required: true },
  endDate: { type: String },
  stock: { type: Number, min: 0 },
  caregivers: [{ type: ObjectId }],
  notes: { type: String, maxlength: 300 },
  createdBy: { type: ObjectId },
  active: { type: Boolean, default: true },
});

export const MedicineLog = mk('MedicineLog', {
  familyId: { type: ObjectId, required: true },
  medicineId: { type: ObjectId, required: true },
  forId: { type: ObjectId, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  status: { type: String, enum: ['given', 'skipped'], required: true },
  byId: { type: ObjectId, required: true },
}, [[{ medicineId: 1, date: 1, time: 1 }, { unique: true }]]);

export const SpecialDate = mk('SpecialDate', {
  familyId: { type: ObjectId, required: true, index: true },
  title: { type: String, required: true, maxlength: 100 },
  kind: { type: String, enum: ['birthday', 'anniversary', 'shraddham', 'festival', 'other'], default: 'other' },
  date: { type: String, required: true },
  repeatYearly: { type: Boolean, default: true },
  remindDaysBefore: { type: Number, default: 7, min: 0, max: 60 },
  checklist: [new Schema({
    text: { type: String, maxlength: 120 },
    done: { type: Boolean, default: false },
    assigneeId: { type: ObjectId },
  })],
  createdBy: { type: ObjectId },
});

export const Guest = mk('Guest', {
  familyId: { type: ObjectId, required: true, index: true },
  name: { type: String, required: true, maxlength: 80 },
  from: { type: String, required: true },
  to: { type: String, required: true },
  notes: { type: String, maxlength: 300 },
  hostId: { type: ObjectId },
});

export const Contact = mk('Contact', {
  familyId: { type: ObjectId, required: true, index: true },
  name: { type: String, required: true, maxlength: 80 },
  role: { type: String, enum: ['doctor', 'plumber', 'electrician', 'neighbour', 'relative', 'other'], default: 'other' },
  phone: { type: String, required: true, maxlength: 20 },
  notes: { type: String, maxlength: 200 },
});

export const ChatMessage = mk('ChatMessage', {
  familyId: { type: ObjectId, required: true },
  senderId: { type: ObjectId },
  type: { type: String, enum: ['text', 'image', 'system', 'card', 'audio'], default: 'text' },
  text: { type: String, maxlength: 2000 },
  attachmentId: { type: ObjectId },
  audioDuration: { type: Number },
  replyTo: {
    id: ObjectId,
    senderName: String,
    text: String,
  },
  ref: { kind: { type: String, enum: ['task', 'bill_instance', 'recipe', 'grocery'] }, id: ObjectId, title: String },
}, [[{ familyId: 1, _id: -1 }, {}]]);

export const Notification = mk('Notification', {
  userId: { type: ObjectId, required: true },
  familyId: { type: ObjectId },
  type: { type: String, required: true },
  title: { type: String, required: true, maxlength: 140 },
  body: { type: String, maxlength: 300 },
  url: { type: String, maxlength: 200 },
  readAt: { type: Date },
  dedupeKey: { type: String, unique: true, sparse: true },
}, [[{ userId: 1, _id: -1 }, {}]]);

export const AuditLog = mk('AuditLog', {
  familyId: { type: ObjectId, required: true },
  actorId: { type: ObjectId },
  action: { type: String, required: true },
  entity: { type: String },
  entityId: { type: ObjectId },
  meta: { type: Object },
}, [[{ familyId: 1, _id: -1 }, {}]]);

export const EmailOtp = mk('EmailOtp', {
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  otpHash: { type: String, required: true },
  type: { type: String, enum: ['register', 'reset'], default: 'register' },
  payload: { type: Object },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
}, [[{ expiresAt: 1 }, { expireAfterSeconds: 0 }]]);

export const FAMILY_SCOPED = [Task, GroceryItem, Recipe, MealPlan, Bill, BillInstance, Loan, LoanPayment, Expense, Settlement,
  Document, DocumentAccessLog, Attachment, Medicine, MedicineLog, SpecialDate, Guest, Contact, ChatMessage, AuditLog, Invite, Membership];

export const allModels = { User, Session, Family, Membership, Invite, Task, GroceryItem, Recipe, MealPlan, Bill, BillInstance, Loan,
  LoanPayment, Expense, Settlement, Document, DocumentAccessLog, Attachment, Medicine, MedicineLog, SpecialDate, Guest, Contact,
  ChatMessage, Notification, AuditLog, EmailOtp };
