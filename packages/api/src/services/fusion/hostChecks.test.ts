/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { checkRevision, DECISIONS, hasDisagreement, parseOpinion, reportSections, type RevisionInput } from './hostChecks';

const sections = ['定位', '受众', '结语'];
const report = (a = '原定位', b = '原受众', c = '原结语') => `## 定位\n${a}\n## 受众\n${b}\n## 结语\n${c}`;
const base: RevisionInput = {
  previousBody: report(), previousSteps: { s1: { goal: '旧目标', note: '' }, s2: { who: '学生' } },
  frozenSteps: { s1: { goal: '旧目标', note: '' }, s2: { who: '学生' } },
  declared: [{ stepId: 's1', fieldIds: ['goal', 'note'] }, { stepId: 's2', fieldIds: ['who'] }], sections, maxCharacters: 12000,
};
const revision = (patch: Partial<{ body: string; steps: unknown; changeNotes: unknown }> = {}) => JSON.stringify({
  adjudication: [{ section: '定位', issue: '定位太泛', reviewers: ['A', 'B'], single: false, disputed: false, adopted: true,
    opinion: '定位要写清人群', reason: '原文确实没写清', fix: '点明给上班族省时间' }],
  body: report('新定位'),
  steps: [{ stepId: 's1', fields: [{ fieldId: 'goal', value: '新目标', changed: true }, { fieldId: 'note', value: '', changed: false }] },
    { stepId: 's2', fields: [{ fieldId: 'who', value: '学生', changed: false }] }],
  changeNotes: [{ section: '定位', wordingOnly: false, note: '目标更具体', fields: [{ stepId: 's1', fieldId: 'goal' }] }],
  ...patch,
});

const decisions = (verdict: 'keep' | 'change' = 'keep') => DECISIONS.map(decision => ({ decision,
  strongestCase: '原方案最强的理由', strongestAlternative: '最强的替代方案', verdict, basis: '依据' }));
const issue = { location: '定位', perspective: '目标受众：上班族', problem: '定位只写了"分享生活"，上班族看不出能得到什么具体好处',
  suggestion: '改成"下班 30 分钟做出一顿饭"，直接点明给上班族省时间这个好处', severity: 'critical' as const };
const rules = { sections };

describe('review opinions', () => {
  it('parses plain, fenced and embedded JSON; refuses malformed, out-of-schema or incomplete steelman output', () => {
    const opinion = { decisions: decisions(), issues: [issue] };
    expect(parseOpinion(JSON.stringify(opinion), rules)).toEqual({ ...opinion, dropped: 0 });
    expect(parseOpinion('意见如下：\n```json\n' + JSON.stringify(opinion) + '\n```', rules)).toEqual({ ...opinion, dropped: 0 });
    expect(parseOpinion('前言 ' + JSON.stringify({ decisions: decisions(), issues: [] }) + ' 结尾', rules)?.issues).toEqual([]);
    expect(parseOpinion('not json', rules)).toBeNull();
    expect(parseOpinion(JSON.stringify({ ...opinion, issues: [{ ...issue, severity: 'blocker' }] }), rules)).toBeNull();
    // Every key decision steelmanned exactly once.
    expect(parseOpinion(JSON.stringify({ ...opinion, decisions: decisions().slice(1) }), rules)).toBeNull();
    expect(parseOpinion(JSON.stringify({ ...opinion, decisions: [...decisions().slice(1), decisions()[1]] }), rules)).toBeNull();
    // A debate answer must respond to someone.
    expect(parseOpinion(JSON.stringify(opinion), { sections, debate: true })).toBeNull();
    const debate = { ...opinion, responses: [{ reviewer: 'B', decision: 'audience', strongestView: 'B 认为受众应该更窄', stance: 'disagree', reason: '理由' }] };
    expect(parseOpinion(JSON.stringify(debate), { sections, debate: true })?.responses).toHaveLength(1);
  });

  it('requires a debate answer to cover exactly the expected reviewer and decision pairs', () => {
    const response = (reviewer: string, decision: string) => ({ reviewer, decision, strongestView: '最强观点', stance: 'agree', reason: '理由' });
    const expected = [{ reviewer: 'A', decision: 'audience' }, { reviewer: 'C', decision: 'audience' }];
    const answer = (responses: unknown[]) => parseOpinion(JSON.stringify({ decisions: decisions(), issues: [], responses }),
      { sections, debate: true, responses: expected });
    expect(answer([response('A', 'audience'), response('C', 'audience')])).not.toBeNull();
    expect(answer([response('A', 'audience')])).toBeNull();
    expect(answer([response('A', 'audience'), response('A', 'audience')])).toBeNull();
    expect(answer([response('A', 'audience'), response('B', 'audience')])).toBeNull();
    expect(answer([response('A', 'audience'), response('C', 'audience'), response('C', 'platform')])).toBeNull();
  });

  it('drops vague issues one by one and keeps the opinion', () => {
    const vague = [{ ...issue, location: '第三部分' }, { ...issue, problem: '太泛了' }, { ...issue, suggestion: '优化一下' },
      { ...issue, suggestion: issue.problem + '。' }];
    const parsed = parseOpinion(JSON.stringify({ decisions: decisions(), issues: [...vague, { ...issue, location: '## 受众' }] }), rules);
    expect(parsed?.dropped).toBe(4);
    expect(parsed?.issues).toHaveLength(1);
  });

  it('detects a split over a key decision', () => {
    const keep = parseOpinion(JSON.stringify({ decisions: decisions('keep'), issues: [] }), rules)!;
    const change = parseOpinion(JSON.stringify({ decisions: decisions('change'), issues: [] }), rules)!;
    expect(hasDisagreement([keep, keep])).toBe(false);
    expect(hasDisagreement([keep, change])).toBe(true);
  });
});

