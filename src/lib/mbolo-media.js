import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { readAsStringAsync, writeAsStringAsync, EncodingType, cacheDirectory } from 'expo-file-system/legacy';
import { upload } from '@vercel/blob/client';
import {
  createMboloGif,
  getMboloStorageStatus,
  mboloMediaComplete,
  mboloMediaUploadUrl,
  sendMboloMessage,
} from './api-client';
import { newUploadCheckpoint, runUpload } from './upload-resume.js';
import { newClientMessageId } from './mbolo-outbox.js';

/** Keep under server zod limit (800k) with JSON overhead. */
export const MAX_MEDIA_CHARS = 720_000;
export const MAX_VOICE_CHARS = 780_000;
export const MAX_GIF_CHARS = 720_000;
const MAX_IMAGE_EDGE = 960;
const JPEG_QUALITY = 0.55;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function assertDataUrlSize(dataUrl) {
  if (String(dataUrl).length > MAX_MEDIA_CHARS) {
    throw new Error('Photo trop lourde — recadre ou choisis une image plus petite');
  }
  return dataUrl;
}

async function compressWebImageFile(file) {
  if (typeof document === 'undefined') {
    return assertDataUrlSize(await readFileAsDataUrl(file));
  }
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = document.createElement('img');
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = blobUrl;
    });
    for (const edge of [MAX_IMAGE_EDGE, 720, 480]) {
      let { width, height } = img;
      const scale = Math.min(1, edge / Math.max(width, height, 1));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Compression impossible');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      if (dataUrl.length <= MAX_MEDIA_CHARS) return assertDataUrlSize(dataUrl);
    }
    throw new Error('Photo trop lourde — recadre ou choisis une image plus petite');
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function compressNativeImageUri(uri) {
  const { manipulateAsync, SaveFormat } = await import('expo-image-manipulator');
  for (const width of [MAX_IMAGE_EDGE, 720, 480, 360]) {
    try {
      const result = await manipulateAsync(uri, [{ resize: { width } }], {
        compress: JPEG_QUALITY,
        format: SaveFormat.JPEG,
        base64: true,
      });
      if (result.base64) {
        const dataUrl = assertDataUrlSize(`data:image/jpeg;base64,${result.base64}`);
        return dataUrl;
      }
      if (result.uri) {
        const dataUrl = await readUriAsDataUrl(result.uri, 'image/jpeg');
        if (dataUrl.length <= MAX_MEDIA_CHARS) return dataUrl;
      }
    } catch {
      // Try the next size.
    }
  }
  throw new Error('Photo trop lourde — recadre ou choisis une image plus petite');
}

function assertVoiceDataUrlSize(dataUrl) {
  if (String(dataUrl).length > MAX_VOICE_CHARS) {
    throw new Error('Message vocal trop long — enregistre moins de 60 secondes');
  }
  return dataUrl;
}

export async function readVoiceUriAsDataUrl(uri, mime = 'audio/mp4') {
  if (!uri) throw new Error('Enregistrement introuvable');
  if (uri.startsWith('data:')) return assertVoiceDataUrlSize(uri);
  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    const blob = await res.blob();
    return assertVoiceDataUrlSize(await readFileAsDataUrl(blob));
  }
  const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  return assertVoiceDataUrlSize(`data:${mime};base64,${base64}`);
}

/** Native players need a file:// URI — data URLs fail on iOS/Android. */
export async function resolveVoicePlaybackSource(url) {
  if (!url) return null;
  if (Platform.OS === 'web' || !String(url).startsWith('data:')) return url;

  const match = String(url).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return url;

  const mime = match[1].toLowerCase();
  const ext = mime.includes('webm') ? 'webm' : mime.includes('3gp') ? '3gp' : mime.includes('caf') ? 'caf' : 'm4a';
  const path = `${cacheDirectory}mbolo-voice-${Date.now()}.${ext}`;
  await writeAsStringAsync(path, match[2], { encoding: EncodingType.Base64 });
  return path;
}

/** Fetch a GIF and return a data URL when small enough; otherwise return the HTTPS URL. */
export async function resolveGifMediaUrl(url) {
  const direct = String(url ?? '').trim();
  if (!direct.startsWith('http')) throw new Error('GIF invalide');

  try {
    const res = await fetch(direct);
    if (!res.ok) return direct;
    const blob = await res.blob();
    if (blob.size > MAX_GIF_CHARS * 0.75) return direct;
    const dataUrl = await readFileAsDataUrl(blob);
    if (String(dataUrl).length <= MAX_GIF_CHARS) return dataUrl;
    return direct;
  } catch {
    return direct;
  }
}

