/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { summaryRetryAllowed } from './reviewRetry';

it('retries only one refused summary, only while the estimate plus one more summary stays within the budget line', () => {
  const base = { summaryVerdicts: ['revision_invalid'], estimateUsd: '2.9', summaryCapUsd: '1.2', maxBudgetUsd: '5' };
  expect(summaryRetryAllowed(base)).toBe(true);
  expect(summaryRetryAllowed({ ...base, summaryVerdicts: ['revision_invalid', 'revision_invalid'] })).toBe(false);
  expect(summaryRetryAllowed({ ...base, summaryVerdicts: ['no_delivery'] })).toBe(false);
  expect(summaryRetryAllowed({ ...base, summaryVerdicts: ['revision_invalid', 'usable'] })).toBe(false);
  expect(summaryRetryAllowed({ ...base, maxBudgetUsd: '4' })).toBe(false);
  expect(summaryRetryAllowed({ ...base, maxBudgetUsd: null })).toBe(false);
  expect(summaryRetryAllowed({ ...base, summaryCapUsd: undefined })).toBe(false);
});
