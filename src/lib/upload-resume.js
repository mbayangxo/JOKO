/**
 * J12 — interrupted-upload recovery for chat media (pure; unit-tested).
 *
 * An upload is four steps: mint (signed URL + asset id) → PUT bytes → complete (asset ready) → send the
 * message. A weak network can cut any of them. The checkpoint records how far one attempt got, so a retry
 * resumes from the first unfinished step instead of starting over:
 *   - a finished step is never redone (no second asset, no second message, no double vault charge);
 *   - a signed URL that expired is re-minted (the server only marks an asset ready after `complete`);
 *   - the message carries ONE client message id for every attempt (server de-duplicates; P-J12-3);
 *   - definite refusals (403/404/413/507 …) stop the attempt — the server's decision wins.
 * Media bytes are NOT persisted across an app kill (size, privacy): after a restart the user re-picks.
 */
export const UPLOAD_URL_TTL_MS = 60 * 60 * 1000;

export function newUploadCheckpoint(clientMessageId, now = Date.now()) {
  return { clientMessageId, startedAt: now, mint: null, mintedAt: null, put: false, complete: null, message: null, attempts: 0 };
}

const definite = (e) => {
  const s = e?.status;
  return typeof s === 'number' && s >= 400 && s < 500 && ![408, 425, 429].includes(s);
};

/**
 * Runs (or resumes) one upload. `steps` = { mint(), put(mint), complete(mint), send(complete, clientMessageId) }.
 * Mutates and returns the checkpoint; throws the step's error (annotated with `.resumable`).
 */
export async function runUpload(cp, steps, { now = () => Date.now() } = {}) {
  cp.attempts += 1;
  try {
    if (cp.mint && !cp.put && now() - cp.mintedAt > UPLOAD_URL_TTL_MS) {
      cp.mint = null; // the signed URL expired before the bytes went up: mint again
      cp.mintedAt = null;
    }
    if (!cp.mint) {
      cp.mint = await steps.mint();
      cp.mintedAt = now();
    }
    if (!cp.put) {
      await steps.put(cp.mint);
      cp.put = true;
    }
    if (!cp.complete) cp.complete = await steps.complete(cp.mint);
    if (!cp.message) cp.message = await steps.send(cp.complete, cp.clientMessageId);
    return cp;
  } catch (e) {
    e.resumable = !definite(e);
    throw e;
  }
}

/** What the UI should say about an upload checkpoint. */
export function uploadState(cp) {
  if (!cp) return 'idle';
  if (cp.message) return 'sent';
  if (cp.complete) return 'sending';
  if (cp.put) return 'finishing';
  if (cp.mint) return 'uploading';
  return 'starting';
}
