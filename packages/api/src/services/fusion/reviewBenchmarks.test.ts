/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { reviewCore, source } from './reviewCore';
import { BENCHMARK_NONE_RULE, BENCHMARK_RULE, BENCHMARK_UNKNOWN_RULE, benchmarkRule, debateRequest, reviewerRequest, summaryRequest,
  summaryRequestMerged } from './reviewPrompts';

const skill = { reviewer: 'R', summary: 'S', rubric: 'X' };
// A draft whose first benchmark attempt failed (links the user wrote, no data) and whose later attempt fetched three new accounts.
const OLD_LINKS = ['https://example.test/old-1', 'https://example.test/old-2', 'https://example.test/old-3'];
const materials = { positioning: { benchmarks: { value: `之前给过的对标链接：${OLD_LINKS.join(' ')}（没有取到资料）`, status: 'confirmed' } } };
const fetched = ['new-a', 'new-b', 'new-c'].map((account, i) => ({ platform: 'xiaohongshu', account,
  metrics: { followers: 1000 + i, medianViews: null, engagementRate: null, weeklyPosts: 2, capturedAt: '2026-11-03T08:40:00Z' } }));
const row = (over: object) => ({ body: '报告正文', sections: ['一', '二'], maxCharacters: 1000, declared: [], ...over });
const context = (src: ReturnType<typeof source.parse>) => ({ report: src.body, materials, sections: src.sections, maxCharacters: src.maxCharacters,
  adoptedBenchmarks: src.adoptedBenchmarks });
const inputOf = (request: { input: string }) => JSON.parse(request.input) as { adoptedBenchmarks: Array<{ account: string }> | null; materials: unknown };

describe('the benchmarks a review reads', () => {
  it('are only the report\'s adopted accounts with the host\'s numbers and fetch time, not the draft\'s earlier links', () => {
    const src = source.parse(row({ adoptedBenchmarks: fetched }));
    const reviewer = inputOf(reviewerRequest(skill, context(src), 'evidence'));
    expect(reviewer.adoptedBenchmarks!.map(a => a.account)).toEqual(['new-a', 'new-b', 'new-c']);
    expect(JSON.stringify(reviewer.adoptedBenchmarks)).not.toContain('old-');
    expect(JSON.stringify(reviewer.adoptedBenchmarks)).toContain('2026-11-03T08:40:00Z');
    // Stored with none adopted: an empty list. No stored list at all (an older report, or the function before 0494): null, not [].
    expect(inputOf(reviewerRequest(skill, context(source.parse(row({ adoptedBenchmarks: [] }))), 'evidence')).adoptedBenchmarks).toEqual([]);
    expect(inputOf(reviewerRequest(skill, context(source.parse(row({}))), 'evidence')).adoptedBenchmarks).toBeNull();
  });

  it('reach every request a review makes, and the rule says the materials\' links are not this report\'s benchmarks', () => {
    const src = source.parse(row({ adoptedBenchmarks: fetched }));
    const ctx = context(src);
    const requests = [reviewerRequest(skill, ctx), debateRequest(skill, ctx, null, [], []), summaryRequest(skill, ctx, [], [], {}),
      summaryRequestMerged(skill, ctx, { issues: [], dropped: [], raised: [], droppedEarlier: {} } as never, [], [], {})];
    for (const request of requests) expect(inputOf(request).adoptedBenchmarks!.map(a => a.account)).toEqual(['new-a', 'new-b', 'new-c']);
    expect(reviewerRequest(skill, ctx, 'evidence').instructions).toContain(BENCHMARK_RULE);
    expect(summaryRequest(skill, ctx, [], [], {}).instructions).toContain(BENCHMARK_RULE);
    expect(BENCHMARK_RULE).toContain('materials');
  });

  it('tells an unknown list from a confirmed empty one: only a list makes the list exclusive', () => {
    const unknown = context(source.parse(row({}))), none = context(source.parse(row({ adoptedBenchmarks: [] })));
    const listed = context(source.parse(row({ adoptedBenchmarks: fetched })));
    expect([benchmarkRule(null), benchmarkRule(undefined), benchmarkRule([]), benchmarkRule(fetched)])
      .toEqual([BENCHMARK_UNKNOWN_RULE, BENCHMARK_UNKNOWN_RULE, BENCHMARK_NONE_RULE, BENCHMARK_RULE]);
    // Unknown: the benchmarks are still checked against the report text and a gap is "待核实"; the exclusive rule is not applied.
    const merged = { issues: [], dropped: [], raised: [], droppedEarlier: {} } as never;
    for (const make of [(c: typeof unknown) => reviewerRequest(skill, c, 'evidence'), (c: typeof unknown) => debateRequest(skill, c, null, [], []),
      (c: typeof unknown) => summaryRequest(skill, c, [], [], {}), (c: typeof unknown) => summaryRequestMerged(skill, c, merged, [], [], {})]) {
      expect(make(unknown).instructions).toContain(BENCHMARK_UNKNOWN_RULE);
      expect(make(unknown).instructions).not.toContain(BENCHMARK_RULE);
      expect(make(unknown).instructions).toContain('待核实');
      expect(make(none).instructions).toContain(BENCHMARK_NONE_RULE);
      expect(make(none).instructions).not.toContain(BENCHMARK_UNKNOWN_RULE);
      expect(make(listed).instructions).toContain(BENCHMARK_RULE);
    }
  });

  it('an unreadable or foreign shape from the database is an empty list or a null metrics, never a failure', () => {
    expect(source.parse(row({ adoptedBenchmarks: 'x' })).adoptedBenchmarks).toBeNull();
    expect(source.parse(row({ adoptedBenchmarks: [{ platform: 'p', account: 'a', metrics: 'bad' }] })).adoptedBenchmarks![0]!.metrics).toBeNull();
    expect(reviewCore).toBeDefined();
  });
});
