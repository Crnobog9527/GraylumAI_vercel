/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger';
import { swallow } from '../../lib/swallow';
import type { ErasureStorageAdapter } from '../accountErasure/processor';
import { cleanOwnPrefix, type ErasureBucket } from '../profileAvatar/erasure';

/*
 * Chat photos (Owner 2026-11-13: "用户上传的照片在聊天记录里面，应该要做到常驻长期保存呀……" and "同意，用 Supabase"). The images a
 * user sends with a message are kept with that message, so the conversation shows them when it is read again and a later
 * message can still make an image from one (INTEGRATION-SHOTVIVA). Private bucket, service role only (migration chat_photos).
 * Only the owner sees them (the signed-in view route) and Shotviva reads one at a time through a few-minutes signed address
 * (grant.ts). No time or count limit. Deleted with the conversation (removeSessionPhotos right away, cleanOrphanPhotos as the
 * backstop in the 5-minute library-cleanup cron) and with the account (createChatPhotoErasureAdapter).
 */
export const CHAT_PHOTO_BUCKET = 'chat-photos';
/** The bucket's own cap (migration): the composer makes a JPEG of at most 614,400 bytes. */
export const CHAT_PHOTO_MAX_BYTES = 1024 * 1024;
/** As the composer's limit: four photos per message. */
const PHOTOS_PER_TURN = 4;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OBJECT = new RegExp(`^(${UUID})/(${UUID})\\.([1-9][0-9]{0,18})\\.([0-3])\\.${UUID}\\.jpg$`);
const ID = new RegExp(`^${UUID}$`);
const PAGE = 100;
/** A conversation's photos are listed up to this many (25 pages); a longer conversation shows its first ones. */
const MAX_LISTED = 2500;

type Result<T> = { data: T; error: unknown };
export type ChatPhotoBucket = ErasureBucket & {
  upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean; cacheControl: string }):
    PromiseLike<Result<{ path: string } | null>>;
  list(prefix: string, options: { limit: number; offset: number; sortBy: { column: string; order: string }; search?: string }):
    PromiseLike<Result<unknown>>;
  download(path: string): PromiseLike<Result<Blob | null>>;
};
export type ChatPhotoClient = {
  storage: { from(bucket: string): ChatPhotoBucket };
  rpc(name: 'chat_photos_orphaned', args: { p_limit: number }): PromiseLike<Result<unknown>>;
};
export type ChatPhoto = { path: string; turnId: number; index: number };

/** `<profile id>/<session id>.<turn id>.<n>.<random uuid>.jpg`: the only names the service writes. */
export function parseChatPhotoPath(path: string): { profileId: string; sessionId: string; turnId: number; index: number } | null {
  const match = OBJECT.exec(path);
  if (!match) return null;
  const turnId = Number(match[3]);
  return Number.isSafeInteger(turnId) ? { profileId: match[1]!, sessionId: match[2]!, turnId, index: Number(match[4]) } : null;
}
export function isChatPhotoPath(path: string, profileId?: string, sessionId?: string): boolean {
  const parsed = parseChatPhotoPath(path);
  return !!parsed && (profileId === undefined || parsed.profileId === profileId) && (sessionId === undefined || parsed.sessionId === sessionId);
}

export const isJpeg = (bytes: Uint8Array) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const JPEG_DATA_URL = 'data:image/jpeg;base64,';
/** The bytes of a checked chat image (chatImage.ts: a JPEG data URL), or null. */
export function jpegFromDataUrl(url: string): Uint8Array | null {
  if (!url.startsWith(JPEG_DATA_URL)) return null;
  const bytes = Buffer.from(url.slice(JPEG_DATA_URL.length), 'base64');
  return isJpeg(bytes) && bytes.byteLength <= CHAT_PHOTO_MAX_BYTES ? bytes : null;
}

/** Keeps the photos of one message with its turn, in the message's order. A photo that is not a JPEG within the cap, or whose
 * upload fails, is left out (the message still goes to the model), never retried. Returns what was kept. */
export async function keepTurnPhotos(input: { client: ChatPhotoClient; profileId: string; sessionId: string; turnId: number;
  photos: readonly Uint8Array[]; objectId?: () => string }): Promise<ChatPhoto[]> {
  if (!ID.test(input.profileId) || !ID.test(input.sessionId) || !Number.isSafeInteger(input.turnId) || input.turnId < 1) return [];
  const kept: ChatPhoto[] = [];
  // Never throws: a photo that cannot be kept never fails the turn.
  await Promise.all(input.photos.slice(0, PHOTOS_PER_TURN).map(async (bytes, index) => {
    if (!isJpeg(bytes) || bytes.byteLength > CHAT_PHOTO_MAX_BYTES) return;
    const path = `${input.profileId}/${input.sessionId}.${input.turnId}.${index}.${(input.objectId ?? randomUUID)()}.jpg`;
    if (!isChatPhotoPath(path, input.profileId, input.sessionId)) return;
    try {
      const uploaded = await input.client.storage.from(CHAT_PHOTO_BUCKET)
        .upload(path, bytes, { contentType: 'image/jpeg', upsert: false, cacheControl: 'private, max-age=0' });
      if (uploaded.error || uploaded.data?.path !== path) throw new Error('upload');
      kept.push({ path, turnId: input.turnId, index });
    } catch { logger.warn('system', 'chat_photo_keep_failed', {}); }
  }));
  return kept.sort((a, b) => a.index - b.index);
}

