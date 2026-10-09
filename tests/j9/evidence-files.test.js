/**
 * A6: private evidence attachments. Type sniffed from the bytes, ≤ 1 MB, active PDFs refused,
 * image metadata (EXIF / GPS / text) stripped; only the parties read files, operators only on a
 * disputed assignment with a reason; every read audited; retention purges bytes (record kept)
 * except while a dispute is open; caps per assignment; text evidence unchanged.
 */
import '../helpers/setup.js';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../helpers/db.js';
import { startApiServer } from '../helpers/http-harness.js';
import { assertInvariants } from '../../lib/money-kernel/invariants.js';
import { assertWorkInvariants } from '../../lib/work/invariants.js';
import { purgeExpiredEvidenceFiles, sanitize } from '../../lib/work/evidence-files.js';
import { operator } from '../j3/helpers.js';
import { employer, hire, ok, worker } from './fixture.js';

let api;
before(async () => { api = await startApiServer({ JOKKO_WORK_MONEY_ENABLED: 'true' }); });
after(async () => { await api?.stop(); await prisma.$disconnect(); });
afterEach(async () => {
  await assertInvariants(prisma);
  await assertWorkInvariants(prisma);
});

const seg = (marker, payload) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = marker; b.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([b, payload]); };
const jpeg = (gps = 'GPS 14.6928N 17.4467W') => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
  seg(0xe1, Buffer.from(`Exif\0\0${gps}`, 'latin1')),
  seg(0xfe, Buffer.from('camera comment', 'latin1')),
  seg(0xdb, Buffer.alloc(65, 1)),
  Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0]), crypto.randomBytes(64), Buffer.from([0xff, 0xd9]),
]);
const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32BE(data.length, 0); h.write(type, 4, 'latin1'); return Buffer.concat([h, data, Buffer.alloc(4)]); };
const png = (extra = crypto.randomBytes(8)) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13, 1)), chunk('tEXt', Buffer.from('Location\0Pikine, rue 10', 'latin1')),
  chunk('ruSt', extra), chunk('IDAT', crypto.randomBytes(32)), chunk('IEND', Buffer.alloc(0)),
]);
const b64 = (b) => b.toString('base64');

