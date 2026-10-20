/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { DECISIONS, parseOpinion } from './hostChecks';
import { evidenceOf, quotesOverlap } from './reviewEvidence';
import { mergeOpinions } from './reviewMerge';
import { adminEvidence } from './reviewEvidenceFlow';
import { debateRequest, reviewerRequest, ROLE_BLOCKS } from './reviewPrompts';

const sections = ['定位', '受众', '变现'];
const report = '## 定位\n我想做一个分享生活的账号，每天更新一条视频。\n## 受众\n主要是 25 到 35 岁的上班族女性。\n## 变现\n先涨粉，后面接广告。';
const decisions = DECISIONS.map(decision => ({ decision, strongestCase: '原方案最强的理由', strongestAlternative: '最强的替代方案', verdict: 'keep', basis: '依据' }));
const base = { location: '定位', perspective: '算账', problem: '这个说法没有写清楚具体怎么赚钱，每月的收入和成本都没有数字，账算不过来', suggestion: '补上每月预计收入和每月成本的对照表，让账能算得过来', severity: 'critical',
  kind: 'content', quote: '', anchor: '' };
const raw = (...issues: Array<Record<string, unknown>>) => JSON.stringify({ decisions, issues });
const parse = (...issues: Array<Record<string, unknown>>) => parseOpinion(raw(...issues), { sections, report })!;

describe('evidence of a review issue', () => {
  it('a critical issue is kept only with a quote that is really in the report (whitespace and markdown marks do not count)', () => {
    expect(parse({ ...base, quote: '我想做一个分享生活的账号' }).issues).toHaveLength(1);
    expect(parse({ ...base, quote: '我想做一个**分享生活**的账号' }).issues).toHaveLength(1);
    const noQuote = parse({ ...base });
    expect(noQuote.issues).toEqual([]);
    expect(noQuote.droppedBy).toEqual({ missing_quote: 1, quote_not_in_report: 0, anchor_missing: 0 });
    const invented = parse({ ...base, quote: '每天更新三条视频并且开直播' });
    expect(invented.issues).toEqual([]);
    expect(invented.droppedBy).toEqual({ missing_quote: 0, quote_not_in_report: 1, anchor_missing: 0 });
  });
  it('a severe omission keeps with an anchor that is a real chapter, and drops when the chapter does not exist', () => {
    const kept = parse({ ...base, kind: 'omission', anchor: '变现' });
    expect(kept.issues).toHaveLength(1);
    expect(kept.issues[0]!.evidence).toBe('anchored');
    const lost = parse({ ...base, kind: 'omission', anchor: '不存在的章节' });
    expect(lost.issues).toEqual([]);
    expect(lost.droppedBy).toEqual({ missing_quote: 0, quote_not_in_report: 0, anchor_missing: 1 });
    expect(parse({ ...base, kind: 'omission', anchor: '## 变现' }).issues).toHaveLength(1);
  });
  it('a lighter issue without evidence is not dropped here (the merge decides: only the lone ones are held back)', () => {
    expect(parse({ ...base, severity: 'major' }).issues).toHaveLength(1);
  });
  it('a review started before the evidence check is parsed as before', () => {
    const plain = parseOpinion(raw({ ...base }), { sections })!;
    expect(plain.issues).toHaveLength(1);
    expect(plain.droppedBy).toBeUndefined();
  });
  it('evidenceOf: a quote shorter than the minimum never verifies', () => {
    expect(evidenceOf({ kind: 'content', quote: '账号' }, report, sections).evidence).toBe('unverified');
  });
  it('quotes of the same place overlap, different places do not', () => {
    expect(quotesOverlap('我想做一个分享生活的账号', '分享生活的账号，每天')).toBe(false);
    expect(quotesOverlap('我想做一个分享生活的账号，每天更新', '一个分享生活的账号，每天更新一条')).toBe(true);
    expect(quotesOverlap('先涨粉，后面接广告', '主要是 25 到 35 岁')).toBe(false);
  });
});