export async function readUriAsDataUrl(uri, mime = 'application/octet-stream') {
  if (!uri) throw new Error('Fichier introuvable');
  if (uri.startsWith('data:')) return assertDataUrlSize(uri);
  if (Platform.OS === 'web') {
    const res = await fetch(uri);
    const blob = await res.blob();
    return compressWebImageFile(blob);
  }
  if (mime.startsWith('image/')) {
    return compressNativeImageUri(uri);
  }
  const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  return assertDataUrlSize(`data:${mime};base64,${base64}`);
}

async function assetToDataUrl(asset) {
  if (asset.uri) {
    return compressNativeImageUri(asset.uri);
  }
  throw new Error('Impossible de lire la photo');
}

async function pickImageFromLibrary() {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Accès photos refusé — autorise dans les réglages');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: Platform.OS === 'ios',
    quality: JPEG_QUALITY,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  return assetToDataUrl(result.assets[0]);
}

async function takePhotoWithCamera() {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Accès caméra refusé — autorise dans les réglages');
  const result = await ImagePicker.launchCameraAsync({
    allowsEditing: Platform.OS === 'ios',
    quality: JPEG_QUALITY,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  return assetToDataUrl(result.assets[0]);
}

function pickMboloImageWeb() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve(await compressWebImageFile(file));
      } catch (err) {
        reject(err);
      }
    };
    input.click();
  });
}

/** Pick an image from the library. Returns data URL or null if cancelled. */
export async function pickMboloImage() {
  if (Platform.OS === 'web') return pickMboloImageWeb();
  return pickImageFromLibrary();
}

/** Take a photo with the camera. Returns data URL or null if cancelled. */
export async function takeMboloPhoto() {
  if (Platform.OS === 'web') return pickMboloImageWeb();
  return takePhotoWithCamera();
}

async function pickVideoFromLibrary() {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Accès médias refusé');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    videoMaxDuration: 30,
    quality: 0.5,
  });
  if (result.canceled || !result.assets?.[0]?.uri) return null;
  return readUriAsDataUrl(result.assets[0].uri, result.assets[0].mimeType ?? 'video/mp4');
}

export async function pickMboloVideo() {
  if (Platform.OS === 'web') {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        try {
          resolve(await readFileAsDataUrl(file));
        } catch (err) {
          reject(err);
        }
      };
      input.click();
    });
  }
  return pickVideoFromLibrary();
}

/** Pick a short video for Supabase upload (uri + metadata, no base64). */
export async function pickMboloVideoAsset() {
  if (Platform.OS === 'web') {
    const file = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
    if (!file) return null;
    return {
      uri: URL.createObjectURL(file),
      mimeType: file.type || 'video/mp4',
      fileName: file.name || `mbolo-video-${Date.now()}.mp4`,
      blob: file,
    };
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Accès médias refusé');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    videoMaxDuration: 30,
    quality: 0.5,
  });
  if (result.canceled || !result.assets?.[0]?.uri) return null;
  const picked = result.assets[0];
  const contentType = picked.mimeType || 'video/mp4';
  return {
    uri: picked.uri,
    mimeType: contentType,
    fileName: `mbolo-video-${Date.now()}.${contentType.split('/')[1] ?? 'mp4'}`,
  };
}

/** Pick a GIF file for the personal library. */
export async function pickMboloGifFile() {
  if (Platform.OS === 'web') {
    const file = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/gif';
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
    if (!file) return null;
    return {
      uri: URL.createObjectURL(file),
      mimeType: file.type || 'image/gif',
      fileName: file.name || `mbolo-gif-${Date.now()}.gif`,
      blob: file,
    };
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Accès médias refusé');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
  });
  if (result.canceled || !result.assets?.[0]?.uri) return null;
  const picked = result.assets[0];
  if (!String(picked.mimeType ?? '').includes('gif') && !picked.uri.toLowerCase().includes('.gif')) {
    throw new Error('Choisis un fichier GIF');
  }
  return {
    uri: picked.uri,
    mimeType: picked.mimeType || 'image/gif',
    fileName: `mbolo-gif-${Date.now()}.gif`,
  };
}

