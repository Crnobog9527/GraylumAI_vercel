/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { benchmarkReportFacts, benchmarkShortfallNote, confirmedReportFacts, completeReportCandidate, frozenReport, reportManifest, REPORT_FACT_BYTES } from './contract';
import { frozenPurposeBudget, PURPOSE_INPUT_CAPS, PURPOSE_OUTPUT_CAP } from '../runtime/purposeBudgets';
import { runRuntime } from '../runtime/runner';
import type { ArtifactSnapshot } from '../artifacts/public';
import { runtimeContext } from '../runtime/runtimeContext';
function snapshot(n: number): ArtifactSnapshot {
  return { workflow: { steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Part ${i}` })) },
    state: 'draft', steps: Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, {
      valid: true, available: true, confirmationId: randomUUID(), body: `Synthetic fact ${i}`, version: 1,
      reviewVersion: 1, evidenceIds: [], provenanceIds: [],
    }])) } as unknown as ArtifactSnapshot;
}
const report = frozenReport.parse({ version: 1, projectId: randomUUID(), roundId: randomUUID(), snapshotHash: 'a'.repeat(64),
  packageHash: 'b'.repeat(64), workflowHash: 'c'.repeat(64), templateHash: 'd'.repeat(64), sections: ['One', 'Two'], maxCharacters: 12000 });
it.each([3, 6, 8])('loads only current confirmed facts for %s-step skills', n => {
  const input = snapshot(n), result = confirmedReportFacts(input);
  expect(JSON.parse(result.serialized)).toHaveLength(n);
  expect(result.snapshotHash).toHaveLength(64);
  input.steps.s0!.valid = false;
  expect(() => confirmedReportFacts(input)).toThrow('REPORT_CONFIRMATION_REQUIRED');
});
it('enforces exact serialized fact capacity without summarizing or dropping facts', () => {
  const input = snapshot(1), base = Buffer.byteLength(confirmedReportFacts(input).serialized);
  input.steps.s0!.body += 'x'.repeat(REPORT_FACT_BYTES - base);
  expect(Buffer.byteLength(confirmedReportFacts(input).serialized)).toBe(REPORT_FACT_BYTES);
  input.steps.s0!.body += 'x';
  expect(() => confirmedReportFacts(input)).toThrow('REPORT_FACTS_TOO_LARGE');
});
it('accepts report input 196608 and legacy snapshots; rejects +1 and non-report expansion', () => {
  expect(PURPOSE_INPUT_CAPS.report).toBe(196608);
  expect(PURPOSE_INPUT_CAPS.interactive).toBe(90000);
  expect(frozenPurposeBudget.parse({ purpose: 'report', inputBytes: 196608, historyItems: 0 }).inputBytes).toBe(196608);
  for (const [purpose, inputBytes] of [['report', 196609], ['interactive', 112001], ['organize', 112001]]) {
    expect(frozenPurposeBudget.safeParse({ purpose, inputBytes, historyItems: 0 }).success).toBe(false);
  }
  expect(frozenPurposeBudget.safeParse({ purpose: 'report', inputBytes: 90000, historyItems: 0 }).success).toBe(true);
});
it.each(['length_limit', 'stopped', undefined])('never offers a %s result as complete candidate', completeness => {
  expect(completeReportCandidate('## One\nBody\n## Two\nBody', completeness, report)).toBe(false);
});
it('validates exact declared sections and size for a complete candidate', () => {
  expect(completeReportCandidate('## One\nBody\n## Two\nBody', 'complete', report)).toBe(true);
  expect(completeReportCandidate('## One\nBody', 'complete', report)).toBe(false);
  expect(completeReportCandidate('## One\nBody\n## Two\n', 'complete', report)).toBe(false);
  expect(completeReportCandidate('## One\n' + 'x'.repeat(12000) + '\n## Two\nBody', 'complete', report)).toBe(false);
});
it.each(['stop', 'length'])('report SDK uses no persistent Session and never continues after %s', async finish_reason => {
  const touched = vi.fn(async () => { throw new Error('PERSISTENT_SESSION_USED'); });
  const exchange = vi.fn(async (_n: number, body: string) => {
    const request = JSON.parse(body);
    expect(request.max_tokens).toBe(PURPOSE_OUTPUT_CAP);
    expect(request.tools).toBeUndefined();
    expect(request.messages).toHaveLength(2);
    return JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 1, model: 'fixture/report',
      choices: [{ index: 0, finish_reason, message: { role: 'assistant', content: '## One\nBody' } }] });
  });
  expect(await runRuntime({ model: 'fixture/report', instructions: 'Report', input: 'Generate',
    session: { getSessionId: touched, getItems: touched, addItems: touched, popItem: touched, clearSession: touched },
    persistSession: false, maxOutputTokens: PURPOSE_OUTPUT_CAP, maxTurns: 1, tools: [],
    selectHistory: async (_history, incoming) => incoming, exchange })).toBe('## One\nBody');
  expect(touched).not.toHaveBeenCalled();
  expect(exchange).toHaveBeenCalledTimes(1);
});
it('frozen report rejects tools, history, cache and organizer', () => {
  const base = { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'skill', model: 'fixture/report',
    input: 'Generate', instructions: 'Report', maxOutputTokens: PURPOSE_OUTPUT_CAP, maxTurns: 1,
    historyItems: 0, tools: [], sources: [], network: 'deny', reportGeneration: report,
    purposeBudget: { purpose: 'report', inputBytes: 196608, historyItems: 0 } };
  expect(runtimeContext.safeParse(base).success).toBe(true);
  for (const override of [{ historyItems: 1 }, { tools: ['search'] }, { maxTurns: 2 }, { workspaceContext: true }]) {
    expect(runtimeContext.safeParse({ ...base, ...override }).success).toBe(false);
  }
});
it('benchmark facts come only from the host table rows; malformed rows fail closed', () => {
  const row = { platform: 'tiktok', account: 'alpha', followers: 50000, medianViews: null, engagementRate: 0.002, postsPerWeek: 1.4,
    lastPublishedAt: '2026-10-15T00:00:00+00:00', postsAnalyzed: 12, category: 'imitable', qualified: true, excluded: null,
    missing: ['medianViews'], fetchedAt: '2026-10-16T00:00:00+00:00' };
  const hash = 'f'.repeat(64);
  expect(benchmarkReportFacts({ rows: [], hash })).toEqual({ serialized: null, hash });
  expect(JSON.parse(benchmarkReportFacts({ rows: [row], hash }).serialized!)).toEqual([row]);
  for (const bad of [null, [row], { rows: [row] }, { rows: [row], hash: 'x' }, { rows: [{ ...row, followers: -1 }], hash },
    { rows: [{ ...row, interpretation: 'model text' }], hash }, { rows: Array(31).fill(row), hash }]) {
    expect(() => benchmarkReportFacts(bad)).toThrow('REPORT_UNAVAILABLE');
  }
  expect(frozenReport.safeParse({ ...report, benchmarkHash: hash }).success).toBe(true);
  expect(frozenReport.safeParse({ ...report, benchmarkHash: 'x' }).success).toBe(false);
});
it('a Skill may declare a benchmark minimum for its report; the host raises it to 3 in SQL', () => {
  const base = { resources: ['report.md'], sections: ['One'], maxCharacters: 12000 };
  expect(reportManifest.safeParse(base).success).toBe(true);
  expect(reportManifest.parse({ ...base, minQualifiedBenchmarks: 3 }).minQualifiedBenchmarks).toBe(3);
  for (const value of [0, 13, 2.5, '3']) expect(reportManifest.safeParse({ ...base, minQualifiedBenchmarks: value }).success).toBe(false);
});

it('BENCHMARK-SHORTFALL: the report is told the sample is short only with 1 to required-1 qualified accounts', () => {
  const row = (account: string, qualified: boolean) => ({ platform: 'tiktok', account, qualified });
  const table = (...rows: unknown[]) => JSON.stringify(rows);
  expect(benchmarkShortfallNote(null, 3)).toBeNull();
  expect(benchmarkShortfallNote(table(row('a', false)), 3)).toBeNull();
  expect(benchmarkShortfallNote(table(row('a', true), row('b', true), row('c', true)), 3)).toBeNull();
  const note = benchmarkShortfallNote(table(row('a', true), row('a', true), row('b', true), row('big', false)), 3)!;
  expect(note).toContain('only 2 qualified benchmark account(s)');
  expect(note).toContain('对标样本不足');
  expect(note).toContain('limited reference value');
  expect(note).toContain('look for more benchmarks later');
  expect(note).not.toMatch(/credit|积分/);
  expect(benchmarkShortfallNote(table(row('a', true)), 5)).toContain('asks for 5');
  expect(note).toContain('meeting the follower, activity and post-count data criteria');
  expect(note).toContain('Data qualification does not verify content/topic fit or suitability to imitate');
  expect(note).toContain('mark topic fit as unverified');
  expect(note).not.toContain('account(s) the user can learn from');
});
