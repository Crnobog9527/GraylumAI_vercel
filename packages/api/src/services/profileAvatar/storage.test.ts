/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { AVATAR_MAX_BYTES, avatarPublicUrl, isAvatarObjectPath, ownedAvatarPath, replaceProfileAvatar, sniffAvatarType } from './storage';

const SUPABASE = 'https://proj.supabase.co';
const me = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const obj = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56]);

/** One profile row and one bucket, with the compare-and-set semantics PostgREST applies to an UPDATE ... WHERE. */
function fake(row: { avatar_url: string | null; status?: string; is_deleted?: string }, opts: {
  uploadError?: boolean; writeError?: boolean; beforeWrite?: () => void;
} = {}) {
  const state = { status: 'active', is_deleted: 'false', ...row };
  const objects = new Set<string>();
  const upload = vi.fn(async (path: string) => {
    if (opts.uploadError) return { data: null, error: new Error('down') };
    objects.add(path); return { data: { path }, error: null };
  });
  const remove = vi.fn(async (paths: string[]) => { for (const p of paths) objects.delete(p); return { data: [], error: null }; });
  const client = {
    from: () => ({
      select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: id === me ? { ...state } : null, error: null }) }) }),
      update: (values: { avatar_url: string }) => {
        const where: Array<[string, unknown]> = [];
        const chain = {
          eq(column: string, value: string) { where.push([column, value]); return chain; },
          is(column: string, value: null) { where.push([column, value]); return chain; },
          async select() {
            opts.beforeWrite?.();
            if (opts.writeError) return { data: null, error: new Error('timeout') };
            const current: Record<string, unknown> = { id: me, ...state };
            if (!where.every(([column, value]) => current[column] === value)) return { data: [], error: null };
            state.avatar_url = values.avatar_url;
            return { data: [{ avatar_url: values.avatar_url }], error: null };
          },
        };
        return chain;
      },
    }),
    storage: { from: vi.fn(() => ({ upload, remove })) },
  };
  return { client, state, objects, upload, remove };
}
const run = (f: ReturnType<typeof fake>, bytes: Uint8Array, n = 9) =>
  replaceProfileAvatar({ client: f.client as never, supabaseUrl: SUPABASE, profileId: me, bytes, objectId: obj(n) });

