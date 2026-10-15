/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { confirmedInformationMarkdown as markdown, informationExportIdentity as identity, EXPORT_CHANGED } from './information-export';

export function exportFixture(count = 3) {
  const steps = Array.from({ length: count }, (_, i) => ({ id: `s${i}`, title: `步骤${i + 1}` }));
  return { draftId: 'draft', projectId: 'project', roundId: 'round', sessionId: 'session',
    snapshot: { state: 'draft', workflow: { steps }, steps: Object.fromEntries(steps.map(s =>
      [s.id, { version: 1, reviewVersion: 0, valid: false }])) },
    information: Object.fromEntries(steps.map((s, i) => [s.id, { schema: [{ id: 'answer', title: '已确认答案' },
      { id: 'pending', title: '未确认' }], values: {
      answer: { value: `中文资料${i}`, status: 'confirmed', nature: ['fact', 'hypothesis', 'decision'][i % 3] },
      pending: { value: '不能导出的建议', status: 'provisional', nature: 'hypothesis' },
    }, meta: { answer: { suggestion: { value: '不可导出建议', executionId: 'internal' } } },
    notes: ['内部整理注释'], previouslyConfirmed: ['pending'] }])) };
}

describe('confirmed information export', () => {
  for (const count of [0, 1, 3, 9, 24]) it(`supports ${count} workflow steps without report or membership`, () => {
    const data = exportFixture(count);
    const result = markdown(data, 'draft', identity(data, 'draft'));
    if (!count) expect(result).toBeNull();
    else {
      expect(result?.match(/^## /gm)).toHaveLength(count);
      expect(result).toContain(`中文资料${count - 1}`);
      expect(result).not.toMatch(/不能导出|不可导出|内部|internal|project|session/);
    }
  });
  it('exports partial confirmations and preserves nature without including unknown schema keys', () => {
    const data = exportFixture();
    data.information.s1!.values.answer.status = 'provisional';
    Object.assign(data.information.s0!.values, { internal: { value: '隐藏值', status: 'confirmed', nature: 'fact' } });
    const result = markdown(data, 'draft', identity(data, 'draft'));
    expect(result).toContain('性质：事实');
    expect(result).toContain('性质：决定');
    expect(result).not.toMatch(/中文资料1|隐藏值/);
    expect(markdown(exportFixture(), 'draft', identity(exportFixture(), 'draft'))).toContain('性质：假设');
  });
  it.each(['unknown', 'unclear', 'provisional', 'deferred'])('excludes %s even when previously confirmed', status => {
    const data = exportFixture(1);
    data.information.s0!.values.answer.status = status;
    expect(markdown(data, 'draft', identity(data, 'draft'))).toBeNull();
  });
  it('encodes active Markdown and HTML as literal text, preserving Chinese and multiline values', () => {
    const data = exportFixture(1);
    data.information.s0!.values.answer.value = '中文\r\n<script>alert(1)</script>\n![图片](https://x)\n```\n# 伪标题';
    const result = markdown(data, 'draft', identity(data, 'draft'))!;
    expect(result).toContain('> 中文\n> &#60;script&#62;');
    expect(result).not.toMatch(/<script>|!\[|```|\n# 伪标题/);
  });
  it.each(['draftId', 'projectId', 'roundId', 'sessionId'] as const)('rejects changed %s', key => {
    const data = exportFixture();
    const expected = identity(data, 'draft');
    data[key] = 'changed';
    expect(() => markdown(data, 'draft', expected)).toThrow(EXPORT_CHANGED);
  });
  it('rejects version, workflow and confirmation changes rather than exporting cached values', () => {
    for (const change of [(d: ReturnType<typeof exportFixture>) => { d.snapshot.steps.s0!.version++; },
      (d: ReturnType<typeof exportFixture>) => { d.snapshot.steps.s0!.valid = true; },
      (d: ReturnType<typeof exportFixture>) => { d.snapshot.workflow.steps.reverse(); },
      (d: ReturnType<typeof exportFixture>) => { d.information.s0!.values.answer.value = '新版'; }]) {
      const data = exportFixture(), expected = identity(data, 'draft');
      change(data);
      expect(() => markdown(data, 'draft', expected)).toThrow(EXPORT_CHANGED);
    }
  });
  it('fails closed for incomplete reads', () => {
    expect(() => identity({}, 'draft')).toThrow();
    const data = exportFixture();
    delete data.snapshot.steps.s0;
    expect(() => identity(data, 'draft')).toThrow();
  });
});

describe('read-only draft after its conversation is deleted (Owner 2026-10-14)', () => {
  it('shows and exports the same confirmed-only list, never unconfirmed or conversation text', async () => {
    const { confirmedSections } = await import('./information-export');
    const data = { ...exportFixture(2), conversationDeleted: true };
    const sections = confirmedSections(data, 'draft');
    expect(sections.map(section => section.fields.map(field => field.value))).toEqual([['中文资料0'], ['中文资料1']]);
    const text = JSON.stringify(sections);
    expect(text).not.toMatch(/不能导出|不可导出|内部|internal/);
    const exported = markdown(data, 'draft', identity(data, 'draft'));
    for (const section of sections) for (const field of section.fields) expect(exported).toContain(field.value);
    expect(exported).not.toMatch(/不能导出|不可导出|内部|internal/);
  });

  it('keeps the body of a confirmed step whose fields were not confirmed; the normal export is unchanged', async () => {
    const { confirmedSections } = await import('./information-export');
    const base = exportFixture(1);
    const data = { ...base, information: { s0: { schema: base.information.s0.schema, values: {} } },
      snapshot: { ...base.snapshot, steps: { s0: { version: 2, reviewVersion: 0, valid: true, body: '已确认的步骤结论' } } } };
    expect(confirmedSections({ ...data, conversationDeleted: true }, 'draft'))
      .toEqual([{ title: '步骤1', fields: [{ title: '本步结论', value: '已确认的步骤结论', nature: '已确认' }] }]);
    const readonly = { ...data, conversationDeleted: true };
    expect(markdown(readonly, 'draft', identity(readonly, 'draft'))).toContain('已确认的步骤结论');
    expect(confirmedSections(data, 'draft')).toEqual([]);
  });
});
