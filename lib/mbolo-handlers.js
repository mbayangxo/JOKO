import { z } from 'zod';
import {
  completeMboloMediaUpload,
  deleteVaultItem,
  listUserVault,
  mintMboloMediaUpload,
  MboloMediaError,
  saveMessageMediaToRec,
  supabaseStorageConfigured,
} from './mbolo-media-storage-service.js';
import { incrementGifUse, listMboloGifs, mintGifUpload, registerUserGif, resolveGifForMessage } from './mbolo-gif-service.js';
import { getThreadCommerceContext } from './mbolo-commerce-service.js';
import { getThreadPresence, markThreadRead, markThreadTyping } from './mbolo-presence-service.js';
import { createUserStory, listActiveStories } from './mbolo-stories-service.js';
import { prisma } from './prisma.js';

function mediaError(res, err) {
  if (err instanceof MboloMediaError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return true;
  }
  return false;
}

export async function mboloMediaUploadUrl(req, res) {
  const schema = z.object({
    threadId: z.string().optional(),
    kind: z.enum(['photo', 'image', 'voice', 'video', 'gif']),
    mimeType: z.string().max(120),
    sizeBytes: z.number().int().positive(),
    retention: z.enum(['thread', 'vault', 'profile', 'ephemeral']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await mintMboloMediaUpload(req.userId, parsed.data);
    res.status(201).json(result);
  } catch (err) {
    if (mediaError(res, err)) return;
    throw err;
  }
}

export async function mboloMediaComplete(req, res) {
  const schema = z.object({
    assetId: z.string(),
    waveformJson: z.array(z.number()).max(200).optional(),
    durationMs: z.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  try {
    const result = await completeMboloMediaUpload(req.userId, parsed.data);
    res.json(result);
  } catch (err) {
    if (mediaError(res, err)) return;
    throw err;
  }
}

export async function mboloVaultList(req, res) {
  try {
    res.json(await listUserVault(req.userId));
  } catch (err) {
    if (mediaError(res, err)) return;
    throw err;
  }
}

export async function mboloVaultDelete(req, res) {
  const assetId = req.query.id ?? req.body?.assetId;
  if (!assetId) {
    res.status(400).json({ error: 'assetId required' });
    return;
  }
  try {
    res.json(await deleteVaultItem(req.userId, assetId));
  } catch (err) {
    if (mediaError(res, err)) return;
    throw err;
  }
}

export async function mboloGifsList(req, res) {
  res.json(await listMboloGifs(req.userId));
}

export async function mboloGifsCreate(req, res) {
  const schema = z.object({
    assetId: z.string().optional(),
    label: z.string().max(40).optional(),
    sizeBytes: z.number().int().positive().optional(),
    mimeType: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  try {
    if (parsed.data.assetId) {
      const gif = await registerUserGif(req.userId, parsed.data);
      res.status(201).json(gif);
      return;
    }
    if (!parsed.data.sizeBytes) {
      res.status(400).json({ error: 'assetId or sizeBytes required' });
      return;
    }
    const upload = await mintGifUpload(req.userId, parsed.data);
    res.status(201).json(upload);
  } catch (err) {
    if (mediaError(res, err)) return;
    throw err;
  }
}

export async function mboloGifsUse(req, res) {
  const gifId = req.query.id ?? req.body?.gifId;
  if (!gifId) {
    res.status(400).json({ error: 'gifId required' });
    return;
  }
  await incrementGifUse(gifId);
  res.json({ ok: true });
}

export function mboloStorageStatus(req, res) {
  const supabase = supabaseStorageConfigured();
  res.json({
    storage: supabase ? 'supabase' : 'legacy',
    configured: supabase,
    vaultQuotaMb: Number(process.env.MBOLO_VAULT_QUOTA_MB ?? 500),
  });
}

export async function mboloMessageSave(req, res) {
  const messageId = req.query.id;
  const schema = z.object({
    retention: z.enum(['vault', 'profile']).default('vault'),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  if (!messageId) {
    res.status(400).json({ error: 'message id required' });
    return;
  }
  try {
    res.json(await saveMessageMediaToRec(req.userId, messageId, parsed.data));
  } catch (err) {
    if (mediaError(res, err)) return;
    throw err;
  }
}

export async function mboloThreadPresence(req, res) {
  const threadId = req.query.id;
  if (!threadId) {
    res.status(400).json({ error: 'thread id required' });
    return;
  }
  const member = await prisma.mboloMember.findUnique({
    where: { threadId_userId: { threadId, userId: req.userId } },
  });
  if (!member || member.status !== 'active') {
    res.status(403).json({ error: 'Not a member' });
    return;
  }
  const [presence, commerce] = await Promise.all([
    getThreadPresence(threadId, req.userId),
    getThreadCommerceContext(prisma, threadId),
  ]);
  res.json({ ...presence, commerce });
}

export async function mboloThreadTyping(req, res) {
  const threadId = req.query.id;
  if (!threadId) {
    res.status(400).json({ error: 'thread id required' });
    return;
  }
  try {
    res.json(await markThreadTyping(req.userId, threadId));
  } catch {
    res.status(403).json({ error: 'Not a member' });
  }
}

export async function mboloThreadRead(req, res) {
  const threadId = req.query.id;
  if (!threadId) {
    res.status(400).json({ error: 'thread id required' });
    return;
  }
  try {
    res.json(await markThreadRead(req.userId, threadId));
  } catch {
    res.status(403).json({ error: 'Not a member' });
  }
}

export async function mboloStoriesList(req, res) {
  res.json(await listActiveStories(req.userId));
}

export async function mboloStoriesCreate(req, res) {
  const schema = z.object({
    body: z.string().max(500).optional(),
    mediaUrl: z.string().max(800_000).optional(),
    mediaAssetId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  try {
    const story = await createUserStory(req.userId, parsed.data);
    res.status(201).json(story);
  } catch (err) {
    if (mediaError(res, err)) return;
    throw err;
  }
}

export async function mboloDeviceKeysRegister(req, res) {
  const schema = z.object({
    publicKey: z.string().min(32).max(4000),
    deviceLabel: z.string().max(80).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid device key' });
    return;
  }
  const row = await prisma.userDeviceKey.create({
    data: {
      userId: req.userId,
      publicKey: parsed.data.publicKey,
      deviceLabel: parsed.data.deviceLabel ?? null,
    },
  });
  res.status(201).json({
    id: row.id,
    deviceLabel: row.deviceLabel,
    note: 'Device key registered — E2E message encryption rolls out in a future app update',
  });
}