describe('avatar rules', () => {
  it('reads the type from the bytes: JPEG, PNG, WebP only', () => {
    expect([sniffAvatarType(jpeg), sniffAvatarType(png), sniffAvatarType(webp)]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(sniffAvatarType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffAvatarType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull(); // GIF
    expect(sniffAvatarType(new Uint8Array())).toBeNull();
  });

  it('only this profile\'s own uploads count as its avatar file', () => {
    const mine = avatarPublicUrl(SUPABASE, `${me}/${obj(1)}.webp`);
    expect(mine).toBe(`${SUPABASE}/storage/v1/object/public/profile-avatars/${me}/${obj(1)}.webp`);
    expect(ownedAvatarPath(SUPABASE, me, mine)).toBe(`${me}/${obj(1)}.webp`);
    expect(ownedAvatarPath(SUPABASE, other, mine)).toBeNull();
    for (const url of [null, '', 'https://lh3.googleusercontent.com/a/x', `${mine}?x=1`, mine.replace('/public/', '/sign/'),
      `${SUPABASE}/storage/v1/object/public/profile-avatars/${me}/..%2F${other}/${obj(1)}.webp`,
      `https://evil.test/storage/v1/object/public/profile-avatars/${me}/${obj(1)}.webp`]) {
      expect(ownedAvatarPath(SUPABASE, me, url)).toBeNull();
    }
    expect(isAvatarObjectPath(`${me}/${obj(1)}.svg`)).toBe(false);
    expect(() => avatarPublicUrl(SUPABASE, `${me}/../x.png`)).toThrow();
  });
});

describe('replaceProfileAvatar', () => {
  it('stores the new avatar, points the profile at it and deletes the previous upload', async () => {
    const oldPath = `${me}/${obj(1)}.png`;
    const f = fake({ avatar_url: avatarPublicUrl(SUPABASE, oldPath) });
    f.objects.add(oldPath);
    const result = await run(f, webp);
    const path = `${me}/${obj(9)}.webp`;
    expect(result).toEqual({ status: 200, avatarUrl: avatarPublicUrl(SUPABASE, path) });
    expect(f.state.avatar_url).toBe(avatarPublicUrl(SUPABASE, path));
    expect([...f.objects]).toEqual([path]);
    expect(f.client.storage.from).toHaveBeenCalledWith('profile-avatars');
    expect(f.upload).toHaveBeenCalledWith(path, webp, { contentType: 'image/webp', upsert: false, cacheControl: '3600' });
  });

  it('a first avatar, or one from a sign-in provider: nothing of ours to delete', async () => {
    const first = fake({ avatar_url: null });
    expect((await run(first, jpeg)).status).toBe(200);
    expect(first.remove).not.toHaveBeenCalled();
    const google = fake({ avatar_url: 'https://lh3.googleusercontent.com/a/x' });
    expect((await run(google, png)).status).toBe(200);
    expect(google.remove).not.toHaveBeenCalled();
  });

  it('refuses a wrong type or an oversized file before anything is stored', async () => {
    const f = fake({ avatar_url: null });
    expect(await run(f, new TextEncoder().encode('<svg/>'))).toEqual({ status: 400, error: '只支持 JPG、PNG 或 WebP 图片' });
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1); big.set(png);
    expect(await run(f, big)).toEqual({ status: 413, error: '图片不能超过 2MB' });
    expect(await run(f, new Uint8Array())).toMatchObject({ status: 413 });
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.state.avatar_url).toBeNull();
  });

  it('a closed or erased account cannot set an avatar', async () => {
    for (const row of [{ status: 'banned' }, { status: 'closed' }, { is_deleted: 'true' }]) {
      const f = fake({ avatar_url: null, ...row });
      expect(await run(f, png)).toEqual({ status: 403, error: '当前账号不能修改头像' });
      expect(f.upload).not.toHaveBeenCalled();
    }
  });

  it('the account is closed between the check and the write: the write is refused and the new file deleted', async () => {
    const f = fake({ avatar_url: null }, { beforeWrite: () => { f.state.status = 'closed'; } });
    expect(await run(f, png)).toEqual({ status: 403, error: '当前账号不能修改头像' });
    expect(f.objects.size).toBe(0);
    expect(f.state.avatar_url).toBeNull();
  });

  it('two uploads at once: one wins, the loser deletes its own file, the stored URL never points at a deleted file', async () => {
    const oldPath = `${me}/${obj(1)}.png`;
    const f = fake({ avatar_url: avatarPublicUrl(SUPABASE, oldPath) });
    f.objects.add(oldPath);
    // The other upload commits first, right before this one's compare-and-set.
    const winner = `${me}/${obj(7)}.png`;
    let raced = false;
    f.client.from = ((original) => () => {
      const table = original();
      return { ...table, update: (values: { avatar_url: string }) => {
        if (!raced && values.avatar_url.includes(obj(9))) { raced = true; f.objects.add(winner); f.state.avatar_url = avatarPublicUrl(SUPABASE, winner); }
        return table.update(values);
      } };
    })(f.client.from);
    expect(await run(f, png)).toEqual({ status: 409, error: '头像刚刚被更新过，请再试一次' });
    expect(f.state.avatar_url).toBe(avatarPublicUrl(SUPABASE, winner));
    expect(f.objects.has(winner)).toBe(true);
    expect(f.objects.has(`${me}/${obj(9)}.png`)).toBe(false);
  });

  it('storage down: nothing changes on the profile, and a possibly stored file is removed', async () => {
    const f = fake({ avatar_url: null }, { uploadError: true });
    expect(await run(f, png)).toEqual({ status: 503, error: '头像暂时无法保存，请稍后重试' });
    expect(f.remove).toHaveBeenCalledWith([`${me}/${obj(9)}.png`]);
    expect(f.state.avatar_url).toBeNull();
  });

  it('an unclear write is read back: committed means success, not committed means the new file is discarded', async () => {
    const committed = fake({ avatar_url: null }, { writeError: true, beforeWrite: () => {
      committed.state.avatar_url = avatarPublicUrl(SUPABASE, `${me}/${obj(9)}.png`);
    } });
    expect((await run(committed, png)).status).toBe(200);
    const lost = fake({ avatar_url: null }, { writeError: true });
    expect((await run(lost, png)).status).toBe(409);
    expect(lost.objects.size).toBe(0);
  });

  it('only the signed-in profile is written: another profile id is never looked up or changed', async () => {
    const f = fake({ avatar_url: null });
    const result = await replaceProfileAvatar({ client: f.client as never, supabaseUrl: SUPABASE, profileId: other, bytes: png });
    expect(result.status).toBe(503);
    expect(f.upload).not.toHaveBeenCalled();
    expect(f.state.avatar_url).toBeNull();
  });
});
