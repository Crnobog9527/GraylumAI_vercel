/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ user: vi.fn(), read: vi.fn(), service: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.user } }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.service }));
vi.mock('@repo/api/src/services/chatPhotos/photos', () => ({ readOwnPhoto: mocks.read }));
import { GET } from './route';
import { PHOTO_CACHE } from '@/lib/chat-photos';

const ME = '00000000-0000-4000-8000-000000000001';
const PATH = `${ME}/00000000-0000-4000-8000-0000000000a1.7.0.00000000-0000-4000-8000-000000000071.jpg`;
const get = (path = PATH) => GET(new NextRequest(`https://www.graylum.com/api/chat-photos/view?p=${encodeURIComponent(path)}`));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
  mocks.service.mockReturnValue({ service: true });
  mocks.user.mockResolvedValue({ data: { user: { id: ME } } });
  mocks.read.mockResolvedValue({ ok: true, bytes: new Uint8Array([0xff, 0xd8, 0xff]) });
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/chat-photos/view (Owner 2026-11-13: only the owner sees their photos)', () => {
  it('the signed-in user\'s own photo, kept by their browser only and only briefly', async () => {
    const response = await get();
    expect(mocks.read).toHaveBeenCalledWith({ service: true }, ME, PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    // Deleting a conversation deletes its photos (Owner): a browser keeps one at most five minutes, never "immutable".
    const cache = response.headers.get('cache-control')!;
    expect(cache).toBe(PHOTO_CACHE);
    expect(cache).toMatch(/^private,/);
    expect(cache).not.toMatch(/immutable|public|s-maxage/);
    expect(Number(/max-age=(\d+)/.exec(cache)![1])).toBeLessThanOrEqual(300);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('signed out: nothing is read; another account\'s photo (refused by readOwnPhoto) is not found and not cached', async () => {
    mocks.user.mockResolvedValueOnce({ data: { user: null } });
    expect((await get()).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.read.mockResolvedValueOnce({ ok: false, status: 404 });
    const response = await get(PATH.replace(ME, '00000000-0000-4000-8000-000000000002'));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    // The owner is always the session's user, never the address's.
    expect(mocks.read.mock.calls.at(-1)?.[1]).toBe(ME);
  });

  it('without the server configured it says unavailable', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    expect((await get()).status).toBe(503);
  });
});
