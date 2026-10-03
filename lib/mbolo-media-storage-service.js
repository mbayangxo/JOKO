/**
 * Mboolo media — Supabase Storage + vault quota (Rec memories).
 */

import { randomUUID } from 'crypto';
import { prisma } from './prisma.js';
import {
  buildStoragePath,
  createSignedReadUrl,
  createSignedUploadUrl,
  mimeToExt,
  removeObject,
  storageBucketName,
  supabaseStorageConfigured,
} from './supabase-storage.js';

export { supabaseStorageConfigured };

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_VOICE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_GIF_BYTES = 15 * 1024 * 1024;

const KIND_LIMITS = {
  photo: MAX_PHOTO_BYTES,
  image: MAX_PHOTO_BYTES,
  voice: MAX_VOICE_BYTES,
  video: MAX_VIDEO_BYTES,
  gif: MAX_GIF_BYTES,
};

export function defaultVaultQuotaBytes() {
  const mb = Number(process.env.MBOLO_VAULT_QUOTA_MB ?? 500);
  return Math.max(50, mb) * 1024 * 1024;
}

export class MboloMediaError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function ensureVault(userId, db = prisma) {
  return db.userMediaVault.upsert({
    where: { userId },
    create: { userId, quotaBytes: defaultVaultQuotaBytes(), usedBytes: 0 },
    update: {},
  });
}

async function assertThreadMember(userId, threadId, db = prisma) {
  const member = await db.mboloMember.findUnique({
    where: { threadId_userId: { threadId, userId } },
  });
  if (!member || member.status !== 'active') throw new MboloMediaError('forbidden', 'Not a member of this thread', 403);
}

export async function mintMboloMediaUpload(userId, { threadId, kind, mimeType, sizeBytes, retention = 'thread' }) {
  if (!supabaseStorageConfigured()) {
    throw new MboloMediaError('storage_unavailable', 'Supabase Storage required for media — configure SUPABASE_URL', 503);
  }

  const normalizedKind = kind === 'image' ? 'photo' : kind;
  if (!['photo', 'voice', 'video', 'gif'].includes(normalizedKind)) {
    throw new MboloMediaError('invalid_kind', 'Invalid media kind');
  }

  const limit = KIND_LIMITS[normalizedKind] ?? MAX_PHOTO_BYTES;
  if (!sizeBytes || sizeBytes <= 0 || sizeBytes > limit) {
    throw new MboloMediaError('file_too_large', `File too large (max ${Math.round(limit / (1024 * 1024))} MB)`);
  }

  if (threadId) await assertThreadMember(userId, threadId);

  if (retention === 'vault' || retention === 'profile') {
    const vault = await ensureVault(userId);
    if (vault.usedBytes + sizeBytes > vault.quotaBytes) {
      throw new MboloMediaError('vault_full', 'Rec vault full — delete memories to free space', 507);
    }
  }

  const ext = mimeToExt(mimeType);
  const storagePath = buildStoragePath({ userId, threadId, kind: normalizedKind, ext });
  const bucket = storageBucketName();

  const asset = await prisma.mbooloMediaAsset.create({
    data: {
      ownerId: userId,
      threadId: threadId ?? null,
      bucket,
      storagePath,
      mimeType: mimeType ?? 'application/octet-stream',
      kind: normalizedKind,
      sizeBytes,
      status: 'pending',
      retention,
    },
  });

  const { uploadUrl, token } = await createSignedUploadUrl(storagePath);

  return {
    assetId: asset.id,
    uploadUrl,
    token,
    headers: { 'Content-Type': mimeType ?? 'application/octet-stream' },
    expiresIn: 3600,
  };
}

export async function completeMboloMediaUpload(userId, { assetId, waveformJson, durationMs }) {
  const asset = await prisma.mbooloMediaAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.ownerId !== userId) {
    throw new MboloMediaError('not_found', 'Media asset not found', 404);
  }
  if (asset.status === 'ready') {
    return { asset, readUrl: await createSignedReadUrl(asset.storagePath) };
  }

  const readUrl = await createSignedReadUrl(asset.storagePath);

  const updated = await prisma.$transaction(async (tx) => {
    if (asset.retention === 'vault' || asset.retention === 'profile') {
      const vault = await ensureVault(userId, tx);
      if (vault.usedBytes + asset.sizeBytes > vault.quotaBytes) {
        throw new MboloMediaError('vault_full', 'Rec vault full', 507);
      }
      await tx.userMediaVault.update({
        where: { userId },
        data: { usedBytes: { increment: asset.sizeBytes } },
      });
    }

    return tx.mbooloMediaAsset.update({
      where: { id: assetId },
      data: {
        status: 'ready',
        waveformJson: waveformJson ?? undefined,
        durationMs: durationMs ?? undefined,
      },
    });
  });

  return { asset: updated, readUrl };
}

export async function getMediaReadUrl(assetId, userId) {
  const asset = await prisma.mbooloMediaAsset.findUnique({
    where: { id: assetId },
    include: { thread: { include: { members: true } } },
  });
  if (!asset || asset.status !== 'ready') {
    throw new MboloMediaError('not_found', 'Media not found', 404);
  }

  const isOwner = asset.ownerId === userId;
  const isMember = asset.thread?.members?.some((m) => m.userId === userId && m.status === 'active');
  const isProfilePublic = asset.retention === 'profile' && asset.profileVisible;

  if (!isOwner && !isMember && !isProfilePublic) {
    throw new MboloMediaError('forbidden', 'Access denied', 403);
  }

  if (asset.sourceUrl) return asset.sourceUrl;

  return createSignedReadUrl(asset.storagePath);
}

