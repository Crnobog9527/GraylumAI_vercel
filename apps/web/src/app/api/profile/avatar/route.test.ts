/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), replace: vi.fn(), log: vi.fn(), getUser: vi.fn(), maintenance: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/server-log', () => ({ logServerError: mocks.log }));
vi.mock('@repo/api/src/services/profileAvatar/storage', () => ({ AVATAR_MAX_BYTES: 2 * 1024 * 1024, replaceProfileAvatar: mocks.replace }));
import { POST } from './route';

const me = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const request = (options: { auth?: boolean; file?: File | string | null; extra?: Record<string, string>; length?: string } = {}) => {
  const form = new FormData();
  const file = options.file === undefined ? new File([png], 'a.png', { type: 'image/png' }) : options.file;
  if (file !== null) form.set('file', file);
  for (const [key, value] of Object.entries(options.extra ?? {})) form.set(key, value);
  const headers: Record<string, string> = options.auth === false ? {} : { authorization: 'Bearer synthetic-token' };
  if (options.length) headers['content-length'] = options.length;
  return new NextRequest('https://graylum.test/api/profile/avatar', { method: 'POST', headers, body: form });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
  mocks.getUser.mockResolvedValue({ data: { user: { id: me } }, error: null });
  mocks.maintenance.mockResolvedValue({ data: { value: false }, error: null });
  const query = { select: () => query, eq: () => query, maybeSingle: mocks.maintenance };
  mocks.createClient.mockImplementation(() => ({ auth: { getUser: mocks.getUser }, from: () => query }));
  mocks.replace.mockResolvedValue({ status: 200, avatarUrl: 'https://proj.supabase.co/storage/v1/object/public/profile-avatars/x' });
});

describe('POST /api/profile/avatar', () => {
  it('saves the avatar for the signed-in user only, ignoring any id sent in the form', async () => {
    const response = await POST(request({ extra: { profileId: other, userId: other } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ avatarUrl: 'https://proj.supabase.co/storage/v1/object/public/profile-avatars/x' });
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profileId: me, supabaseUrl: 'https://proj.supabase.co',
      bytes: png }));
  });

  it('refuses a request without a valid sign-in', async () => {
    expect((await POST(request({ auth: false }))).status).toBe(401);
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('bad jwt') });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('refuses an oversized body before reading it, and an oversized file', async () => {
    const tooBig = await POST(request({ length: String(3 * 1024 * 1024) }));
    expect([tooBig.status, await tooBig.json()]).toEqual([413, { error: '图片不能超过 2MB' }]);
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    expect((await POST(request({ file: big }))).status).toBe(413);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('passes the service\'s refusal through (wrong type, closed account, a race)', async () => {
    for (const refusal of [{ status: 400, error: '只支持 JPG、PNG 或 WebP 图片' }, { status: 403, error: '当前账号不能修改头像' },
      { status: 409, error: '头像刚刚被更新过，请再试一次' }]) {
      mocks.replace.mockResolvedValueOnce(refusal);
      const response = await POST(request());
      expect([response.status, await response.json()]).toEqual([refusal.status, { error: refusal.error }]);
    }
  });

  it('no file, maintenance, or a read failure of the maintenance switch: nothing is saved', async () => {
    expect((await POST(request({ file: null }))).status).toBe(400);
    expect((await POST(request({ file: 'not a file' }))).status).toBe(400);
    mocks.maintenance.mockResolvedValueOnce({ data: { value: true }, error: null });
    expect((await POST(request())).status).toBe(503);
    mocks.maintenance.mockResolvedValueOnce({ data: null, error: new Error('down') });
    expect((await POST(request())).status).toBe(503);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('an unexpected failure is a plain 500 with no detail', async () => {
    mocks.replace.mockRejectedValueOnce(new Error('private detail'));
    const response = await POST(request());
    expect([response.status, await response.json()]).toEqual([500, { error: '头像暂时无法保存，请稍后重试' }]);
    expect(mocks.log).toHaveBeenCalledWith('api', 'profile_avatar_upload_failed');
  });
});
