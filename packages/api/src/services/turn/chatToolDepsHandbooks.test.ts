/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ tier: { level: 'pro', ownDataWindowDays: 30, allowBenchmarkMonitor: false } as { level: string; ownDataWindowDays: number;
  allowBenchmarkMonitor: boolean }, coachOn: true, handbooks: vi.fn() }));
vi.mock('../membershipEntitlements', () => ({ readOwnDataTier: async () => mocks.tier }));
vi.mock('./agent/workspacePosts', () => ({ admitOwnPosts: async () => true }));
vi.mock('./settings/settingsRows', () => ({ rowFor: (_rows: unknown, key: string) => ({ data: { value: key.includes('coach') ? mocks.coachOn : true } }) }));
vi.mock('../publishMonitor/coach/handbooks', () => ({ loadChatHandbooks: mocks.handbooks }));
import { chatToolDeps } from './chatToolDeps';

const admin = { rpc: vi.fn(async () => ({ data: ['v1'], error: null })) } as unknown as SupabaseClient;
const workspace = () => chatToolDeps(admin, () => admin).workspace!('00000000-0000-4000-8000-000000000001', Promise.resolve({ data: [], error: null }) as never);

describe('the coach handbooks of a chat turn are read before turn_open, only for a member who can use the chat review', () => {
  beforeEach(() => { mocks.handbooks.mockReset().mockResolvedValue(new Map([['tiktok', {}]])); mocks.coachOn = true; mocks.tier.ownDataWindowDays = 30; });

  it('coach switch on and an own-data window: the handbooks travel in the posts access', async () => {
    const access = await workspace();
    expect(access.posts?.handbooks?.has('tiktok')).toBe(true);
    expect(mocks.handbooks).toHaveBeenCalledTimes(1);
  });

  it('free window (0) or the switch off: nothing is read', async () => {
    mocks.tier.ownDataWindowDays = 0;
    expect((await workspace()).posts?.handbooks).toBeUndefined();
    mocks.tier.ownDataWindowDays = 30; mocks.coachOn = false;
    expect((await workspace()).posts?.handbooks).toBeUndefined();
    expect(mocks.handbooks).not.toHaveBeenCalled();
  });

  it('no handbooks available (empty Map): the access carries none and the review runs on the member\'s own data', async () => {
    mocks.handbooks.mockResolvedValue(new Map());
    expect((await workspace()).posts?.handbooks?.size ?? 0).toBe(0);
  });
});