export async function resolveMessageMediaUrl(message, viewerUserId) {
  if (message.mediaAssetId) {
    try {
      return await getMediaReadUrl(message.mediaAssetId, viewerUserId);
    } catch {
      return null;
    }
  }
  if (message.mediaUrl?.startsWith('https://')) return message.mediaUrl;
  return message.mediaUrl;
}

export async function listUserVault(userId) {
  const vault = await ensureVault(userId);

  const items = await prisma.mbooloMediaAsset.findMany({
    where: {
      ownerId: userId,
      status: 'ready',
      retention: { in: ['vault', 'profile'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const withUrls = await Promise.all(
    items.map(async (item) => {
      let readUrl = item.sourceUrl ?? null;
      if (!readUrl && supabaseStorageConfigured() && !item.storagePath.startsWith('legacy/')) {
        try {
          readUrl = await createSignedReadUrl(item.storagePath);
        } catch {
          readUrl = null;
        }
      }
      return { ...item, readUrl };
    }),
  );

  return {
    quotaBytes: vault.quotaBytes,
    usedBytes: vault.usedBytes,
    items: withUrls,
    storage: supabaseStorageConfigured() ? 'supabase' : 'legacy',
  };
}

export async function deleteVaultItem(userId, assetId) {
  const asset = await prisma.mbooloMediaAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.ownerId !== userId) {
    throw new MboloMediaError('not_found', 'Not found', 404);
  }

  await prisma.$transaction(async (tx) => {
    await tx.mbooloMediaAsset.delete({ where: { id: assetId } });
    if (asset.retention === 'vault' || asset.retention === 'profile') {
      const vault = await ensureVault(userId, tx);
      await tx.userMediaVault.update({
        where: { userId },
        data: { usedBytes: Math.max(0, vault.usedBytes - asset.sizeBytes) },
      });
    }
  });

  try {
    if (supabaseStorageConfigured() && !asset.storagePath.startsWith('legacy/')) {
      await removeObject(asset.storagePath);
    }
  } catch (err) {
    console.warn('[mbolo-media] storage delete failed', err.message);
  }

  return { ok: true };
}

export function rejectLegacyDataUrl(mediaUrl) {
  if (!supabaseStorageConfigured()) return;
  if (mediaUrl?.startsWith('data:')) {
    throw new MboloMediaError(
      'legacy_media_disabled',
      'Direct uploads disabled — use /api/mbolo/media/upload-url (Supabase Storage)',
      400,
    );
  }
}

const LEGACY_KIND_MAP = {
  image: 'photo',
  gif: 'gif',
  voice: 'voice',
  video: 'video',
  photo: 'photo',
};

function estimateLegacySize(mediaUrl) {
  if (!mediaUrl) return 50_000;
  if (mediaUrl.startsWith('data:')) return Math.min(mediaUrl.length, MAX_PHOTO_BYTES);
  return 120_000;
}

/** Save an existing chat message media to Rec vault or public profile showcase. */
export async function saveMessageMediaToRec(userId, messageId, { retention = 'vault' } = {}) {
  if (!['vault', 'profile'].includes(retention)) {
    throw new MboloMediaError('invalid_retention', 'Use vault or profile');
  }

  const message = await prisma.mboloMessage.findUnique({
    where: { id: messageId },
    include: {
      mediaAsset: true,
      thread: { include: { members: true } },
    },
  });
  if (!message) throw new MboloMediaError('not_found', 'Message not found', 404);

  const isMember = message.thread.members.some((m) => m.userId === userId && m.status === 'active');
  if (!isMember) throw new MboloMediaError('forbidden', 'Not a member of this thread', 403);

  // Someone else's photo may go to your private vault, never onto your
  // public profile.
  if (retention === 'profile' && message.senderId !== userId) {
    throw new MboloMediaError('forbidden', 'Seuls tes propres médias peuvent aller sur ton profil', 403);
  }

  const hasMedia = message.mediaAssetId || message.mediaUrl;
  if (!hasMedia || message.kind === 'text' || message.kind === 'sticker') {
    throw new MboloMediaError('no_media', 'This message has no savable media', 400);
  }

  if (message.mediaAsset?.ownerId === userId && ['vault', 'profile'].includes(message.mediaAsset.retention)) {
    const updated = await prisma.mbooloMediaAsset.update({
      where: { id: message.mediaAsset.id },
      data: { retention, profileVisible: retention === 'profile' },
    });
    return { assetId: updated.id, retention };
  }

  const kind = LEGACY_KIND_MAP[message.kind] ?? message.mediaAsset?.kind ?? 'photo';
  const sizeBytes = message.mediaAsset?.sizeBytes ?? estimateLegacySize(message.mediaUrl);
  const vault = await ensureVault(userId);
  if (vault.usedBytes + sizeBytes > vault.quotaBytes) {
    throw new MboloMediaError('vault_full', 'Rec vault full — delete memories to free space', 507);
  }

  const bucket = supabaseStorageConfigured() ? storageBucketName() : 'legacy';
  const storagePath =
    message.mediaAsset?.storagePath ??
    `legacy/vault/${userId}/${messageId}-${randomUUID().slice(0, 8)}`;
  const sourceUrl =
    message.mediaAsset && supabaseStorageConfigured()
      ? null
      : message.mediaUrl ?? null;

  const asset = await prisma.$transaction(async (tx) => {
    await tx.userMediaVault.update({
      where: { userId },
      data: { usedBytes: { increment: sizeBytes } },
    });
    return tx.mbooloMediaAsset.create({
      data: {
        ownerId: userId,
        threadId: message.threadId,
        bucket,
        storagePath,
        sourceUrl,
        mimeType: message.mediaAsset?.mimeType ?? 'application/octet-stream',
        kind,
        sizeBytes,
        status: 'ready',
        retention,
        profileVisible: retention === 'profile',
      },
    });
  });

  return { assetId: asset.id, retention };
}
