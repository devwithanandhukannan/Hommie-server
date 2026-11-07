import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { h, badRequest, notFound, forbidden } from '../lib/errors.js';
import { validate, idParams, oid, ymd, text } from '../lib/validate.js';
import { Document, DocumentAccessLog, Attachment, Family } from '../models/index.js';
import { DOC_CATEGORIES } from '../models/index.js';
import { docDto, canViewDoc } from '../dto.js';
import { loadMembers, pick } from '../services/members.js';
import { encryptFile, decryptFile } from '../lib/crypto.js';
import { todayIn } from '../lib/dates.js';
import { uploadLimiter } from '../middleware/security.js';
import { audit } from '../services/audit.js';
import { Membership } from '../models/index.js';

export const documents = Router();
export const attachments = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxDocBytes, files: 1, fields: 12, fieldSize: 4096 } });

/** The file's real type from its magic bytes: the client-supplied mime/name is never trusted. */
export function sniff(buf) {
  if (buf.length < 4) return null;
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // Audio: WebM / Matroska
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';
  // Audio: Ogg
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  // Audio: MP4 / M4A / AAC
  if (buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  // Audio: WAV
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  // Audio: MP3
  if (buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

async function reserveSpace(familyId, size) {
  const r = await Family.findOneAndUpdate(
    { _id: familyId, storageBytes: { $lte: config.familyDocQuotaBytes - size } }, { $inc: { storageBytes: size } }, { new: true });
  if (!r) throw badRequest('Family storage is full. Delete some files first.');
}
const releaseSpace = (familyId, size) => Family.updateOne({ _id: familyId }, { $inc: { storageBytes: -size } });

const maskedNumber = z.string().trim().max(24).regex(/^[Xx*•\d\s-]*$/, 'Only digits, X and dashes').refine((s) => (s.match(/\d/g) || []).length <= 4, 'Store at most the last 4 digits');
const idList = z.array(oid).max(30);
const visibility = z.enum(['private', 'family', 'custom']);

// multipart form fields arrive as strings; allowedIds is a JSON array string
const jsonIds = z.string().max(2000).transform((s, ctx) => { try { return idList.parse(JSON.parse(s)); } catch { ctx.addIssue({ code: 'custom', message: 'allowedIds must be a JSON array of ids' }); return z.NEVER; } });
const createFields = z.object({
  title: text(100), category: z.enum(DOC_CATEGORIES).default('other'), visibilityMode: visibility.default('private'),
  allowedIds: jsonIds.optional(), expiryDate: ymd.optional(), maskedNumber: maskedNumber.optional(),
}).strict();

async function checkAllowed(familyId, ids) {
  if (!ids?.length) return;
  const n = await Membership.countDocuments({ _id: { $in: ids }, familyId, status: 'active' });
  if (n !== new Set(ids).size) throw badRequest('Some selected members are not in this family');
}

documents.get('/', h(async (req, res) => {
  const list = await Document.find({ familyId: req.ctx.familyId }).sort({ _id: -1 }).limit(300);
  const { map } = await loadMembers(req.ctx.familyId);
  const today = todayIn(req.ctx.family.timezone);
  res.json(list.filter((d) => canViewDoc(d, req.ctx.me)).map((d) => docDto(d, req.ctx.me, map, today)));
}));

documents.post('/', uploadLimiter, upload.single('file'), validate({ body: createFields }), h(async (req, res) => {
  if (!req.file) throw badRequest('Attach a file');
  const mime = sniff(req.file.buffer);
  if (!mime) throw badRequest('Only PDF, JPG, PNG or WebP files are allowed');
  const b = req.valid.body;
  await checkAllowed(req.ctx.familyId, b.allowedIds);
  if (b.visibilityMode === 'custom' && !b.allowedIds?.length) throw badRequest('Choose who can see this document');
  await reserveSpace(req.ctx.familyId, req.file.size);
  try {
    const { data, meta } = encryptFile(req.file.buffer);
    const d = await Document.create({
      familyId: req.ctx.familyId, ownerId: req.ctx.me, title: b.title, category: b.category, visibilityMode: b.visibilityMode,
      allowedIds: b.visibilityMode === 'custom' ? b.allowedIds : [], expiryDate: b.expiryDate, maskedNumber: b.maskedNumber,
      mime, size: req.file.size, enc: meta, data,
    });
    const { map } = await loadMembers(req.ctx.familyId);
    res.status(201).json(docDto(d, req.ctx.me, map, todayIn(req.ctx.family.timezone)));
  } catch (e) { await releaseSpace(req.ctx.familyId, req.file.size); throw e; }
}));

// A document you may not see behaves exactly like one that does not exist.
async function loadDoc(req, { ownerOnly = false, withData = false } = {}) {
  const q = Document.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId });
  if (withData) q.select('+data +enc');
  const d = await q;
  if (!d || !canViewDoc(d, req.ctx.me)) throw notFound('Document not found');
  if (ownerOnly && String(d.ownerId) !== req.ctx.me) throw forbidden('Only the owner of this document can do this');
  return d;
}

documents.get('/:id/file', validate({ params: idParams, query: z.object({ inline: z.enum(['1']).optional() }).strict() }), h(async (req, res) => {
  const d = await loadDoc(req, { withData: true });
  let plain;
  try { plain = decryptFile(d.data, d.enc); } catch { throw new Error('Document could not be decrypted'); }
  await DocumentAccessLog.create({ familyId: req.ctx.familyId, documentId: d._id, byId: req.ctx.me, action: req.valid.query.inline ? 'view' : 'download' });
  const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[d.mime];
  res.set({
    'Content-Type': d.mime, 'Content-Length': plain.length, 'Cache-Control': 'private, no-store',
    'Content-Disposition': `${req.valid.query.inline ? 'inline' : 'attachment'}; filename="document-${d._id}.${ext}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
  });
  res.send(plain);
}));

documents.patch('/:id', validate({
  params: idParams,
  body: z.object({
    title: text(100).optional(), category: z.enum(DOC_CATEGORIES).optional(), visibilityMode: visibility.optional(),
    allowedIds: idList.optional(), expiryDate: ymd.nullable().optional(), maskedNumber: maskedNumber.optional(),
  }).strict(),
}), h(async (req, res) => {
  const d = await loadDoc(req, { ownerOnly: true });
  const b = req.valid.body;
  await checkAllowed(req.ctx.familyId, b.allowedIds);
  const visChanged = (b.visibilityMode && b.visibilityMode !== d.visibilityMode) || b.allowedIds;
  if (b.title) d.title = b.title;
  if (b.category) d.category = b.category;
  if (b.maskedNumber !== undefined) d.maskedNumber = b.maskedNumber;
  if (b.expiryDate !== undefined) d.expiryDate = b.expiryDate || undefined;
  if (b.visibilityMode) d.visibilityMode = b.visibilityMode;
  if (b.allowedIds) d.allowedIds = b.allowedIds;
  if (d.visibilityMode !== 'custom') d.allowedIds = [];
  if (d.visibilityMode === 'custom' && !d.allowedIds.length) throw badRequest('Choose who can see this document');
  await d.save();
  if (visChanged) {
    await DocumentAccessLog.create({ familyId: req.ctx.familyId, documentId: d._id, byId: req.ctx.me, action: 'visibility' });
    await audit(req, 'document.visibility', 'document', d._id, { mode: d.visibilityMode });
  }
  const { map } = await loadMembers(req.ctx.familyId);
  res.json(docDto(d, req.ctx.me, map, todayIn(req.ctx.family.timezone)));
}));

documents.delete('/:id', validate({ params: idParams }), h(async (req, res) => {
  const d = await loadDoc(req, { ownerOnly: true });
  await d.deleteOne();
  await releaseSpace(req.ctx.familyId, d.size);
  await DocumentAccessLog.deleteMany({ documentId: d._id });
  await audit(req, 'document.delete', 'document', d._id, { title: d.title });
  res.status(204).end();
}));

documents.get('/:id/access-log', validate({ params: idParams }), h(async (req, res) => {
  const d = await loadDoc(req, { ownerOnly: true });
  const { map } = await loadMembers(req.ctx.familyId);
  const list = await DocumentAccessLog.find({ documentId: d._id }).sort({ _id: -1 }).limit(100);
  res.json(list.map((l) => ({ by: pick(map, l.byId), action: l.action, at: l.createdAt })));
}));

// ---------- images and voice notes for chat and recipe photos (encrypted at rest, family-only) ----------
attachments.post('/', uploadLimiter, upload.single('file'), h(async (req, res) => {
  if (!req.file) throw badRequest('Attach an image or audio file');
  const mime = sniff(req.file.buffer) || (req.file.mimetype?.startsWith('audio/') ? req.file.mimetype : null);
  if (!mime || (!mime.startsWith('image/') && !mime.startsWith('audio/'))) {
    throw badRequest('Only JPG, PNG, WebP images and audio files are allowed');
  }
  await reserveSpace(req.ctx.familyId, req.file.size);
  try {
    const { data, meta } = encryptFile(req.file.buffer);
    const a = await Attachment.create({ familyId: req.ctx.familyId, uploaderId: req.ctx.me, mime, size: req.file.size, enc: meta, data });
    res.status(201).json({ id: String(a._id), mime });
  } catch (e) { await releaseSpace(req.ctx.familyId, req.file.size); throw e; }
}));

attachments.get('/:id', validate({ params: idParams }), h(async (req, res) => {
  const a = await Attachment.findOne({ _id: req.valid.params.id, familyId: req.ctx.familyId }).select('+data +enc');
  if (!a) throw notFound();
  const plain = decryptFile(a.data, a.enc);
  res.set({ 'Content-Type': a.mime, 'Content-Length': plain.length, 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
  res.send(plain);
}));
