/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { openRouterCallBound } from '../bill2/openRouterPolicy';
import { DECISIONS, parseOpinion } from './hostChecks';
import { fitted } from './reviewCore';
import { estimateReview } from './reviewEstimate';
import { mergeOpinions } from './reviewMerge';
import { summaryRequestMerged } from './reviewPrompts';
import { fusionRequestBytes } from './request';

// An opinion written out to the 8192-token cap (opinionOutputTokens): four key decisions and many issues, every text near its limit.
const sections = Array.from({ length: 12 }, (_, i) => `第${i + 1}章`);
const paragraph = (n: number) => `这是第${n}段的报告内容，写的是账号定位、受众、平台和变现的具体做法与数字。`.repeat(14);
const report = sections.map((name, i) => `## ${name}\n${paragraph(i)}`).join('\n');
const text = (seed: string, chars: number) => `${seed}：`.concat('具体到数字和做法的说明，'.repeat(Math.ceil(chars / 12))).slice(0, chars);
const opinion = (seat: number) => parseOpinion(JSON.stringify({
  decisions: DECISIONS.map(decision => ({ decision, strongestCase: text('理由', 1500), strongestAlternative: text('替代', 1500), verdict: 'change', basis: text('依据', 1500) })),
  issues: Array.from({ length: 24 }, (_, i) => ({ location: sections[i % sections.length], perspective: `视角${seat}`, severity: i % 3 === 0 ? 'critical' : i % 3 === 1 ? 'major' : 'minor',
    problem: text(`问题${seat}-${i}`, 700), suggestion: text(`建议${seat}-${i}`, 700), kind: 'content', quote: paragraph(i % sections.length).slice(0, 40), anchor: '' })),
}), { sections, report })!;

const real = (modelId: string, prompt: string, write: string, completion: string) => ({ modelId, outputLimit: 32768, multiplier: '3',
  providerLimits: { providerSlug: 'x', contextTokens: 1_000_000, promptUsdPerMillion: prompt, cacheWriteUsdPerMillion: write,
    completionUsdPerMillion: completion, requestUsd: '0' } });
const ids = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3'];

describe('the summary request when the opinions are written to the 8192 cap', () => {
  it('is trimmed to the priced bytes and its cost stays within the hold; trimming cuts opinion detail, never a chapter or declared field', () => {
    const declared = [{ stepId: 'step-1', fieldIds: Array.from({ length: 14 }, (_, i) => `f${i}`) }];
    const current = { 'step-1': Object.fromEntries(declared[0]!.fieldIds.map(id => [id, '好'.repeat(400)])) };
    const skill = { reviewer: 'r'.repeat(4000), summary: 's'.repeat(4000), rubric: 'b'.repeat(1000) };
    const context = { report, materials: [{ k: 'v' }], sections, maxCharacters: 12000 };
    const opinions = [0, 1, 2].map(seat => ({ reviewer: String.fromCharCode(65 + seat), opinion: opinion(seat) }));
    const merge = mergeOpinions(opinions, { report, sections });
    const quotes = [real(ids[0]!, '2', '2.5', '10'), real(ids[1]!, '4', '5', '15'), real(ids[2]!, '2', '2.1875', '10'), real('s', '4', '5', '20')];
    const snapshotBytes = Buffer.byteLength(JSON.stringify(report)) + 2_000;
    const estimate = estimateReview({ quotes: quotes as never, reviewers: ids, summary: 's', maxRounds: 1, maxBudgetUsd: '5', creditsPerUsd: '100',
      opinionTokens: 8192, summaryTokens: 32768, instructionBytes: { reviewer: 9_000, summary: 9_000 }, fieldCount: 14, snapshotBytes });
    const limit = estimate.requestBytes.summary;
    const build = (level: number) => summaryRequestMerged(skill, context, merge, opinions, declared, current, level);
    // Untrimmed, the three 8192-token opinions do not fit: the request really is cut down.
    expect(fusionRequestBytes(build(0))).toBeGreaterThan(limit);
    const sent = fitted(build, limit);
    expect(fusionRequestBytes(sent)).toBeLessThanOrEqual(limit);
    // Its worst-case cost (what the provider bound makes of the bytes actually sent) is within the summary's frozen hold.
    const hold = estimate.callCaps.summary.s!;
    const actual = openRouterCallBound(quotes[3]!.providerLimits, 32768, fusionRequestBytes(sent) + 4096 + 4096).upperUsd;
    expect(Number(actual)).toBeLessThanOrEqual(Number(hold.usd));
    // Only opinions were pressed: the whole report, every chapter and every declared field are still in what the summary reads.
    const input = JSON.parse(sent.input);
    expect(input.report).toContain('第12章');
    for (const name of sections) expect(input.report).toContain(name);
    expect(input.sections).toEqual(sections);
    expect(input.steps[0].fields).toHaveLength(14);
    expect(input.steps[0].fields.every((f: { currentValue: string }) => f.currentValue.length === 400)).toBe(true);
    const severities = input.issues.map((issue: { severity: string }) => issue.severity);
    expect(severities).toContain('critical');
    expect(severities).toContain('major');
  });

  it('stays bounded when the opinions hold many severe issues that cannot be merged (every issue has one view, kept at every level up to 3)', () => {
    const skill = { reviewer: 'r', summary: 's', rubric: 'b' };
    const context = { report, materials: [], sections, maxCharacters: 12000 };
    const omission = (seat: number) => parseOpinion(JSON.stringify({
      decisions: DECISIONS.map(decision => ({ decision, strongestCase: text('理由', 1500), strongestAlternative: text('替代', 1500), verdict: 'change', basis: text('依据', 1500) })),
      issues: Array.from({ length: 8 }, (_, i) => ({ location: sections[i], perspective: `视角${seat}`, severity: 'major', kind: 'omission', quote: '',
        anchor: sections[i], problem: text(`缺失${seat}-${i}`, 1900), suggestion: text(`补充${seat}-${i}`, 1900) })),
    }), { sections, report })!;
    const opinions = [0, 1, 2].map(seat => ({ reviewer: String.fromCharCode(65 + seat), opinion: omission(seat) }));
    const merge = mergeOpinions(opinions, { report, sections });
    expect(merge.issues).toHaveLength(24);
    // A small frozen size (no declared fields, a short report): what the deepest of the former levels still left too large.
    const limit = 94_543;
    const build = (level: number) => summaryRequestMerged(skill, { ...context, report: sections.map(name => `## ${name}\n短`).join('\n') }, merge, opinions, [], {}, level);
    expect(fusionRequestBytes(build(3))).toBeGreaterThan(limit);
    const sent = fitted(build, limit);
    expect(fusionRequestBytes(sent)).toBeLessThanOrEqual(limit);
    const input = JSON.parse(sent.input);
    // All 24 severe issues are still handed over, each with its chapter, severity and a shortened text.
    expect(input.issues).toHaveLength(24);
    expect(input.issues.every((issue: { severity: string; section: string }) => issue.severity === 'major' && sections.includes(issue.section))).toBe(true);
    expect(input.note).toContain('已被缩短');
  });
});
