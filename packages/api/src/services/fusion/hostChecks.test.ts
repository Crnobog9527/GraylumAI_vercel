/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { checkRevision, hasCritical, parseOpinion, reportSections, type RevisionInput } from './hostChecks';

const sections = ['定位', '受众', '结语'];
const report = (a = '原定位', b = '原受众', c = '原结语') => `## 定位\n${a}\n## 受众\n${b}\n## 结语\n${c}`;
const base: RevisionInput = {
  previousBody: report(), previousSteps: { s1: { goal: '旧目标', note: '' }, s2: { who: '学生' } },
  frozenSteps: { s1: { goal: '旧目标', note: '' }, s2: { who: '学生' } },
  declared: [{ stepId: 's1', fieldIds: ['goal', 'note'] }, { stepId: 's2', fieldIds: ['who'] }], sections, maxCharacters: 12000,
};
const revision = (patch: Partial<{ body: string; steps: unknown; changeNotes: unknown }> = {}) => JSON.stringify({
  body: report('新定位'),
  steps: [{ stepId: 's1', fields: [{ fieldId: 'goal', value: '新目标', changed: true }, { fieldId: 'note', value: '', changed: false }] },
    { stepId: 's2', fields: [{ fieldId: 'who', value: '学生', changed: false }] }],
  changeNotes: [{ section: '定位', wordingOnly: false, note: '目标更具体', fields: [{ stepId: 's1', fieldId: 'goal' }] }],
  ...patch,
});

describe('review opinions', () => {
  it('parses plain, fenced and embedded JSON; refuses malformed or out-of-schema output', () => {
    const opinion = { issues: [{ location: '定位', problem: '太泛', suggestion: '写清人群', severity: 'critical' as const }] };
    expect(parseOpinion(JSON.stringify(opinion))).toEqual(opinion);
    expect(parseOpinion('意见如下：\n```json\n' + JSON.stringify(opinion) + '\n```')).toEqual(opinion);
    expect(parseOpinion('前言 ' + JSON.stringify({ issues: [] }) + ' 结尾')).toEqual({ issues: [] });
    expect(parseOpinion('not json')).toBeNull();
    expect(parseOpinion(JSON.stringify({ issues: [{ ...opinion.issues[0], severity: 'blocker' }] }))).toBeNull();
    expect(hasCritical([opinion])).toBe(true);
    expect(hasCritical([{ issues: [] }])).toBe(false);
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
});