async function pickVideoAsset() {
  if (Platform.OS === 'web') {
    const file = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
    if (!file) return null;
    return { blob: file, contentType: file.type || 'video/mp4', filename: file.name || `mbolo-video-${Date.now()}.mp4` };
  }
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Accès médias refusé');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    videoMaxDuration: 30,
    quality: 0.5,
  });
  if (result.canceled || !result.assets?.[0]?.uri) return null;
  const picked = result.assets[0];
  const res = await fetch(picked.uri);
  const blob = await res.blob();
  const contentType = picked.mimeType || 'video/mp4';
  return { blob, contentType, filename: `mbolo-video-${Date.now()}.${contentType.split('/')[1] ?? 'mp4'}` };
}

/**
 * Pick a short video and upload it straight to Vercel Blob (legacy fallback).
 */
export async function pickAndUploadMboloVideo({ handleUploadUrl, headers }) {
  const asset = await pickVideoAsset();
  if (!asset) return null;

  try {
    const blob = await upload(asset.filename, asset.blob, {
      access: 'public',
      handleUploadUrl,
      headers,
      contentType: asset.contentType,
    });
    return blob.url;
  } catch (err) {
    if (err?.status === 503 || err?.code === 'video_unavailable') {
      throw new Error('Les vidéos ne sont pas encore activées sur ce serveur.');
    }
    throw new Error(err?.message ?? 'Envoi de la vidéo impossible');
  }
}

/** Record voice via MediaRecorder (web). Returns { stop } or rejects. */
export async function startMboloVoiceRecording() {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Messages vocaux indisponibles sur cet appareil');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.start();

  return {
    stop: () =>
      new Promise((resolve, reject) => {
        recorder.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          try {
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            resolve(assertVoiceDataUrlSize(await readFileAsDataUrl(blob)));
          } catch (err) {
            reject(err);
          }
        };
        recorder.stop();
      }),
  };
}

async function uriToBlob(uri, mimeType, presetBlob) {
  if (presetBlob) return presetBlob;
  if (typeof uri === 'string' && uri.startsWith('data:')) {
    const res = await fetch(uri);
    return res.blob();
  }
  const res = await fetch(uri);
  if (!res.ok) throw new Error('Fichier illisible');
  const blob = await res.blob();
  if (mimeType && blob.type !== mimeType) {
    return new Blob([await blob.arrayBuffer()], { type: mimeType });
  }
  return blob;
}

const MESSAGE_KIND = {
  image: 'image',
  photo: 'image',
  voice: 'voice',
  video: 'video',
  gif: 'gif',
};

/**
 * Upload media to Supabase via signed URL.
 * @returns {{ mediaAssetId: string, readUrl: string, mimeType: string, sizeBytes: number }}
 */
export async function uploadMbooloMedia({
  threadId,
  kind,
  uri,
  mimeType,
  durationMs,
  waveformJson,
  retention = 'thread',
  blob: presetBlob,
}) {
  const blob = await uriToBlob(uri, mimeType, presetBlob);
  const normalizedKind = kind === 'image' ? 'photo' : kind;

  const mint = await mboloMediaUploadUrl({
    threadId,
    kind: normalizedKind,
    mimeType: mimeType ?? blob.type ?? 'application/octet-stream',
    sizeBytes: blob.size,
    retention,
  });

  const uploadRes = await fetch(mint.uploadUrl, {
    method: 'PUT',
    headers: mint.headers ?? { 'Content-Type': mimeType ?? blob.type },
    body: blob,
  });
  if (!uploadRes.ok) {
    throw new Error('Échec envoi du fichier vers le stockage');
  }

  const completed = await mboloMediaComplete({
    assetId: mint.assetId,
    durationMs,
    waveformJson,
  });

  return {
    mediaAssetId: mint.assetId,
    readUrl: completed.readUrl,
    mimeType: completed.asset?.mimeType ?? mimeType ?? blob.type,
    sizeBytes: completed.asset?.sizeBytes ?? blob.size,
  };
}

/**
 * Send photo / voice / video through Supabase when configured; legacy fallback otherwise.
 */