test('validation: sniffed type must match; metadata stripped; active PDF, oversize, disguised files refused', () => {
  const j = sanitize('image/jpeg', b64(jpeg()));
  assert.ok(!j.bytes.toString('latin1').includes('GPS') && !j.bytes.toString('latin1').includes('Exif') && !j.bytes.toString('latin1').includes('camera comment'), 'EXIF / GPS / comment removed');
  assert.ok(j.bytes.toString('latin1').includes('JFIF') && j.bytes[0] === 0xff && j.bytes.at(-1) === 0xd9, 'image data kept');
  assert.match(j.stripped, /jpeg/);
  const p = sanitize('image/png', b64(png()));
  assert.ok(!p.bytes.toString('latin1').includes('Pikine'), 'PNG text chunk (location) removed');
  const code = (fn) => { try { fn(); return 'accepted'; } catch (e) { return e.code; } };
  assert.equal(code(() => sanitize('image/jpeg', b64(png()))), 'type_mismatch');
  assert.equal(code(() => sanitize('image/png', b64(Buffer.from('<html><script>alert(1)</script></html>')))), 'type_mismatch');
  assert.equal(code(() => sanitize('text/html', b64(Buffer.from('<html>')))), 'unsupported_type');
  assert.equal(code(() => sanitize('application/pdf', b64(Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF')))), 'invalid_file');
  assert.equal(sanitize('application/pdf', b64(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF'))).mime, 'application/pdf');
  assert.equal(code(() => sanitize('image/jpeg', b64(Buffer.concat([jpeg(), Buffer.alloc(1_000_001)])))), 'too_large');
});

test('private access + audit: parties only; operators only on a disputed assignment with a reason; retention keeps the record', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const { assignment } = await hire(api, e, w);
  const up = ok(await w.call('POST', `work/assignments/${assignment.id}/evidence/files`, { mime: 'image/jpeg', dataBase64: b64(jpeg()), milestoneSeq: 1, note: 'Rayon terminé' }));
  assert.equal(up.metadataRemoved, true);
  // Text evidence still works alongside files.
  ok(await w.call('POST', `work/assignments/${assignment.id}/submit`, { seq: 1, content: 'Inventaire terminé, voir photo jointe.' }));
  // Outsiders: nothing, not even existence.
  const stranger = await worker(api);
  assert.equal((await stranger.call('GET', `work/evidence/files/${up.id}`)).status, 404);
  assert.equal((await stranger.call('POST', `work/assignments/${assignment.id}/evidence/files`, { mime: 'image/png', dataBase64: b64(png()) })).status, 404);
  const other = await employer(api);
  assert.equal((await other.owner.call('GET', `businesses/${other.b.id}/work/evidence/files/${up.id}`)).status, 404);
  assert.equal((await other.owner.call('GET', `businesses/${e.b.id}/work/assignments/${assignment.id}/evidence/files`)).status, 404);
  // The business reads it (no-store, audited); the list is metadata only.
  const list = ok(await e.owner.call('GET', `businesses/${e.b.id}/work/assignments/${assignment.id}/evidence/files`));
  assert.ok(list.files.length >= 1 && list.files.every((f) => !('dataBase64' in f)));
  assert.equal(list.files[0].milestoneSeq, 1);
  const got = await e.owner.call('GET', `businesses/${e.b.id}/work/evidence/files/${up.id}`);
  assert.equal(got.status, 200);
  assert.ok(!Buffer.from(got.body.dataBase64, 'base64').toString('latin1').includes('GPS'));
  assert.match(got.headers['cache-control'] ?? '', /no-store/);
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  // Operators: refused without a dispute; with a dispute only with a reason; audited.
  const ops = await operator(api, ['work_ops']);
  assert.equal((await ops.call('POST', `admin/work/evidence/files/${up.id}/view`, { reason: 'Contrôle de routine sans litige.' })).body.code, 'not_disputed');
  const d = ok(await e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/disputes`, { kind: 'false_completion', milestoneSeq: 1, reason: 'Le rayon n’a pas été compté.' }));
  assert.equal((await ops.call('POST', `admin/work/evidence/files/${up.id}/view`, {})).status, 400);
  ok(await ops.call('POST', `admin/work/evidence/files/${up.id}/view`, { reason: `Instruction du litige ${d.id}` }));
  const audit = await prisma.workEvidenceAccess.findMany({ where: { fileId: up.id } });
  assert.deepEqual(audit.map((a) => a.actorType).sort(), ['business', 'operator']);
  assert.ok(audit.find((a) => a.actorType === 'operator').reason.includes(d.id));
  // Retention: expired but the dispute is open → held; once closed → bytes purged, record kept, 410.
  await prisma.workEvidenceFile.updateMany({ where: { assignmentId: assignment.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.ok((await purgeExpiredEvidenceFiles(prisma)).held >= 1);
  assert.equal((await w.call('GET', `work/evidence/files/${up.id}`)).status, 200, 'legal hold while disputed');
  await prisma.workDispute.update({ where: { id: d.id }, data: { status: 'resolved', resolvedAt: new Date() } });
  await purgeExpiredEvidenceFiles(prisma);
  assert.equal((await w.call('GET', `work/evidence/files/${up.id}`)).status, 410);
  const kept = await prisma.workEvidenceFile.findUnique({ where: { id: up.id } });
  assert.deepEqual([kept.bytes, kept.sha256 === up.sha256, Boolean(kept.purgedAt)], [null, true, true]);
  assert.equal((await purgeExpiredEvidenceFiles(prisma)).purged, 0, 'idempotent');
});

test('caps: 20 files per assignment, duplicates replay, concurrent uploads respect the cap', async () => {
  const e = await employer(api);
  const w = await worker(api);
  const { assignment } = await hire(api, e, w);
  const same = b64(png(Buffer.from('same')));
  const first = ok(await w.call('POST', `work/assignments/${assignment.id}/evidence/files`, { mime: 'image/png', dataBase64: same }));
  assert.equal(ok(await w.call('POST', `work/assignments/${assignment.id}/evidence/files`, { mime: 'image/png', dataBase64: same })).replayed, true);
  const res = await Promise.all(Array.from({ length: 24 }, () => e.owner.call('POST', `businesses/${e.b.id}/work/assignments/${assignment.id}/evidence/files`, { mime: 'image/png', dataBase64: b64(png()) })));
  assert.equal(await prisma.workEvidenceFile.count({ where: { assignmentId: assignment.id } }), 20);
  assert.ok(res.filter((r) => r.status === 409).length === 5, `refused: ${res.map((r) => r.status).join(',')}`);
  assert.ok(first.id);
});

test('API body cap: an oversized request is refused with 413 before any handler runs', async () => {
  const w = await worker(api);
  const r = await w.call('POST', 'work/assignments/none/evidence/files', { mime: 'image/png', dataBase64: 'A'.repeat(2_100_000) });
  assert.equal(r.status, 413);
  assert.equal(r.body.code, 'payload_too_large');
});
