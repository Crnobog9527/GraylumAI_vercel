/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { pillarsSaveInput, readPillars, savePillars } from './pillars';

const actor = '11111111-1111-4111-8111-111111111111', business = '22222222-2222-4222-8222-222222222222';
const db = (data: unknown, error: { message: string } | null = null) => ({ rpc: vi.fn(async () => ({ data, error })) });

describe('content pillar setting', () => {
  it('reads every reviewable brand with its pillars', async () => {
    const d = db([{ businessId: business, businessName: '家常菜', pillars: [{ key: 'p1', name: '读书', definition: '读书' }], source: 'extracted' }]);
    expect((await readPillars(d as never, actor))[0]!.pillars[0]!.key).toBe('p1');
    expect(d.rpc).toHaveBeenCalledWith('publish_monitor_coach_pillars', { a: actor });
  });

  it('saves the whole list in order and says database refusals as their codes', async () => {
    const d = db({ businessId: business, pillars: [{ key: 'p2', name: 'b', definition: 'b' }], source: 'user', removed: ['p1'] });
    const input = pillarsSaveInput.parse({ businessId: business, pillars: [{ key: 'p2', name: ' b ' }, { key: null, name: '新' }],
      base: [{ key: 'p1', name: 'a' }, { key: 'p2', name: 'b' }] });
    expect(input.pillars[0]!.name).toBe('b');
    await savePillars(d as never, actor, input);
    expect(d.rpc).toHaveBeenCalledWith('publish_monitor_coach_pillars_save', { a: actor, p_business_id: business, p_pillars: input.pillars,
      p_base: input.base });
    await expect(savePillars(db(null, { message: 'PUBLISH_MONITOR_PILLAR_KEY_INVALID' }) as never, actor, input))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'PUBLISH_MONITOR_PILLAR_KEY_INVALID' });
    await expect(savePillars(db(null, { message: 'PUBLISH_MONITOR_PILLARS_CHANGED' }) as never, actor, input))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'PUBLISH_MONITOR_PILLARS_CHANGED' });
    await expect(savePillars(db(null, { message: 'boom' }) as never, actor, input)).rejects.toThrow('PUBLISH_MONITOR_REVIEW_UNAVAILABLE');
  });

  it('refuses a duplicate name, more than 6, an empty name or a made-up key before the database', async () => {
    const d = db(null);
    await expect(savePillars(d as never, actor, { businessId: business, pillars: [{ key: null, name: 'A' }, { key: null, name: 'a' }], base: [] }))
      .rejects.toMatchObject({ message: 'PUBLISH_MONITOR_PILLAR_NAME_DUPLICATE' });
    // The comparison title tagging uses: spaces and full-width letters do not make two names.
    await expect(savePillars(d as never, actor, { businessId: business, pillars: [{ key: null, name: '读书 笔记' }, { key: null, name: '读书笔记' }], base: [] }))
      .rejects.toMatchObject({ message: 'PUBLISH_MONITOR_PILLAR_NAME_DUPLICATE' });
    await expect(savePillars(d as never, actor, { businessId: business, pillars: [{ key: null, name: 'ＡＢ' }, { key: null, name: 'ab' }], base: [] }))
      .rejects.toMatchObject({ message: 'PUBLISH_MONITOR_PILLAR_NAME_DUPLICATE' });
    expect(d.rpc).not.toHaveBeenCalled();
    expect(pillarsSaveInput.safeParse({ businessId: business, base: [], pillars: Array.from({ length: 7 }, () => ({ key: null, name: 'x' })) }).success).toBe(false);
    expect(pillarsSaveInput.safeParse({ businessId: business, base: [], pillars: [{ key: null, name: '  ' }] }).success).toBe(false);
    // 40 characters, an emoji counting as one, is allowed; 41 is not.
    expect(pillarsSaveInput.safeParse({ businessId: business, base: [], pillars: [{ key: null, name: '😀'.repeat(40) }] }).success).toBe(true);
    expect(pillarsSaveInput.safeParse({ businessId: business, base: [], pillars: [{ key: null, name: '😀'.repeat(41) }] }).success).toBe(false);
    expect(pillarsSaveInput.safeParse({ businessId: business, base: [], pillars: [{ key: 'P-1', name: 'x' }] }).success).toBe(false);
  });
});
