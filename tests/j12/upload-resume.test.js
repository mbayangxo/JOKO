/**
 * J12 — interrupted uploads.
 *  1. The resumable pipeline (src/lib/upload-resume.js): a cut at every step resumes from the first
 *     unfinished step; nothing finished is redone; an expired signed URL is re-minted; a definite
 *     refusal stops; the message keeps one client id across attempts.
 *  2. J12-F9 (server): concurrent / retried completion marks the asset ready and charges the vault quota
 *     exactly once. Storage signing is answered by a LOCAL fake HTTP server (no external service).
 */
import '../helpers/setup.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { newUploadCheckpoint, runUpload, uploadState, UPLOAD_URL_TTL_MS } from '../../src/lib/upload-resume.js';
import { createUserWithWallet, prisma } from '../helpers/db.js';

function fakeSteps({ failAt = {}, refuseAt = null } = {}) {
  const calls = { mint: 0, put: 0, complete: 0, send: 0 };
  const sentIds = [];
  const step = (name, value) => async (...args) => {
    calls[name] += 1;
    if (refuseAt === name) throw Object.assign(new Error('refusé'), { status: 403 });
    if (failAt[name] > 0) {
      failAt[name] -= 1;
      throw Object.assign(new Error('Network request failed'), { code: 'network' });
    }
    if (name === 'send') sentIds.push(args[1]);
    return typeof value === 'function' ? value(calls[name]) : value;
  };
  return {
    calls, sentIds,
    steps: { mint: step('mint', (n) => ({ assetId: `asset-${n}`, uploadUrl: 'u' })), put: step('put', true), complete: step('complete', { readUrl: 'r' }), send: step('send', { id: 'msg-1' }) },
  };
}

test('a cut at each step resumes from there; nothing finished is redone; one client id for the message', async () => {
  for (const at of ['mint', 'put', 'complete', 'send']) {
    const f = fakeSteps({ failAt: { [at]: 2 } });
    const cp = newUploadCheckpoint('cm-abc12345');
    for (let i = 0; i < 2; i += 1) await assert.rejects(runUpload(cp, f.steps), (e) => e.resumable === true);
    await runUpload(cp, f.steps);
    assert.equal(uploadState(cp), 'sent', at);
    assert.equal(f.calls.mint, at === 'mint' ? 3 : 1, `${at}: one asset minted`);
    assert.equal(f.calls.put, at === 'mint' ? 1 : at === 'put' ? 3 : 1);
    assert.equal(f.calls.complete, at === 'complete' ? 3 : 1);
    assert.ok(f.sentIds.every((id) => id === 'cm-abc12345'), 'every send attempt carries the same client id');
  }
});

test('an expired signed URL is re-minted before the bytes go up — never after', async () => {
  const f = fakeSteps({ failAt: { put: 1 } });
  let t = 1_000;
  const cp = newUploadCheckpoint('cm-exp12345', t);
  await assert.rejects(runUpload(cp, f.steps, { now: () => t }));
  t += UPLOAD_URL_TTL_MS + 1;
  await runUpload(cp, f.steps, { now: () => t });
  assert.equal(f.calls.mint, 2, 're-minted once');
  assert.equal(cp.mint.assetId, 'asset-2');
  const g = fakeSteps({ failAt: { complete: 1 } });
  const cp2 = newUploadCheckpoint('cm-exp67890', 0);
  await assert.rejects(runUpload(cp2, g.steps, { now: () => 0 }));
  await runUpload(cp2, g.steps, { now: () => UPLOAD_URL_TTL_MS * 5 });
  assert.equal(g.calls.mint, 1, 'bytes already up: the asset is completed, not replaced');
});

test('a definite refusal stops the attempt (the server decides), and is not marked resumable', async () => {
  const f = fakeSteps({ refuseAt: 'send' });
  const cp = newUploadCheckpoint('cm-ref12345');
  await assert.rejects(runUpload(cp, f.steps), (e) => e.resumable === false);
  assert.equal(uploadState(cp), 'sending');
});

let fake;
before(async () => {
  fake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ signedURL: 'https://storage.local/signed' }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-fake-service-role-key-for-tests';
});
after(async () => {
  fake?.close();
  await prisma.$disconnect();
});

test('J12-F9: concurrent completions of one vault upload mark it ready and charge the quota exactly once', async () => {
  const { completeMboloMediaUpload } = await import('../../lib/mbolo-media-storage-service.js');
  const u = await createUserWithWallet({ koriBalance: 0 });
  const asset = await prisma.mbooloMediaAsset.create({ data: { ownerId: u.id, bucket: 'b', storagePath: `u/${u.id}/v.m4a`, mimeType: 'audio/mp4', kind: 'voice', sizeBytes: 12_345, retention: 'vault' } });
  const rs = await Promise.allSettled(Array.from({ length: 6 }, () => completeMboloMediaUpload(u.id, { assetId: asset.id, durationMs: 4000 })));
  assert.ok(rs.every((r) => r.status === 'fulfilled'), JSON.stringify(rs.map((r) => r.reason?.message)));
  assert.equal((await prisma.mbooloMediaAsset.findUnique({ where: { id: asset.id } })).status, 'ready');
  assert.equal((await prisma.userMediaVault.findUnique({ where: { userId: u.id } })).usedBytes, 12_345, 'charged once');
});