export async function sendMbooloMediaMessage({
  threadId,
  kind,
  uri,
  mimeType,
  durationMs,
  waveformJson,
  retention = 'thread',
  blob,
  checkpoint = null,
}) {
  const status = await getMboloStorageStatus().catch(() => ({ storage: 'legacy' }));
  const storageReady = status.storage === 'supabase';
  const msgKind = MESSAGE_KIND[kind] ?? kind;

  if (storageReady) {
    // J12: resumable — a retry with the same `checkpoint` continues from the first unfinished step
    // (never a second asset, a second vault charge or a second message; see src/lib/upload-resume.js).
    const cp = checkpoint ?? newUploadCheckpoint(newClientMessageId());
    const normalizedKind = kind === 'image' ? 'photo' : kind;
    let blobP = null;
    const getBlob = () => (blobP ??= uriToBlob(uri, mimeType, blob));
    const body =
      msgKind === 'voice'
        ? `🎤 ${Math.max(1, Math.round((durationMs ?? 0) / 1000))}s`
        : msgKind === 'video'
          ? '🎬 Vidéo'
          : msgKind === 'gif'
            ? 'GIF'
            : '📷 Photo';
    try {
      await runUpload(cp, {
        mint: async () => {
          const b = await getBlob();
          return mboloMediaUploadUrl({ threadId, kind: normalizedKind, mimeType: mimeType ?? b.type ?? 'application/octet-stream', sizeBytes: b.size, retention });
        },
        put: async (mint) => {
          const b = await getBlob();
          const res = await fetch(mint.uploadUrl, { method: 'PUT', headers: mint.headers ?? { 'Content-Type': mimeType ?? b.type }, body: b });
          // 409 = this signed path already holds our bytes (the first PUT landed, its reply was lost).
          if (!res.ok && res.status !== 409) throw Object.assign(new Error('Échec envoi du fichier vers le stockage'), { status: res.status });
        },
        complete: (mint) => mboloMediaComplete({ assetId: mint.assetId, durationMs, waveformJson }),
        send: (completed, clientMessageId) =>
          sendMboloMessage(threadId, { kind: msgKind, body, mediaAssetId: cp.mint.assetId, mediaUrl: completed.readUrl, retention, clientMessageId }),
      });
    } catch (e) {
      e.checkpoint = cp;
      throw e;
    }
    return { ...cp.message, mediaUrl: cp.complete.readUrl };
  }

  if (msgKind === 'video') {
    const { getMboloVideoUploadConfig } = await import('./api-client');
    const { upload: blobUpload } = await import('@vercel/blob/client');
    const config = await getMboloVideoUploadConfig();
    const fileBlob = await uriToBlob(uri, mimeType, blob);
    const filename = `mbolo-video-${Date.now()}.${(mimeType ?? 'video/mp4').split('/')[1] ?? 'mp4'}`;
    const uploaded = await blobUpload(filename, fileBlob, {
      access: 'public',
      handleUploadUrl: config.handleUploadUrl,
      headers: config.headers,
      contentType: mimeType ?? fileBlob.type ?? 'video/mp4',
    });
    return sendMboloMessage(threadId, {
      kind: 'video',
      body: '🎬 Vidéo',
      mediaUrl: uploaded.url,
      retention,
    });
  }

  const dataUrl = uri.startsWith('data:') ? uri : await readFileAsDataUrl(await uriToBlob(uri, mimeType, blob));
  const checked = msgKind === 'voice' ? assertVoiceDataUrlSize(dataUrl) : assertDataUrlSize(dataUrl);
  const body =
    msgKind === 'voice'
      ? `🎤 ${Math.max(1, Math.round((durationMs ?? 0) / 1000))}s`
      : msgKind === 'gif'
        ? 'GIF'
        : '📷 Photo';
  return sendMboloMessage(threadId, {
    kind: msgKind,
    body,
    mediaUrl: checked,
    retention,
  });
}

/** Register a user GIF in the library (upload + POST /api/mbolo/gifs). Requires Supabase Storage. */
export async function createPersonalMboloGif({ label, uri, mimeType, blob }) {
  const status = await getMboloStorageStatus().catch(() => ({ storage: 'legacy' }));
  if (status.storage !== 'supabase') {
    throw new Error('Création de GIF disponible quand le stockage cloud est activé');
  }

  const fileBlob = await uriToBlob(uri, mimeType ?? 'image/gif', blob);
  const mint = await createMboloGif({
    sizeBytes: fileBlob.size,
    mimeType: mimeType ?? 'image/gif',
  });

  const uploadRes = await fetch(mint.uploadUrl, {
    method: 'PUT',
    headers: mint.headers ?? { 'Content-Type': mimeType ?? 'image/gif' },
    body: fileBlob,
  });
  if (!uploadRes.ok) throw new Error('Échec envoi du GIF');

  return createMboloGif({
    assetId: mint.assetId,
    label: label ?? 'Mon GIF',
  });
}
