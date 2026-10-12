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
it('exports an adopted review revision with its own label and still escapes it', () => {
  const revision = { source: 'review_revision', revisionId: randomUUID(), sourceVersionId: randomUUID(),
    body: '## One\nRevised <b>body</b>', bodyHash: 'b'.repeat(64), manuallyEdited: false, fieldsSynced: true };
  const text = reportMarkdown(reportSchema.parse({ ...legacy, report: { ...legacy.report, generatedReport: revision } }));
  expect(text).toContain('Revised &lt;b&gt;body&lt;/b&gt;');
  expect(text).toContain('评审修订稿（字段已同步）');
  expect(text).not.toContain('Confirmed fields');
  // A revision variant cannot claim a manual edit or unsynced fields.
  expect(reportSchema.safeParse({ ...legacy, report: { ...legacy.report,
    generatedReport: { ...revision, fieldsSynced: false } } }).success).toBe(false);
});
it('preserves the existing export of historical reports', () => {
  const text = reportMarkdown(reportSchema.parse(legacy));
  expect(text).toContain('Confirmed fields');
  expect(text).not.toContain('报告已手动修改');
});
it('never exports an unavailable or erased report', () => {
  expect(() => reportMarkdown(reportSchema.parse({ available: false }))).toThrow('ARTIFACT_EVIDENCE_UNAVAILABLE');
});
