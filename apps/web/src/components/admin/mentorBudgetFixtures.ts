/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { BudgetView } from './mentorBudgetDraft';

/** Test views matching the mentorBudget.get contract. */
export const legacyView: BudgetView = {
  version: 1,
  config: null,
  source: 'legacy',
  limits: { inputBytes: { interactive: 90000, organize: 112000, report: 90000 }, maxOutputTokens: 8192, historyItems: 1000 },
  organizeOutput: { source: 'v3_summary_max_tokens', maxOutputTokens: 2048 },
  legacy: {
    interactive: { inputBytes: 64000, historyItems: 100, fixtureMaxOutputTokens: 1000, realOutput: 'min(approved quote, model, global output cap)' },
    organize: { historyItems: 0 },
    report: { active: false },
  },
};
export const configuredView: BudgetView = {
  ...legacyView,
  source: 'configured',
  config: {
    version: 1,
    interactive: { inputBytes: 64000, maxOutputTokens: 8192, historyItems: 100 },
    organize: { inputBytes: 112000, historyItems: 0 },
    report: { inputBytes: 90000, maxOutputTokens: 8192, historyItems: 1000 },
  },
};
