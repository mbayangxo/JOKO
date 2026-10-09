import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { OrgAccessError, assertBusinessAuthorityInTx } from '../business-access.js';
import { WorkError } from './contract.js';

/**
 * A6: private evidence attachments for work (photos / documents), alongside text evidence.
 *  - Private: bytes are stored server-side and only returned through authorized API reads, with
 *    `no-store`; never a public or long-lived URL.
 *  - Validated: the content type is sniffed from the bytes (JPEG, PNG, WebP, PDF only) and must
 *    match the declared type; ≤ 1 MB; PDFs with active content (JavaScript, launch actions,
 *    embedded files) are refused.
 *  - Privacy: image metadata (EXIF incl. GPS location, XMP, comments, text chunks) is stripped.
 *  - Limits: ≤ 20 files per assignment, ≤ 30 uploads per person per day.
 *  - Retention: bytes purged after WORK_EVIDENCE_RETENTION_DAYS (default 180, bounded 30–730)
 *    unless a dispute on the assignment is still open; the sha256 + metadata remain as the record.
 *  - Audit: every read (parties and operators) is recorded in WorkEvidenceAccess; operators read
 *    only files on an assignment that has a dispute, and must give a reason.
 */
export const MAX_BYTES = 1_000_000;
const MAX_PER_ASSIGNMENT = 20;
const MAX_PER_DAY = 30;
const OPEN_DISPUTE = ['open', 'appealed', 'awaiting_settlement'];
export const MIME = { 'image/jpeg': 'photo_ref', 'image/png': 'photo_ref', 'image/webp': 'photo_ref', 'application/pdf': 'document_ref' };

export function retentionDays() {
  const n = Number(process.env.WORK_EVIDENCE_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 30 && n <= 730 ? n : 180;
}

const bad = (msg, code = 'invalid_file') => new WorkError(code, msg, 422);
const notFound = () => new WorkError('not_found', 'Pièce introuvable', 404);

export function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** JPEG: drop APP1–APP15 (EXIF / XMP / GPS …) and COM segments before the scan; keep the rest byte-exact. */
function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)];
  let i = 2;
  let removed = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw bad('Image JPEG invalide');
    const marker = buf[i + 1];
    if (marker === 0xda) { out.push(buf.subarray(i)); i = buf.length; break; } // start of scan: the rest is image data
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw bad('Image JPEG invalide');
    const seg = buf.subarray(i, i + 2 + len);
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) removed += 1;
    else out.push(seg);
    i += 2 + len;
  }
  if (i < buf.length) throw bad('Image JPEG invalide');
  return { bytes: Buffer.concat(out), stripped: removed ? `jpeg:app/com x${removed}` : null };
}

/** PNG: drop text / EXIF / time chunks (tEXt, zTXt, iTXt, eXIf, tIME); chunks are copied whole, CRCs intact. */
function stripPng(buf) {
  const DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  const out = [buf.subarray(0, 8)];
  let i = 8;
  let removed = 0;
  let ended = false;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw bad('Image PNG invalide');
    if (DROP.has(type)) removed += 1;
    else out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended) throw bad('Image PNG invalide');
  return { bytes: Buffer.concat(out), stripped: removed ? `png:text/exif x${removed}` : null };
}

