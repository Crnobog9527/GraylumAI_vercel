/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ fetchPhoto: vi.fn() }));
vi.mock('@repo/api/src/services/chatPhotos/grant', () => ({ fetchGrantedPhoto: mocks.fetchPhoto }));
import { GET } from './route';

const PATH = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.7.0.00000000-0000-4000-8000-000000000001.jpg';
const get = (query: string) => GET(new NextRequest(`https://auth-staging.graylum.com/api/chat-photos/shared?${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co');
  mocks.fetchPhoto.mockResolvedValue({ ok: true, bytes: new Uint8Array([0xff, 0xd8, 0xff]) });
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/chat-photos/shared (Shotviva fetches one chat photo)', () => {
  it('passes the address\'s path and token to Storage\'s own check and returns the JPEG, never cached', async () => {
    const response = await get(`p=${encodeURIComponent(PATH)}&t=a.b.c`);
    expect(mocks.fetchPhoto).toHaveBeenCalledWith({ supabaseUrl: 'https://proj.supabase.co', path: PATH, token: 'a.b.c' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('location')).toBeNull();
  });

  it('a refused or expired token: no photo and nothing to cache', async () => {
    mocks.fetchPhoto.mockResolvedValueOnce({ ok: false, status: 404 });
    const response = await get('p=x&t=y');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.arrayBuffer()).toHaveProperty('byteLength', 0);
  });

  it('without Storage configured it says unavailable and asks nothing', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    expect((await get('p=x&t=y')).status).toBe(503);
    expect(mocks.fetchPhoto).not.toHaveBeenCalled();
  });
});
