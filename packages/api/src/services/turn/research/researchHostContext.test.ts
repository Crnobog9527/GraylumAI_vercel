/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// pay4 2026-11-28, seq 32: the benchmark rows carry account ids only, so the coach said the names the user wrote were not in its
// records. The host names each row from the label on its candidate card.
import { describe, expect, it } from 'vitest';
import { researchContextFrom } from './researchHostContext';

const sec = (c: string) => 'MS4wLjABAAAA' + c.repeat(40);
const row = (account: string, qualified: boolean, excluded: string | null = null) => ({ platform: 'douyin', account, followers: 81186,
  medianViews: null, engagementRate: null, postsPerWeek: 1.4, lastPublishedAt: '2026-11-27T00:00:00Z', postsAnalyzed: 21,
  category: qualified ? 'imitable' : null, qualified, excluded, missing: ['medianViews', 'engagementRate'], fetchedAt: '2026-11-28T05:00:00Z' });

describe('the benchmark rows the coach sees carry the account names of the candidate cards (I)', () => {
  it('names each row by its card label, without the activity note, and leaves an unnamed account as it is', async () => {
    const options = [{ id: 'c0', platform: 'douyin', account: sec('a'), label: '云朵泡芙 · 活跃度待核对', selectable: true },
      { id: 'c1', platform: 'douyin', account: sec('b'), label: '小熊猫手工皮具工作室', selectable: true },
      { id: 'c2', platform: 'douyin', account: sec('c'), label: sec('c'), selectable: true }];
    const research = await researchContextFrom({
      cards: [{ cardId: '10000000-0000-4000-8000-000000000001', kind: 'candidates', confirmationId: '10000000-0000-4000-8000-000000000002',
        items: options.slice(0, 3), options }],
      benchmarks: { rows: [row(sec('a'), false, 'OFF_TOPIC'), row(sec('b'), true), row(sec('c'), true)], hash: 'a'.repeat(64) },
      shortfall: null, discoveryOf: async () => '10000000-0000-4000-8000-000000000003' });
    const named = Object.fromEntries(research.benchmarks.rows.map(r => [r.account, r.name]));
    expect(named).toEqual({ [sec('a')]: '云朵泡芙', [sec('b')]: '小熊猫手工皮具工作室', [sec('c')]: undefined });
    expect(research.benchmarks.rows.find(r => r.account === sec('a'))).toMatchObject({ qualified: false, excluded: 'OFF_TOPIC' });
    expect(research.benchmarks.qualified).toBe(2);
  });
});
