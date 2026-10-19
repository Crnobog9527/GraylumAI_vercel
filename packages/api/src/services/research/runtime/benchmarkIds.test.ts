/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { stableResearchId } from './toolContext';
import { BENCHMARK_EXTRA_POST_PAGES } from '../vendors/config';

// 0268 research_benchmark_operation_id recomputes these ids to bind benchmark evidence to its own fetch attempt;
// packages/db/tests/research-benchmarks pins the SQL side to the same value.
it('stableResearchId keeps the layout the benchmark table recomputes', () => {
  expect(stableResearchId('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'account_profile'))
    .toBe('3f40c5bf-153d-4715-afd9-a006774ffa94');
});

// 0315 research_benchmark_post_operations recomputes the later posts pages (`String(page)` as the fourth part) and
// accepts pages 1–3 only: raising a platform's extra pages beyond 2 needs a migration first.
it('later posts pages keep the id layout and the page bound the benchmark table accepts', () => {
  expect(stableResearchId('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'account_posts', '2'))
    .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(Math.max(0, ...Object.values(BENCHMARK_EXTRA_POST_PAGES))).toBeLessThanOrEqual(2);
});
