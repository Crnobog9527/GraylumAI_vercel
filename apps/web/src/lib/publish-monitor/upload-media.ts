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
// Post for Me support (Caleb, 2026-10): about 1 GB per file; the server transcodes per platform.
export const MAX_MEDIA_BYTES = 1024 ** 3;
// The server accepts at most 10 files per post.
export const MAX_MEDIA_FILES = 10;
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

/**
 * Uploads all files of one post. requestSlots is the tRPC
 * `publishMonitor.publish.uploadUrl({ disclosureAccepted: true, count, connectionIds })` mutation: one request for the whole post.
 * Every file is checked before any slot is requested.
 */
export async function uploadPublishFiles(files: File[], requestSlots: (count: number) => Promise<UploadSlot[]>,
  fetchImpl: typeof fetch = fetch): Promise<UploadedMedia[]> {
  if (files.length < 1 || files.length > MAX_MEDIA_FILES) throw new MediaUploadError('MEDIA_TOO_LARGE');
  for (const file of files) {
    if (!MIME.test(file.type.toLowerCase())) throw new MediaUploadError('MEDIA_TYPE_UNSUPPORTED');
    if (file.size < 1 || file.size > MAX_MEDIA_BYTES) throw new MediaUploadError('MEDIA_TOO_LARGE');
  }
  // One file at a time: only one sample (at most 8 MB) is in memory, however many files the post has.
  const digests: string[] = [];
  for (const file of files) digests.push(await mediaDigest(file));
  const slots = await requestSlots(files.length);
  if (slots.length !== files.length) throw new MediaUploadError('MEDIA_UPLOAD_FAILED');
  const uploaded: UploadedMedia[] = [];
  for (const [i, file] of files.entries()) {
    const mimeType = file.type.toLowerCase();
    const response = await fetchImpl(slots[i]!.uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file,
      credentials: 'omit', redirect: 'error' }).catch(() => null);
    if (!response?.ok) throw new MediaUploadError('MEDIA_UPLOAD_FAILED');
    uploaded.push({ mediaUrl: slots[i]!.mediaUrl, sha256: digests[i]!, size: file.size, mimeType });
  }
  return uploaded;
}
