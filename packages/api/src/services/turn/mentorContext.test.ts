/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { openingOrganizerOutput } from './mentorContext';

// Owner 2026-11-27 pay2 (turn 6874, step-2 opening): the organizer's own output. It carries the two step-2 drafts but no
// inputKind, and turn_close refused the whole output as invalid_output, so the checklist kept both fields empty.
const PAY2_OPENING = {
  format: 'v2',
  patches: [
    { stepId: 'step-2', fieldId: 'feasibility', value: '初步判断可行但有难度：已有家中工作台、两三位愿意试课的朋友，每周可投入4小时；'
      + '尚未正式开课，定价、时长、材料成本及本地付费需求未验证。建议先小范围试课再扩大。',
      status: 'provisional', nature: 'decision', basis: 'agent_proposal' },
    { stepId: 'step-2', fieldId: 'platform_choice', value: '初步建议从小红书开始，发布手工皮具制作过程和本地体验类内容；依据是平台搜索、收藏习惯的经验判断，尚无实测数据。',
      status: 'provisional', nature: 'decision', basis: 'agent_proposal' },
  ],
  notes: [],
};
// turn_close's output check (0434): inputKind is one of these, and patches and notes are arrays.
const INPUT_KINDS = ['answer', 'acknowledgement', 'uncertainty', 'request', 'revision_request'];
const accepted = (output: unknown) => {
  const o = output as { inputKind?: unknown; patches?: unknown; notes?: unknown };
  return INPUT_KINDS.includes(String(o.inputKind ?? '')) && Array.isArray(o.patches) && Array.isArray(o.notes);
};

describe('an opening organizer output without inputKind (pay2 turn 6874)', () => {
  it('reaches turn_close as an acknowledgement with every patch unchanged', () => {
    expect(accepted(PAY2_OPENING)).toBe(false);
    const output = openingOrganizerOutput(PAY2_OPENING) as typeof PAY2_OPENING & { inputKind: string };
    expect(accepted(output)).toBe(true);
    expect(output.inputKind).toBe('acknowledgement');
    expect(output.patches).toEqual(PAY2_OPENING.patches);
  });
  it('leaves an output that names its inputKind, and anything not an object, as it is', () => {
    const named = { inputKind: 'uncertainty', patches: [], notes: [] };
    expect(openingOrganizerOutput(named)).toBe(named);
    expect(openingOrganizerOutput({ inputKind: 'bogus', patches: [], notes: [] })).toEqual({ inputKind: 'bogus', patches: [], notes: [] });
    expect(openingOrganizerOutput(null)).toBeNull();
    expect(openingOrganizerOutput([1])).toEqual([1]);
  });
});