describe('merging round-1 issues by code', () => {
  const opinionOf = (...issues: Array<Record<string, unknown>>) => parse(...issues);
  const context = { report, sections };
  it('merges issues of one chapter whose verified quotes overlap, and records the seats that raised it', () => {
    const merged = mergeOpinions([
      { reviewer: 'A', opinion: opinionOf({ ...base, quote: '我想做一个分享生活的账号，每天更新一条视频' }) },
      { reviewer: 'B', opinion: opinionOf({ ...base, severity: 'major', quote: '分享生活的账号，每天更新一条视频。' }) },
    ], context);
    expect(merged.issues).toHaveLength(1);
    expect(merged.issues[0]).toMatchObject({ section: '定位', severity: 'critical', reviewers: ['A', 'B'], evidence: 'quoted' });
    expect(merged.issues[0]!.views).toHaveLength(2);
  });
  it('does not merge issues in different chapters or omissions, and orders by severity then chapter', () => {
    const merged = mergeOpinions([
      { reviewer: 'A', opinion: opinionOf({ ...base, severity: 'minor', location: '受众', quote: '25 到 35 岁的上班族女性' }, { ...base, kind: 'omission', anchor: '变现' }) },
      { reviewer: 'B', opinion: opinionOf({ ...base, kind: 'omission', anchor: '变现' }) },
    ], context);
    expect(merged.issues.map(issue => [issue.severity, issue.section, issue.kind])).toEqual([
      ['critical', '定位', 'omission'], ['critical', '定位', 'omission'], ['minor', '受众', 'content']]);
  });
  it('holds back an issue only one seat raised that has no checkable evidence, counted by reason', () => {
    const merged = mergeOpinions([
      { reviewer: 'A', opinion: opinionOf({ ...base, severity: 'major' }, { ...base, severity: 'major', quote: '根本不存在的一句话内容' }) },
      { reviewer: 'B', opinion: opinionOf({ ...base, severity: 'minor', quote: '先涨粉，后面接广告', location: '变现' }) },
    ], context);
    expect(merged.issues).toHaveLength(1);
    expect(merged.dropped.map(item => item.reason).sort()).toEqual(['missing_quote', 'quote_not_in_report']);
  });
  it('keeps a quote-less issue when another seat raised one of the same kind in the same chapter (corroborated)', () => {
    const merged = mergeOpinions([
      { reviewer: 'A', opinion: opinionOf({ ...base, severity: 'major' }) },
      { reviewer: 'B', opinion: opinionOf({ ...base, severity: 'minor' }) },
    ], context);
    expect(merged.issues).toHaveLength(2);
    expect(merged.dropped).toEqual([]);
  });
  it('counts the severe issues already dropped while each opinion was checked', () => {
    const merged = mergeOpinions([{ reviewer: 'A', opinion: opinionOf({ ...base }, { ...base, kind: 'omission', anchor: '没有' }) }], context);
    expect(merged.raised).toBe(2);
    expect(merged.issues).toEqual([]);
    expect(merged.droppedEarlier).toEqual({ missing_quote: 1, quote_not_in_report: 0, anchor_missing: 1 });
  });
});

describe('seat prompts', () => {
  it('the debate round keeps the seat angle and the quote rules', () => {
    const skill = { reviewer: '评审说明', summary: '汇总说明', rubric: '评分标准' };
    const request = debateRequest(skill, { report, materials: [], sections, maxCharacters: 12000, evidence: true }, null, [], [], 'finance');
    expect(request.instructions).toContain(ROLE_BLOCKS.finance);
    expect(request.instructions).toContain('anchor');
  });
  const skill = { reviewer: '评审说明', summary: '汇总说明', rubric: '评分标准' };
  const context = { report, materials: [], sections, maxCharacters: 12000 };
  it('a seat with an angle gets its own block; one without it keeps the plain prompt', () => {
    expect(reviewerRequest(skill, context, 'finance').instructions).toContain(ROLE_BLOCKS.finance);
    expect(reviewerRequest(skill, context, 'execution').instructions).not.toContain(ROLE_BLOCKS.finance);
    expect(reviewerRequest(skill, context, null).instructions).not.toContain('专门任务');
  });
  it('a review with the evidence check asks for kind, quote and anchor; an older one does not', () => {
    expect(reviewerRequest(skill, { ...context, evidence: true }).instructions).toContain('anchor');
    expect(reviewerRequest(skill, context).instructions).not.toContain('anchor');
  });
});

describe('the administrator look-back', () => {
  it('adds what the host held back, by reason, and counts the thin rulings', () => {
    const A = '00000000-0000-4000-8000-0000000000a1';
    const opinionBody = JSON.stringify({ decisions, issues: [{ ...base }, { ...base, quote: '先涨粉，后面接广告', location: '变现', severity: 'major' }] });
    const summary = '```json\n' + JSON.stringify({ adjudication: [{ reason: '没有依据' }, { reason: '原文把变现放在涨粉之后，没有给出每月收入和成本，按算账角度这一章的商业理由站不住，必须补数字' }] }) + '\n```';
    const result = adminEvidence({ config: { evidence: true, reviewers: [A] }, steps: [{ round: 1, groupId: 'g1' }, { round: 1, groupId: 'g2' }],
      calls: [{ callId: 'c1', phase: 'fusion_review', modelId: A, groupId: 'g1', verdict: 'usable' },
        { callId: 'c2', phase: 'fusion_summary', groupId: 'g2', verdict: 'usable' }],
      outputs: [{ callId: 'c1', body: opinionBody }, { callId: 'c2', body: summary }] }, { body: report, sections });
    expect(result.evidence).toMatchObject({ checked: true, raised: 2, handedOver: 1, dropped: { missingQuote: 1, quoteNotInReport: 0, anchorMissing: 0 } });
    expect(result.thinReasonRulings).toBe(1);
  });
  it('a review started before the evidence check is returned as it is, marked unchecked', () => {
    expect(adminEvidence({ config: {}, calls: [], outputs: [] }, { body: report, sections }).evidence).toEqual({ checked: false });
  });
});
