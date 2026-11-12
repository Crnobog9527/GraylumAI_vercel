/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger';

/** PROFILE-AVATAR (Owner 2026-11-12). Public-read bucket written only by the service role (migration profile_avatar). */
export const AVATAR_BUCKET = 'profile-avatars';
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
export type AvatarMime = keyof typeof EXTENSIONS;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OBJECT = new RegExp(`^(${UUID})/${UUID}\\.(jpg|png|webp)$`);
const PROFILE = new RegExp(`^${UUID}$`);

/** The type is read from the bytes, never from the file name or the declared type. */
export function sniffAvatarType(bytes: Uint8Array): AvatarMime | null {
  const at = (offset: number, sig: number[]) => sig.every((value, index) => bytes[offset + index] === value);
  if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

/** `<profile id>/<random uuid>.<ext>`: the only object names the service writes. */
export function isAvatarObjectPath(path: string, profileId?: string): boolean {
  const match = OBJECT.exec(path);
  return !!match && (profileId === undefined || match[1] === profileId);
}

function publicBase(supabaseUrl: string): string {
  return `${new URL(supabaseUrl).origin}/storage/v1/object/public/${AVATAR_BUCKET}/`;
}

export function avatarPublicUrl(supabaseUrl: string, path: string): string {
  if (!isAvatarObjectPath(path)) throw new Error('AVATAR_PATH_INVALID');
  return publicBase(supabaseUrl) + path;
}

/** The object behind a stored avatar URL when it is this profile's own upload; null for anything else
 * (an OAuth picture, another bucket, another profile, a decorated or encoded URL). */
export function ownedAvatarPath(supabaseUrl: string, profileId: string, url: string | null | undefined): string | null {
  if (!url) return null;
  const base = publicBase(supabaseUrl);
  if (!url.startsWith(base)) return null;
  const path = url.slice(base.length);
  return isAvatarObjectPath(path, profileId) ? path : null;
}

type Result<T> = { data: T; error: unknown };
type Bucket = {
  upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean; cacheControl: string }):
    PromiseLike<Result<{ path: string } | null>>;
  remove(paths: string[]): PromiseLike<Result<unknown>>;
};
type ProfileUpdate = {
  eq(column: string, value: string): ProfileUpdate;
  is(column: string, value: null): ProfileUpdate;
  select(columns: string): PromiseLike<Result<Array<{ avatar_url: string | null }> | null>>;
};
export type AvatarClient = {
  from(table: 'profiles'): {
    select(columns: string): { eq(column: string, value: string): { maybeSingle(): PromiseLike<Result<unknown>> } };
    update(values: { avatar_url: string }): ProfileUpdate;
  };
  storage: { from(bucket: string): Bucket };
};
export type AvatarOutcome =
  | { status: 200; avatarUrl: string }
  | { status: 400 | 403 | 409 | 413 | 503; error: string };

const MESSAGES = {
  type: '只支持 JPG、PNG 或 WebP 图片',
  size: '图片不能超过 2MB',
  closed: '当前账号不能修改头像',
  conflict: '头像刚刚被更新过，请再试一次',
  unavailable: '头像暂时无法保存，请稍后重试',
} as const;

const readProfile = async (client: AvatarClient, profileId: string) => {
  const { data, error } = await client.from('profiles').select('avatar_url,status,is_deleted').eq('id', profileId).maybeSingle();
  if (error || !data || typeof data !== 'object') return null;
  const row = data as { avatar_url?: unknown; status?: unknown; is_deleted?: unknown };
  return { avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    active: row.status === 'active' && String(row.is_deleted) === 'false' };
};

/** Store a new avatar for this profile only and point profiles.avatar_url at it, then delete the previous upload.
 * The write is a compare-and-set on the old value, so of two uploads racing from the same account exactly one wins
 * and the other deletes its own file: the stored URL never points at a deleted object. Deleting the old file comes
 * after the database write, so a failed delete leaves an orphan (erasure removes the whole prefix), never a broken
 * avatar. */
export async function replaceProfileAvatar(input: {
  client: AvatarClient; supabaseUrl: string; profileId: string; bytes: Uint8Array; objectId?: string;
}): Promise<AvatarOutcome> {
  const { client, profileId, bytes } = input;
  if (!PROFILE.test(profileId)) return { status: 400, error: MESSAGES.unavailable };
  if (bytes.byteLength < 1 || bytes.byteLength > AVATAR_MAX_BYTES) return { status: 413, error: MESSAGES.size };
  const mime = sniffAvatarType(bytes);
  if (!mime) return { status: 400, error: MESSAGES.type };

  const before = await readProfile(client, profileId).catch(() => null);
  if (!before) return { status: 503, error: MESSAGES.unavailable };
  if (!before.active) return { status: 403, error: MESSAGES.closed };

  const path = `${profileId}/${input.objectId ?? randomUUID()}.${EXTENSIONS[mime]}`;
  if (!isAvatarObjectPath(path, profileId)) return { status: 400, error: MESSAGES.unavailable };
  const url = avatarPublicUrl(input.supabaseUrl, path);
  const bucket = client.storage.from(AVATAR_BUCKET);
  const discard = async () => {
    try {
      const removed = await bucket.remove([path]);
      if (removed.error) throw new Error('remove');
    } catch { logger.warn('system', 'profile_avatar_discard_failed', {}); }
  };

  try {
    // Short cache: a deleted avatar (replaced or erased) stops being served from the CDN within the hour.
    const uploaded = await bucket.upload(path, bytes, { contentType: mime, upsert: false, cacheControl: '3600' });
    if (uploaded.error || uploaded.data?.path !== path) { await discard(); return { status: 503, error: MESSAGES.unavailable }; }
  } catch { await discard(); return { status: 503, error: MESSAGES.unavailable }; }

  let won = false;
  try {
    const update = client.from('profiles').update({ avatar_url: url })
      .eq('id', profileId).eq('status', 'active').eq('is_deleted', 'false');
    const written = await (before.avatarUrl === null ? update.is('avatar_url', null) : update.eq('avatar_url', before.avatarUrl))
      .select('avatar_url');
    if (written.error) throw new Error('write');
    won = Array.isArray(written.data) && written.data.length === 1 && written.data[0]?.avatar_url === url;
  } catch {
    // The write may have committed: read the row back instead of guessing.
    const after = await readProfile(client, profileId).catch(() => null);
    if (!after) return { status: 503, error: MESSAGES.unavailable };
    won = after.avatarUrl === url;
  }
  if (!won) {
    await discard();
    const now = await readProfile(client, profileId).catch(() => null);
    if (now && !now.active) return { status: 403, error: MESSAGES.closed };
    return { status: 409, error: MESSAGES.conflict };
  }

  const old = ownedAvatarPath(input.supabaseUrl, profileId, before.avatarUrl);
  if (old && old !== path) {
    try {
      const removed = await bucket.remove([old]);
      if (removed.error) throw new Error('remove');
    } catch { logger.warn('system', 'profile_avatar_old_delete_failed', {}); }
  }
  return { status: 200, avatarUrl: url };
}
