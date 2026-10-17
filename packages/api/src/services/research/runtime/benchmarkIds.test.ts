/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { stableResearchId } from './toolContext';

// 0268 research_benchmark_operation_id recomputes these ids to bind benchmark evidence to its own fetch attempt;
// packages/db/tests/research-benchmarks pins the SQL side to the same value.
it('stableResearchId keeps the layout the benchmark table recomputes', () => {
  expect(stableResearchId('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'account_profile'))
    .toBe('3f40c5bf-153d-4715-afd9-a006774ffa94');
});
