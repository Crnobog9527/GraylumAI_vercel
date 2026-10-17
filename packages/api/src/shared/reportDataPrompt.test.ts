/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { REPORT_DATA_FIELD_NAMES } from './reportDataSpec';
import { reportDataInstructions, specShape } from './reportDataPrompt';
import { REPORT_DATA_FIELDS } from './reportDataSpec';

it('describes every field from the shared definitions, with the text-only limit and the fence', () => {
  const text = reportDataInstructions(12000);
  for (const field of REPORT_DATA_FIELD_NAMES) expect(text).toContain(`\n${field}: `);
  expect(text).toContain('```graylum-report-data');
  expect(text).toContain('12000-character limit is for the report text only');
  expect(text).toContain('at most 9000 characters');
  expect(specShape(REPORT_DATA_FIELDS.plan30)).toContain('passIf: text≤120');
  expect(specShape(REPORT_DATA_FIELDS.thisWeek)).toContain('3-8 items');
  expect(specShape(REPORT_DATA_FIELDS.audience)).toContain('quote?: text≤120?');
});
