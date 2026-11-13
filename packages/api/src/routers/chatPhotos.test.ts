/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { chatPhotosRouter } from './chatPhotos';

const ME = '00000000-0000-4000-8000-0000000000c1';
const SESSION = '00000000-0000-4000-8000-0000000000a1';
const name = (turn: number, index: number) => `${SESSION}.${turn}.${index}.00000000-0000-4000-8000-00000000000${turn}.jpg`;
const profile = { id: ME, role: 'user', status: 'active', nickname: 'U', email: 'u@example.com' };
const scoped = { from: () => ({ select() { return this; }, eq() { return this; }, single: async () => ({ data: profile, error: null }),
  maybeSingle: async () => ({ data: profile, error: null }) }) };

function caller(names: string[], admin = true) {
  const list = vi.fn(async (_prefix: string, options: { search?: string }) => ({ error: null,
    data: names.filter(item => item.startsWith(options.search ?? '')).map(item => ({ name: item, id: item })) }));
  const call = chatPhotosRouter.createCaller({ headers: new Headers(), user: { id: ME, email: 'u@example.com', app_metadata: {}, user_metadata: {} },
    profileId: ME, isEmailVerified: true, authProvider: 'email', supabase: scoped, supabaseAuth: scoped, supabasePublic: {},
    supabaseAdmin: { ...scoped, storage: { from: () => ({ list }) } }, hasSupabaseAdminPrivileges: admin } as never);
  return { call, list };
}

describe('chatPhotos.list (Owner 2026-11-13: only the owner sees their photos)', () => {
  it('the caller\'s own photos of the conversation, by turn and position, as view-route addresses', async () => {
    const t = caller([name(2, 1), name(1, 0), name(2, 0)]);
    const photos = await t.call.list({ sessionId: SESSION });
    expect(t.list).toHaveBeenCalledWith(ME, expect.objectContaining({ search: `${SESSION}.` }));
    expect(photos.map(photo => [photo.turnId, photo.index])).toEqual([[1, 0], [2, 0], [2, 1]]);
    expect(photos[0]!.src).toBe(`/api/chat-photos/view?p=${encodeURIComponent(`${ME}/${name(1, 0)}`)}`);
  });

  it('lists under the caller\'s own profile only, refuses a bad id, and says unavailable without the service', async () => {
    const t = caller([]);
    expect(await t.call.list({ sessionId: SESSION })).toEqual([]);
    expect(t.list.mock.calls[0]![0]).toBe(ME);
    await expect(t.call.list({ sessionId: 'not-a-uuid' })).rejects.toThrow();
    await expect(caller([], false).call.list({ sessionId: SESSION })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
