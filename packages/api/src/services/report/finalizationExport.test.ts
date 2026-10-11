/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { reportMarkdown, reportSchema } from '../artifacts/public';
const legacy = { available: true, version: 1, hash: 'saved-hash', report: {
  title: 'Positioning', sections: [{ title: 'Facts', stepId: 's', body: 'Confirmed fields',
    confirmationId: randomUUID(), evidenceIds: [] }], sources: [], limitations: 'Known limits',
} };
const generatedReport = { executionId: randomUUID(), evidenceId: randomUUID(), revision: 1,
  body: '## One\nFinal manual body <script>alert(1)</script> ![image](https://example.com)',
  bodyHash: 'a'.repeat(64), manuallyEdited: true };
it('exports the authoritative final report rather than the original field assembly', () => {
  const final = reportSchema.parse({ ...legacy, report: { ...legacy.report, generatedReport } });
  const text = reportMarkdown(final);
  expect(text).toContain('Final manual body');
  expect(text).toContain('报告已手动修改');
  expect(text).not.toContain('Confirmed fields');
  expect(text).toContain('&lt;script&gt;');
  expect(text).not.toContain('<script>');
  expect(text).not.toContain('![image]');
});
it('preserves the existing export of historical reports', () => {
  const text = reportMarkdown(reportSchema.parse(legacy));
  expect(text).toContain('Confirmed fields');
  expect(text).not.toContain('报告已手动修改');
});
it('never exports an unavailable or erased report', () => {
  expect(() => reportMarkdown(reportSchema.parse({ available: false }))).toThrow('ARTIFACT_EVIDENCE_UNAVAILABLE');
});