describe('revision host check', () => {
  it('accepts a complete, consistent revision and returns the R14 field changes', () => {
    const result = checkRevision(revision(), base);
    expect(result).toMatchObject({ ok: true, changedSections: ['定位'], r14Fields: { s1: { goal: '新目标' } } });
  });
  it('fails a revision that drops a section, or exceeds the length', () => {
    expect(checkRevision(revision({ body: '## 定位\n新定位\n## 受众\n原受众' }), base)).toEqual({ ok: false, reason: 'REVISION_SECTIONS' });
    expect(checkRevision(revision(), { ...base, maxCharacters: 10 })).toEqual({ ok: false, reason: 'REVISION_SECTIONS' });
  });
  it('fails a missing, extra or duplicated step or field (same field id in two steps is distinct)', () => {
    const missing = revision({ steps: [{ stepId: 's1', fields: [{ fieldId: 'goal', value: '新目标', changed: true }, { fieldId: 'note', value: '', changed: false }] }] });
    expect(checkRevision(missing, base).ok).toBe(false);
    const extra = JSON.parse(revision()); extra.steps[1].fields.push({ fieldId: 'goal', value: 'x', changed: true });
    expect(checkRevision(JSON.stringify(extra), base).ok).toBe(false);
    const both = { ...base, declared: [{ stepId: 's1', fieldIds: ['goal', 'note'] }, { stepId: 's2', fieldIds: ['who', 'goal'] }],
      previousSteps: { ...base.previousSteps, s2: { who: '学生', goal: '学生目标' } } };
    const sameId = JSON.parse(revision()); sameId.steps[1].fields.push({ fieldId: 'goal', value: '学生目标', changed: false });
    expect(checkRevision(JSON.stringify(sameId), both).ok).toBe(true);
  });
  it('enforces changed=false as identical and changed=true as a new non-empty value within 400 characters', () => {
    const lie = JSON.parse(revision()); lie.steps[1].fields[0] = { fieldId: 'who', value: '白领', changed: false };
    expect(checkRevision(JSON.stringify(lie), base)).toEqual({ ok: false, reason: 'REVISION_UNCHANGED' });
    const empty = JSON.parse(revision()); empty.steps[0].fields[0] = { fieldId: 'goal', value: '', changed: true };
    expect(checkRevision(JSON.stringify(empty), base)).toEqual({ ok: false, reason: 'REVISION_CHANGED' });
    const long = JSON.parse(revision()); long.steps[0].fields[0] = { fieldId: 'goal', value: '长'.repeat(401), changed: true };
    expect(checkRevision(JSON.stringify(long), base)).toEqual({ ok: false, reason: 'REVISION_CHANGED' });
  });
  it('keeps an optional empty field empty without inventing a value', () => {
    expect(checkRevision(revision(), base).ok).toBe(true);
  });
  it('requires every changed section and changed field to be declared consistently', () => {
    expect(checkRevision(revision({ changeNotes: [] }), base)).toEqual({ ok: false, reason: 'REVISION_NOTES' });
    expect(checkRevision(revision({ changeNotes: [{ section: '受众', wordingOnly: true, note: '', fields: [] }] }), base))
      .toEqual({ ok: false, reason: 'REVISION_NOTES' });
    expect(checkRevision(revision({ changeNotes: [{ section: '定位', wordingOnly: true, note: '', fields: [] }] }), base))
      .toEqual({ ok: false, reason: 'REVISION_NOTES' });
    const wording = JSON.parse(revision());
    wording.steps[0].fields[0] = { fieldId: 'goal', value: '旧目标', changed: false };
    wording.changeNotes = [{ section: '定位', wordingOnly: true, note: '只改措辞', fields: [] }];
    expect(checkRevision(JSON.stringify(wording), base)).toMatchObject({ ok: true, r14Fields: {} });
  });
  it('round 2 bases changed on the previous revision while R14 still sees the round-1 change', () => {
    const round2: RevisionInput = { ...base, previousBody: report('新定位'), previousSteps: { s1: { goal: '新目标', note: '' }, s2: { who: '学生' } } };
    const keep = JSON.parse(revision({ body: report('新定位', '新受众') }));
    keep.steps[0].fields[0] = { fieldId: 'goal', value: '新目标', changed: false };
    keep.steps[1].fields[0] = { fieldId: 'who', value: '大学生', changed: true };
    keep.changeNotes = [{ section: '受众', wordingOnly: false, note: '人群更准', fields: [{ stepId: 's2', fieldId: 'who' }] }];
    expect(checkRevision(JSON.stringify(keep), round2)).toMatchObject({ ok: true,
      r14Fields: { s1: { goal: '新目标' }, s2: { who: '大学生' } } });
  });
  it('splits sections by "## " headings only', () => {
    expect(reportSections(report(), sections, 12000)?.get('受众')).toBe('原受众');
    expect(reportSections('## 定位\n\n## 受众\nx\n## 结语\ny', sections, 12000)).toBeNull();
  });

  it('files every ruling under a template section (or 全文) and names only seats A/B/C', () => {
    const ruling = { section: '定位', issue: 'i', reviewers: ['A'], single: true, disputed: false, adopted: true, opinion: 'o', reason: 'r', fix: 'f' };
    const withRulings = (adjudication: unknown[]) => JSON.stringify({ ...JSON.parse(revision()), adjudication });
    expect(checkRevision(withRulings([ruling, { ...ruling, section: '## 受众' }, { ...ruling, section: '全文' }]), base).ok).toBe(true);
    expect(checkRevision(withRulings([{ ...ruling, section: '第九章' }]), base)).toEqual({ ok: false, reason: 'REVISION_ADJUDICATION' });
    expect(checkRevision(withRulings([{ ...ruling, reviewers: ['Claude'] }]), base)).toEqual({ ok: false, reason: 'REVISION_ADJUDICATION' });
  });

  it('refuses a revision that changes the text before the first heading', () => {
    const withPreamble = { ...base, previousBody: '前言\n' + report() };
    expect(checkRevision(revision({ body: '改过的前言\n' + report('新定位') }), withPreamble)).toEqual({ ok: false, reason: 'REVISION_PREAMBLE' });
    expect(checkRevision(revision({ body: '前言\n' + report('新定位') }), withPreamble).ok).toBe(true);
  });

  it('counts a spacing-only change in a section as a change that must be declared', () => {
    const spaced = revision({ body: report('新定位', '原受众\n') });
    expect(checkRevision(spaced, base)).toEqual({ ok: false, reason: 'REVISION_NOTES' });
  });
});

it('REPORT-VISUAL: checks the sections and the limit on the report text, leaving the strategy data block out', async () => {
  const { reportSections } = await import('./hostChecks');
  const block = '```graylum-report-data\n' + JSON.stringify({ v: 1, field: 'summary', value: '数'.repeat(200) }) + '\n```';
  const sections = reportSections('## 定位\n原定位\n## 结语\n原结语\n\n' + block, ['定位', '结语'], 30);
  expect(sections && [...sections.values()].map(value => value.trim())).toEqual(['原定位', '原结语']);
});
