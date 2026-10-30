/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decimal } from '../../bill2/decimal';
import { turnPolicy } from '../policy';
import { paidToolBounds, planTurnTools, type PlanInput } from './plan';
import { fallbackEligible, researchRounds } from './rounds';
import { policy, researchSettings } from './__tests__/fixtures';

function input(over: Partial<PlanInput> = {}, settings = researchSettings()): PlanInput {
  const rows = Object.entries(settings).map(([key, value]) => ({ key, value }));
  return { admin: {} as SupabaseClient, configuration: Promise.resolve({ data: rows, error: null }),
    offered: ['load_skill', 'social_search', 'social_account', 'web_search', 'web_fetch'], requiredBytes: 20_000, inputBytes: 90_000,
    researchInputBytes: 150_000, modelMultiplier: '6', defaultMultiplier: '6', readKey: async () => 'K', ...over };
}

describe('the tools of a turn, planned before turn_open (CORE-PATH-V2 2.5.3, 2.7)', () => {
  it('everything usable: limits and bounds for the freeze, no note', async () => {
    const { plan, research } = await planTurnTools(input());
    expect(plan.available).toEqual(['load_skill', 'social_search', 'social_account', 'web_search', 'web_fetch']);
    expect(plan.trimmed).toEqual([]);
    expect(plan.note).toBeNull();
    expect(plan.limits).toEqual({ paidTools: 3, freeTools: 2 });
    expect(plan.subcalls).toBe(12);
    expect(Object.keys(research!.keys).sort()).toEqual(['firecrawl', 'parallel', 'tikhub']);
    // 12 subcalls at the highest route price (0.01) = 0.12 USD, split over the 3 paid calls.
    expect(plan.paidToolUpperUsd).toEqual(['0.04', '0.04', '0.04']);
    // It is a valid freeze: M = 1 + 3 + 2 model calls, and G covers every subcall.
    const frozen = turnPolicy({ q: '100', multiplier: '6', modelUpperUsd: '0.01', limits: { model: 6, ...plan.limits, decisions: 0 },
      paidToolUpperUsd: plan.paidToolUpperUsd, stopLoss: { limitUsd: 100, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 },
      historyItems: 10, inputBytes: 150_000, startThresholdCredits: 1 });
    expect(frozen.gCredits).toBe(6 * 6 + 3 * 24);
  });

  it('the chat research switch off: research tools stay offered but trimmed as disabled, with a note and no freeze', async () => {
    const { plan, research } = await planTurnTools(input({}, researchSettings(false)));
    expect(research).toBeNull();
    expect(plan.offered).toContain('social_search');
    expect(plan.trimmed).toEqual(['social_search', 'social_account', 'web_search', 'web_fetch'].map(name => ({ name, reason: 'disabled' })));
    expect(plan.limits.paidTools).toBe(0);
    expect(plan.paidToolUpperUsd).toEqual([]);
    expect(plan.note).toContain('social_search (disabled)');
  });

  it('capacity: the required context leaves no room for a result, so the tools are trimmed and said so (never silently)', async () => {
    const { plan } = await planTurnTools(input({ requiredBytes: 140_000 }));
    expect(plan.trimmed).toContainEqual({ name: 'load_skill', reason: 'capacity' });
    expect(plan.trimmed).toContainEqual({ name: 'web_search', reason: 'capacity' });
    expect(plan.limits).toEqual({ paidTools: 0, freeTools: 0 });
    expect(plan.note).toMatch(/capacity/);
  });

  it('an empty key slot trims only the tools of that supplier', async () => {
    const { plan, research } = await planTurnTools(input({ readKey: async vendor => vendor === 'firecrawl' ? null : 'K' }));
    expect(plan.trimmed).toEqual([{ name: 'web_fetch', reason: 'no_key' }]);
    expect(research!.policies.some(p => p.provider === 'firecrawl')).toBe(false);
  });

  it('read_skill_file needs no row or freeze; a free tool without anything to serve is trimmed', async () => {
    const { plan } = await planTurnTools(input({ offered: ['read_skill_file', 'load_skill'], freeReady: { load_skill: false } }));
    expect(plan.available).toEqual(['read_skill_file']);
    expect(plan.trimmed).toEqual([{ name: 'load_skill', reason: 'disabled' }]);
    expect(plan.limits).toEqual({ paidTools: 0, freeTools: 0 });
  });
});

describe('paid tool bounds', () => {
  it('sum to at least subcalls x the highest price, scaled up when a route multiplier exceeds the model one', () => {
    const sum = (values: string[]) => values.reduce((s, v) => s + decimal(v), 0n);
    expect(sum(paidToolBounds([policy('tikhub', 'a', '0.001')], 3, 12, '6'))).toBe(decimal('0.012'));
    expect(paidToolBounds([policy('tikhub', 'a', '0.001')], 3, 10, '6')).toEqual(['0.003333333334', '0.003333333333', '0.003333333333']);
    // m 12 on the route, 6 on the model: the bound doubles, so ceil(q x U x 6) still covers ceil(q x n x 12).
    expect(sum(paidToolBounds([policy('tikhub', 'a', '0.001', '12')], 1, 12, '6'))).toBe(decimal('0.024'));
    expect(paidToolBounds([], 3, 12, '6')).toEqual([]);
  });
});

describe('research rounds (Owner 10-20 fallback B, 10-27 pasted links count)', () => {
  it('counts delivered discoveries and distinct completed link checks only', () => {
    const r = researchRounds();
    r.discovery('delivered'); r.discovery('no_data'); r.discovery('unknown');
    r.linkCheck('m1', 'delivered'); r.linkCheck('m1', 'delivered'); r.linkCheck('m2', 'not_sent');
    expect(r.value()).toEqual({ keywordSearches: 1, linkChecks: 1 });
    expect(fallbackEligible({ qualified: 1, rounds: r.value() })).toBe(true);
    expect(fallbackEligible({ qualified: 0, rounds: r.value() })).toBe(false);
    expect(fallbackEligible({ qualified: 3, rounds: { keywordSearches: 1, linkChecks: 0 } })).toBe(false);
  });
});
