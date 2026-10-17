import { z } from 'zod';

/**
 * J5 media references for catalog / business images: an absolute https URL,
 * or an inline image data URI (what the app uploads today). Never a script
 * scheme, an arbitrary data type, or a bare storage path that could point at
 * someone else's private upload (private media are only reachable through
 * short-lived signed URLs minted for an authorized viewer).
 */
const HTTPS = /^https:\/\/[^\s/$.?#][^\s]*$/i;
const DATA_IMAGE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;

export function isSafeImageRef(v) {
  if (typeof v !== 'string') return false;
  if (HTTPS.test(v)) return v.length <= 500;
  return DATA_IMAGE.test(v) && v.length <= 1_500_000;
}

export const imageRef = z.string().refine(isSafeImageRef, { message: 'Image : URL https ou image intégrée uniquement' });