type Listed = { name: string };
const listedNames = (data: unknown): string[] => Array.isArray(data)
  ? data.filter((row): row is Listed => !!row && typeof row === 'object' && typeof (row as Listed).name === 'string').map(row => row.name) : [];

/** Every photo of a conversation, by turn and position. Nothing on a failure (the page then shows the message without them). */
export async function sessionPhotos(client: ChatPhotoClient, profileId: string, sessionId: string): Promise<ChatPhoto[]> {
  if (!ID.test(profileId) || !ID.test(sessionId)) return [];
  const bucket = client.storage.from(CHAT_PHOTO_BUCKET);
  const photos: ChatPhoto[] = [];
  for (let offset = 0; offset < MAX_LISTED; offset += PAGE) {
    const listed = await swallow('chat_photo_list_failed', bucket.list(profileId,
      { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' }, search: `${sessionId}.` }), null);
    if (!listed || listed.error) return [];
    const names = listedNames(listed.data);
    for (const name of names) {
      const parsed = parseChatPhotoPath(`${profileId}/${name}`);
      if (parsed && parsed.profileId === profileId && parsed.sessionId === sessionId)
        photos.push({ path: `${profileId}/${name}`, turnId: parsed.turnId, index: parsed.index });
    }
    if (names.length < PAGE) break;
  }
  return photos.sort((a, b) => a.turnId - b.turnId || a.index - b.index);
}

/** One of the caller's own photos, for the signed-in view route: never another account's, never a name the service does not write. */
export async function readOwnPhoto(client: ChatPhotoClient, profileId: string, path: string | null):
  Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: 404 }> {
  if (!path || !ID.test(profileId) || !isChatPhotoPath(path, profileId)) return { ok: false, status: 404 };
  const downloaded = await swallow('chat_photo_read_failed', client.storage.from(CHAT_PHOTO_BUCKET).download(path), null);
  if (!downloaded || downloaded.error || !downloaded.data) return { ok: false, status: 404 };
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  return isJpeg(bytes) && bytes.byteLength <= CHAT_PHOTO_MAX_BYTES ? { ok: true, bytes } : { ok: false, status: 404 };
}

/** Removes the given photos (of one account); never throws. */
async function removePaths(client: ChatPhotoClient, paths: string[], label: string): Promise<{ removed: number; failed: number }> {
  let removed = 0, failed = 0;
  for (let index = 0; index < paths.length; index += PAGE) {
    const batch = paths.slice(index, index + PAGE);
    try {
      const result = await client.storage.from(CHAT_PHOTO_BUCKET).remove(batch);
      if (result.error) throw new Error('remove');
      removed += batch.length;
    } catch { failed += batch.length; }
  }
  if (failed) logger.warn('system', label, { failed });
  return { removed, failed };
}

/** A turn that ended without its message being kept (it failed before anything was saved): its photos go too. Best effort: what is
 * left belongs to the conversation and goes with it. */
export async function removeTurnPhotos(client: ChatPhotoClient, kept: readonly ChatPhoto[]): Promise<void> {
  if (kept.length) await removePaths(client, kept.map(photo => photo.path), 'chat_photo_turn_delete_failed');
}

/** With its conversation (Owner 2026-10-13: deleting a conversation is immediate). Best effort, never throws: cleanOrphanPhotos
 * deletes what is left. */
export async function removeSessionPhotos(client: ChatPhotoClient, profileId: string, sessionId: string): Promise<number> {
  try {
    const paths = (await sessionPhotos(client, profileId, sessionId)).map(photo => photo.path);
    return (await removePaths(client, paths, 'chat_photo_session_delete_failed')).removed;
  } catch {
    logger.warn('system', 'chat_photo_session_delete_failed', {});
    return 0;
  }
}

/** The cron's backstop: deletes the photos whose conversation the database says is deleted or gone. `failed` counts names that
 * could not be read or deleted (a name the service never writes is not deleted on a guess), so the run reports an error. */
export async function cleanOrphanPhotos(client: ChatPhotoClient, limit = 500): Promise<{ removed: number; failed: number }> {
  const listed = await swallow('chat_photo_orphans_failed', client.rpc('chat_photos_orphaned', { p_limit: limit }), null);
  if (!listed || listed.error || !Array.isArray(listed.data)) return { removed: 0, failed: 1 };
  const names = listed.data.filter((name): name is string => typeof name === 'string');
  const ours = names.filter(name => isChatPhotoPath(name));
  const result = await removePaths(client, ours, 'chat_photo_orphan_delete_failed');
  return { removed: result.removed, failed: result.failed + names.length - ours.length };
}

/** Account erasure: everything under `<profile id>/` in the chat photo bucket, before Auth is deleted. */
export function createChatPhotoErasureAdapter(client: Pick<ChatPhotoClient, 'storage'>): ErasureStorageAdapter {
  return { cleanSubject: profileId => cleanOwnPrefix(client.storage.from(CHAT_PHOTO_BUCKET), profileId,
    path => isChatPhotoPath(path, profileId), { unknown: 'ERASURE_CHAT_PHOTO_UNKNOWN', review: 'ERASURE_CHAT_PHOTO_REVIEW' }) };
}
