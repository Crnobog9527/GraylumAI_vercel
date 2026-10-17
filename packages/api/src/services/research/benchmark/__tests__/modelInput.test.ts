/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Must-test 5 at the model boundary: no research tool accepts a benchmark number from the model. The table itself
// (0268) is filled only from fetched evidence; packages/db/tests/research-benchmarks covers the database side.
import { describe, expect, it } from 'vitest';
import { POSITIONING_RESEARCH_TOOLS, researchToolArgs } from '../../tools/schemas';

const id = '00000000-0000-4000-8000-000000000001';
const valid: Record<string, unknown> = {
  propose_keywords: { keywords: ['a', 'b', 'c'] },
  benchmark_discover: { keywordConfirmationId: id, platforms: ['tiktok'] },
  propose_more_candidates: { discoveryId: id },
  benchmark_fetch: { accounts: [{ platform: 'tiktok', account: 'alpha' }], source: { kind: 'candidate', confirmationId: id } },
  web_search: { query: 'q' },
  web_fetch: { url: 'https://example.com/' },
};
const numbers = { followers: 150000, medianViews: 99999, engagementRate: 0.5, qualified: true,
  metrics: { followers: { value: 1, refs: [] } }, classification: { category: 'imitable', qualified: true, excluded: null } };

describe('benchmark numbers never come from model arguments', () => {
  it.each(POSITIONING_RESEARCH_TOOLS)('%s rejects benchmark number fields', name => {
    const schema = researchToolArgs[name];
    expect(schema.safeParse(valid[name]).success).toBe(true);
    for (const [key, value] of Object.entries(numbers)) {
      expect(schema.safeParse({ ...(valid[name] as object), [key]: value }).success).toBe(false);
    }
  });
  it('benchmark_fetch accounts carry only platform and account', () => {
    const args = valid.benchmark_fetch as { accounts: object[] };
    expect(researchToolArgs.benchmark_fetch.safeParse({ ...args,
      accounts: [{ platform: 'tiktok', account: 'alpha', followers: 150000 }] }).success).toBe(false);
  });
});
