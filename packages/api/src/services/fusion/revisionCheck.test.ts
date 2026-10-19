/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { RevisionInput } from './hostChecks';
import { checkRevision } from './revisionCheck';

const sections = ['定位', '受众', '结语'];
// Odd spacing on purpose: unchanged sections must come back byte for byte.
const original = '前言\n## 定位\n原定位\n\n第二段  \n## 受众\n原受众\n## 结语\n原结语';
const base: RevisionInput = {
  previousBody: original, previousSteps: { s1: { goal: '旧目标', note: '' }, s2: { who: '学生' } },
  frozenSteps: { s1: { goal: '旧目标', note: '' }, s2: { who: '学生' } },
  declared: [{ stepId: 's1', fieldIds: ['goal', 'note'] }, { stepId: 's2', fieldIds: ['who'] }], sections, maxCharacters: 12000,
};
const ruling = { section: '定位', issue: '定位太泛', reviewers: ['A'], single: true, disputed: false, adopted: true,
  opinion: '写清人群', reason: '原文没写清', fix: '点明上班族' };
const out = (revisions: unknown[], fieldChanges: unknown[] = [], adjudication: unknown[] = [ruling]) =>
  JSON.stringify({ adjudication, revisions, fieldChanges });

describe('section revision (Owner 2026-10-20: the host builds the body)', () => {
  it('replaces two sections, keeps the third byte for byte, carries every unchanged field and derives the change notes', () => {
    const result = checkRevision(out([{ section: '定位', text: '新定位' }, { section: '结语', text: '新结语' }],
      [{ stepId: 's1', fieldId: 'goal', value: '新目标', sections: ['定位'] }]), base);
    expect(result).toMatchObject({ ok: true, changedSections: ['定位', '结语'],
      body: '前言\n## 定位\n新定位\n## 受众\n原受众\n## 结语\n新结语',
      steps: { s1: { goal: '新目标', note: '' }, s2: { who: '学生' } }, r14Fields: { s1: { goal: '新目标' } } });
    expect(result.ok && result.changeNotes).toEqual([
      { section: '定位', wordingOnly: false, note: '点明上班族', fields: [{ stepId: 's1', fieldId: 'goal' }] },
      { section: '结语', wordingOnly: true, note: '', fields: [] }]);
  });

  it('drops a repeated heading line, but refuses any other "## " line inside a section', () => {
    expect(checkRevision(out([{ section: '受众', text: '## 受众\n新受众' }]), base)).toMatchObject({ ok: true,
      body: '前言\n## 定位\n原定位\n\n第二段  \n## 受众\n新受众\n## 结语\n原结语' });
    expect(checkRevision(out([{ section: '受众', text: '新受众\n## 小结\n其他' }]), base)).toMatchObject({ ok: false, reason: 'REVISION_SECTIONS' });
  });

  it('refuses an unknown or repeated section, and an empty replacement', () => {
    expect(checkRevision(out([{ section: '第九章', text: 'x' }]), base)).toEqual({ ok: false, reason: 'REVISION_SECTIONS',
      detail: '「第九章」不是给出的章节标题' });
    expect(checkRevision(out([{ section: '定位', text: 'a' }, { section: '## 定位', text: 'b' }]), base))
      .toEqual({ ok: false, reason: 'REVISION_SECTIONS', detail: '章节「定位」重复出现' });
    expect(checkRevision(out([{ section: '定位', text: '   ' }]), base)).toMatchObject({ ok: false, reason: 'REVISION_SECTIONS' });
  });

  it('refuses a body over the limit and says by how much (the retry hint)', () => {
    const result = checkRevision(out([{ section: '定位', text: '长'.repeat(200) }]), { ...base, maxCharacters: 150 });
    expect(result).toMatchObject({ ok: false, reason: 'REVISION_SECTIONS' });
    expect(!result.ok && result.detail).toMatch(/^修订后全文 \d+ 字，超过上限 150 字（多 \d+ 字）/);
  });

  it('requires a field change to be real, declared once, and shown in a section that changed', () => {
    const goal = (value: string, s: string[] = ['定位']) => ({ stepId: 's1', fieldId: 'goal', value, sections: s });
    const changed = [{ section: '定位', text: '新定位' }];
    expect(checkRevision(out(changed, [goal('旧目标')]), base)).toMatchObject({ ok: false, reason: 'REVISION_CHANGED' });
    expect(checkRevision(out(changed, [goal('长'.repeat(401))]), base)).toMatchObject({ ok: false, reason: 'REVISION_CHANGED' });
    expect(checkRevision(out(changed, [goal('新'), goal('新的')]), base)).toMatchObject({ ok: false, reason: 'REVISION_FIELDS' });
    expect(checkRevision(out(changed, [{ ...goal('新'), fieldId: 'x' }]), base)).toMatchObject({ ok: false, reason: 'REVISION_FIELDS' });
    expect(checkRevision(out(changed, [goal('新', ['受众'])]), base)).toMatchObject({ ok: false, reason: 'REVISION_NOTES' });
    expect(checkRevision(out(changed, [goal('新', [])]), base)).toMatchObject({ ok: false, reason: 'REVISION_NOTES' });
  });

  it('a replacement identical to the original is no change; no revisions at all passes with nothing changed', () => {
    expect(checkRevision(out([{ section: '受众', text: '原受众' }]), base)).toMatchObject({ ok: true, changedSections: [] });
    expect(checkRevision(out([], [], []), base)).toMatchObject({ ok: true, changedSections: [], changeNotes: [], r14Fields: {},
      body: original });
  });

  it('refuses a cut-off answer, rulings outside the template or seats, and still judges an old full-body answer the old way', () => {
    expect(checkRevision(out([{ section: '定位', text: '新定位' }]).slice(0, -30), base)).toMatchObject({ ok: false });
    expect(checkRevision(out([], [], [{ ...ruling, reviewers: ['Claude'] }]), base)).toMatchObject({ ok: false, reason: 'REVISION_ADJUDICATION' });
    const legacy = JSON.stringify({ adjudication: [], body: original.replace('原受众', '新受众'),
      steps: [{ stepId: 's1', fields: [{ fieldId: 'goal', value: '旧目标', changed: false }, { fieldId: 'note', value: '', changed: false }] },
        { stepId: 's2', fields: [{ fieldId: 'who', value: '学生', changed: false }] }],
      changeNotes: [{ section: '受众', wordingOnly: true, note: '', fields: [] }] });
    expect(checkRevision(legacy, base)).toMatchObject({ ok: true, changedSections: ['受众'] });
  });

  it('works on the report text when the original carries a strategy data block', () => {
    const block = '```graylum-report-data\n{"v":1,"field":"summary","value":"数据"}\n```';
    const result = checkRevision(out([{ section: '定位', text: '新定位' }]), { ...base, previousBody: `${original}\n\n${block}` });
    expect(result).toMatchObject({ ok: true, changedSections: ['定位'] });
    expect(result.ok && result.body).not.toContain('graylum-report-data');
  });
});
