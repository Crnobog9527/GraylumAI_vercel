/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { giftLevel, noteOpeningGrant } from './giftAlert';
import { renderAlert } from '../ownerAlerts/templates';
import { dedupeKey } from '../ownerAlerts/kinds';

describe('giftLevel', () => {
  it('is half from half the cap, near_full from 90%, nothing below or with a cap of 0', () => {
    expect([14, 15, 26, 27, 30, 31].map(n => giftLevel(n, 30))).toEqual([null, 'half', 'half', 'near_full', 'near_full', 'near_full']);
    expect(giftLevel(0, 1)).toBeNull();
    expect(giftLevel(1, 1)).toBe('near_full');
    expect(giftLevel(5, 0)).toBeNull();
  });
});

describe('noteOpeningGrant', () => {
  it('alerts with the day, level and counts from the claim answer', async () => {
    const notify = vi.fn(async () => true);
    await noteOpeningGrant({ granted: true, gift: { day: '2026-11-13', granted: 15, cap: 30 } }, notify);
    expect(notify).toHaveBeenCalledWith('signup_gift_level', { day: '2026-11-13', granted: 15, cap: 30, level: 'half' },
      expect.objectContaining({ budgetMs: expect.any(Number) }));
  });

  it('stays quiet below half, on a refusal, on an old answer without counts, and never throws', async () => {
    const notify = vi.fn(async () => true);
    for (const answer of [{ granted: true, gift: { day: '2026-11-13', granted: 3, cap: 30 } }, { granted: false }, { granted: true }, null,
      { granted: true, gift: { day: 1, granted: 'x', cap: 30 } }]) {
      await noteOpeningGrant(answer, notify);
    }
    expect(notify).not.toHaveBeenCalled();
    await expect(noteOpeningGrant({ granted: true, gift: { day: 'd', granted: 30, cap: 30 } },
      vi.fn(async () => { throw new Error('down'); }))).resolves.toBeUndefined();
  });

  it('is one message per Beijing day and level, in plain Chinese pointing at the settings page', () => {
    const facts = { day: '2026-11-13', level: 'near_full' as const, granted: 27, cap: 30 };
    expect(dedupeKey('signup_gift_level', facts, new Date())).toBe('signup_gift_level:2026-11-13:near_full');
    expect(dedupeKey('signup_gift_level', { ...facts, granted: 29 }, new Date())).toBe('signup_gift_level:2026-11-13:near_full');
    const text = renderAlert('signup_gift_level', facts, { origin: 'https://www.graylum.com', testSite: false });
    expect(text).toContain('快满了');
    expect(text).toContain('/admin/settings');
    expect(renderAlert('signup_gift_level', { ...facts, level: 'half', granted: 15 }, { origin: 'https://x', testSite: false }))
      .toContain('一半');
  });
});
