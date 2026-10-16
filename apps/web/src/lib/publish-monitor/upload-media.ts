/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * PUBLISH-MONITOR PR-5 (plan §2.1): the browser uploads a publish file straight to Post for Me's signed URL; the file
 * never passes through Graylum. Call this only after the user confirmed the disclosure dialog ("the files go to a
 * third-party publishing service on a public link; a failed post's files may stay about a day and we cannot delete
 * them early"), and upload again for every retry: an old media link is never reused.
 */
export type UploadSlot = { uploadUrl: string; mediaUrl: string };
export type UploadedMedia = { mediaUrl: string; sha256: string; size: number; mimeType: string };

const MIME = /^(image|video)\/[a-z0-9.+-]{1,64}$/;
// Post for Me accepts files up to 5 GB (plan §2 item 10).
export const MAX_MEDIA_BYTES = 5 * 1024 ** 3;
const SAMPLE_BYTES = 4 * 1024 * 1024;

/**
 * A SHA-256 over the size and the first and last 4 MB, so a large video is never read into memory as a whole. It only
 * identifies the file inside the idempotency fingerprint (the same file uploaded again is the same request); it is not
 * an integrity check.
 */
export async function mediaDigest(file: Blob): Promise<string> {
  const head = file.slice(0, Math.min(SAMPLE_BYTES, file.size));
  const tail = file.size > SAMPLE_BYTES ? file.slice(Math.max(SAMPLE_BYTES, file.size - SAMPLE_BYTES)) : new Blob([]);
  const sample = new Blob([new TextEncoder().encode(`${file.size}:`), head, tail]);
  const digest = await crypto.subtle.digest('SHA-256', await sample.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class MediaUploadError extends Error {
  constructor(readonly code: 'MEDIA_TYPE_UNSUPPORTED' | 'MEDIA_TOO_LARGE' | 'MEDIA_UPLOAD_FAILED') { super(code); }
}

/** requestSlot is the tRPC `publishMonitor.publish.uploadUrl({ disclosureAccepted: true })` mutation. */
export async function uploadPublishMedia(file: File, requestSlot: () => Promise<UploadSlot>,
  fetchImpl: typeof fetch = fetch): Promise<UploadedMedia> {
  const mimeType = file.type.toLowerCase();
  if (!MIME.test(mimeType)) throw new MediaUploadError('MEDIA_TYPE_UNSUPPORTED');
  if (file.size < 1 || file.size > MAX_MEDIA_BYTES) throw new MediaUploadError('MEDIA_TOO_LARGE');
  const sha256 = await mediaDigest(file);
  const slot = await requestSlot();
  const response = await fetchImpl(slot.uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file,
    credentials: 'omit', redirect: 'error' }).catch(() => null);
  if (!response?.ok) throw new MediaUploadError('MEDIA_UPLOAD_FAILED');
  return { mediaUrl: slot.mediaUrl, sha256, size: file.size, mimeType };
}