/** WebP: drop EXIF / XMP chunks, clear their VP8X flags, rewrite the RIFF size. */
function stripWebp(buf) {
  const out = [];
  let i = 12;
  let removed = 0;
  while (i + 8 <= buf.length) {
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > buf.length) throw bad('Image WebP invalide');
    if (type === 'EXIF' || type === 'XMP ') removed += 1;
    else {
      const chunk = Buffer.from(buf.subarray(i, Math.min(end, buf.length)));
      if (type === 'VP8X' && chunk.length > 8) chunk[8] &= ~0x0c; // clear EXIF (0x08) and XMP (0x04) flags
      out.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(out);
  const head = Buffer.from('RIFF0000WEBP', 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  return { bytes: Buffer.concat([head, body]), stripped: removed ? `webp:exif/xmp x${removed}` : null };
}

function checkPdf(buf) {
  const text = buf.toString('latin1');
  if (/\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|OpenAction|AA)\b/.test(text)) throw bad('PDF refusé : contenu actif (script, action ou fichier intégré)');
  if (!/%%EOF\s*$/.test(text.slice(-1024))) throw bad('PDF invalide ou tronqué');
  return { bytes: buf, stripped: null };
}

/** Validate and sanitize an upload. Exported for tests. */
export function sanitize(declaredMime, dataBase64) {
  if (!MIME[declaredMime]) throw bad('Type de fichier non accepté (JPEG, PNG, WebP ou PDF)', 'unsupported_type');
  if (typeof dataBase64 !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(dataBase64)) throw bad('Fichier illisible');
  const raw = Buffer.from(dataBase64, 'base64');
  if (!raw.length) throw bad('Fichier vide');
  if (raw.length > MAX_BYTES) throw bad('Fichier trop lourd (1 Mo maximum) — réduis la photo', 'too_large');
  const actual = sniff(raw);
  if (actual !== declaredMime) throw bad('Le contenu ne correspond pas au type annoncé', 'type_mismatch');
  const r = actual === 'image/jpeg' ? stripJpeg(raw) : actual === 'image/png' ? stripPng(raw) : actual === 'image/webp' ? stripWebp(raw) : checkPdf(raw);
  return { ...r, mime: actual };
}

async function partyRole(db, userId, a, businessId) {
  if (businessId) {
    if (a.businessId !== businessId) throw notFound();
    try {
      await assertBusinessAuthorityInTx(db, userId, businessId, 'business.staffing.manage');
    } catch (e) {
      if (e instanceof OrgAccessError) throw notFound();
      throw e;
    }
    return 'business';
  }
  if (a.workerUserId !== userId) throw notFound();
  return 'worker';
}

const meta = (f, seqById = new Map()) => ({
  id: f.id, role: f.role, mime: f.mime, sizeBytes: f.sizeBytes, sha256: f.sha256, milestoneSeq: f.milestoneId ? seqById.get(f.milestoneId) ?? null : null,
  disputeId: f.disputeId, metadataRemoved: Boolean(f.stripped), createdAt: f.createdAt.toISOString(), expiresAt: f.expiresAt.toISOString(), purged: Boolean(f.purgedAt),
});

/** Upload an attachment (worker of the assignment, or the business with staffing rights). */
export async function uploadEvidenceFile(userId, assignmentId, { businessId = null, mime, dataBase64, milestoneSeq = null, disputeId = null, note = '' }) {
  const a = await prisma.workAssignment.findUnique({ where: { id: assignmentId } });
  if (!a) throw notFound();
  const role = await partyRole(prisma, userId, a, businessId);
  const clean = sanitize(mime, dataBase64);
  let milestoneId = null;
  if (milestoneSeq != null) {
    const m = await prisma.workMilestone.findUnique({ where: { assignmentId_seq: { assignmentId: a.id, seq: Number(milestoneSeq) } } });
    if (!m) throw new WorkError('not_found', 'Étape introuvable', 404);
    milestoneId = m.id;
  }
  if (disputeId) {
    const d = await prisma.workDispute.findUnique({ where: { id: disputeId } });
    if (!d || d.assignmentId !== a.id) throw new WorkError('not_found', 'Litige introuvable', 404);
    if (!['open', 'appealed'].includes(d.status)) throw new WorkError('invalid_state', 'Litige clos');
    milestoneId = milestoneId ?? d.milestoneId;
  }
  const sha256 = crypto.createHash('sha256').update(clean.bytes).digest('hex');
  return prisma.$transaction(async (tx) => {
    // Serialize per assignment so the caps hold under concurrent uploads.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`work-evidence:${a.id}`}, 0))`;
    const dup = await tx.workEvidenceFile.findFirst({ where: { assignmentId: a.id, sha256, purgedAt: null } });
    if (dup) return { ...meta(dup), replayed: true };
    if ((await tx.workEvidenceFile.count({ where: { assignmentId: a.id } })) >= MAX_PER_ASSIGNMENT) throw new WorkError('limit_reached', `${MAX_PER_ASSIGNMENT} pièces maximum par mission`, 409);
    if ((await tx.workEvidenceFile.count({ where: { uploaderId: userId, createdAt: { gte: new Date(Date.now() - 86_400_000) } } })) >= MAX_PER_DAY) throw new WorkError('limit_reached', 'Trop de pièces envoyées aujourd’hui', 429);
    const ev = await tx.workEvidence.create({ data: { assignmentId: a.id, milestoneId, disputeId, byUserId: userId, role, kind: MIME[clean.mime], content: `fichier ${clean.mime} sha256:${sha256.slice(0, 16)}${note ? ` — ${String(note).slice(0, 300)}` : ''}` } });
    const f = await tx.workEvidenceFile.create({
      data: { evidenceId: ev.id, assignmentId: a.id, milestoneId, disputeId, uploaderId: userId, role, mime: clean.mime, sizeBytes: clean.bytes.length, sha256, bytes: clean.bytes, stripped: clean.stripped, expiresAt: new Date(Date.now() + retentionDays() * 86_400_000) },
    });
    return meta(f);
  });
}

/** Metadata list for a party (no bytes). */
export async function listEvidenceFiles(userId, assignmentId, { businessId = null } = {}) {
  const a = await prisma.workAssignment.findUnique({ where: { id: assignmentId } });
  if (!a) throw notFound();
  await partyRole(prisma, userId, a, businessId);
  const [files, ms] = await Promise.all([
    prisma.workEvidenceFile.findMany({ where: { assignmentId: a.id }, orderBy: { createdAt: 'asc' }, select: { id: true, role: true, mime: true, sizeBytes: true, sha256: true, milestoneId: true, disputeId: true, stripped: true, createdAt: true, expiresAt: true, purgedAt: true } }),
    prisma.workMilestone.findMany({ where: { assignmentId: a.id }, select: { id: true, seq: true } }),
  ]);
  const seq = new Map(ms.map((m) => [m.id, m.seq]));
  return { files: files.map((f) => meta(f, seq)) };
}

async function readFile(fileId) {
  const f = await prisma.workEvidenceFile.findUnique({ where: { id: fileId } });
  if (!f) throw notFound();
  return f;
}

function shape(f) {
  if (f.purgedAt || !f.bytes) throw new WorkError('purged', 'Pièce supprimée à la fin de la durée de conservation (empreinte conservée)', 410);
  return { ...meta(f), dataBase64: Buffer.from(f.bytes).toString('base64') };
}

/** A party reads a file (audited). */
export async function getEvidenceFileForParty(userId, fileId, { businessId = null } = {}) {
  const f = await readFile(fileId);
  const a = await prisma.workAssignment.findUnique({ where: { id: f.assignmentId } });
  const role = await partyRole(prisma, userId, a, businessId);
  await prisma.workEvidenceAccess.create({ data: { fileId: f.id, actorType: role, actorId: userId } });
  return shape(f);
}

/** An operator reads a file: only when the assignment has a dispute; a reason is required (audited). */
export async function getEvidenceFileForOps(adminId, fileId, { reason }) {
  if (!reason || String(reason).trim().length < 10) throw new WorkError('reason_required', 'Motif requis (10 caractères minimum)', 400);
  const f = await readFile(fileId);
  const disputed = await prisma.workDispute.findFirst({ where: { assignmentId: f.assignmentId } });
  if (!disputed) throw new WorkError('not_disputed', 'Accès réservé aux missions en litige', 403);
  await prisma.workEvidenceAccess.create({ data: { fileId: f.id, actorType: 'operator', actorId: adminId, reason: String(reason).slice(0, 300) } });
  return shape(f);
}

/** Retention job: purge expired bytes unless a dispute on the assignment is still open. Idempotent. */
export async function purgeExpiredEvidenceFiles(db = prisma, now = new Date()) {
  const due = await db.workEvidenceFile.findMany({ where: { expiresAt: { lte: now }, purgedAt: null }, select: { id: true, assignmentId: true }, take: 500 });
  let purged = 0;
  let held = 0;
  for (const f of due) {
    if (await db.workDispute.findFirst({ where: { assignmentId: f.assignmentId, status: { in: OPEN_DISPUTE } } })) { held += 1; continue; }
    const u = await db.workEvidenceFile.updateMany({ where: { id: f.id, purgedAt: null }, data: { bytes: null, purgedAt: now } });
    purged += u.count;
  }
  return { purged, held };
}
