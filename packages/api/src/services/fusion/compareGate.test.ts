/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { judgeCompareGate, readCompareGate, staticCompareGate, type CompareGate } from './compareGate';

const gate = (patch: Partial<CompareGate> = {}): CompareGate => ({ gated: true, capped: false, state: { positioned: false, refusals24h: 0 }, ...patch });
const text = { text: '帮我起号', apiKey: 'k' };
const refuse = () => { throw new Error('POSITIONING_REQUIRED'); };

describe('compare positioning gate', () => {
  it('reads the same facts as an ordinary turn: positioned users are never gated; the cap is 5 refunded refusals in 24 hours', async () => {
    const admin = (data: unknown) => ({ rpc: async () => ({ data, error: null }) }) as unknown as SupabaseClient;
    expect(await readCompareGate(admin({ positioned: true, refusals24h: 9 }), 'a')).toMatchObject({ gated: false, capped: false });
    expect(await readCompareGate(admin({ positioned: false, refusals24h: 4 }), 'a')).toMatchObject({ gated: true, capped: false });
    expect(await readCompareGate(admin({ positioned: false, refusals24h: 5 }), 'a')).toMatchObject({ gated: true, capped: true });
  });
  it('a positioned user is admitted without any paid judgement', async () => {
    const classify = vi.fn();
    expect(await judgeCompareGate(gate({ gated: false }), text, classify)).toEqual({ verdict: 'allow', refused: false, fallback: false });
    expect(classify).not.toHaveBeenCalled();
  });
  it('below the cap: block refuses; clear, allow and unavailable go on with the fallback rule', async () => {
    expect(await judgeCompareGate(gate(), text, async () => 'block')).toMatchObject({ verdict: 'block', refused: true });
    for (const verdict of ['clear', 'allow', 'unavailable'] as const)
      expect(await judgeCompareGate(gate(), text, async () => verdict)).toEqual({ verdict, refused: false, fallback: true });
  });
  it('at the cap only clear goes on, without the fallback rule; everything else is refused with no model call', async () => {
    expect(await judgeCompareGate(gate({ capped: true }), text, async () => 'clear')).toEqual({ verdict: 'clear', refused: false, fallback: false });
    for (const verdict of ['allow', 'unavailable', 'block'] as const)
      expect(await judgeCompareGate(gate({ capped: true }), text, async () => verdict)).toMatchObject({ verdict: 'block', refused: true });
  });
  it('a classifier that throws counts as unavailable', async () => {
    expect(await judgeCompareGate(gate(), text, async () => { throw new Error('x'); })).toEqual({ verdict: 'unavailable', refused: false, fallback: true });
    expect(await judgeCompareGate(gate({ capped: true }), text, async () => { throw new Error('x'); })).toMatchObject({ refused: true });
  });
  it('the free static check refuses a social-media Skill for a user without a positioning, and only reports the cap otherwise', () => {
    expect(() => staticCompareGate(gate(), { socialMedia: true }, refuse)).toThrow('POSITIONING_REQUIRED');
    expect(staticCompareGate(gate({ gated: false }), { socialMedia: true }, refuse)).toEqual({ refundCapReached: false });
    expect(staticCompareGate(gate({ capped: true }), { socialMedia: false }, refuse)).toEqual({ refundCapReached: true });
    expect(staticCompareGate(gate(), null, refuse)).toEqual({ refundCapReached: false });
  });
});
