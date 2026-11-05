/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillMenuView } from '../opc/composer-view';
import { memberOnlyNote, meetsMemberLevel, asRequiredLevel } from '@/lib/member-only';

describe('a member-only Skill is shown to everyone with its note', () => {
  it('the chat Skill menu lists it with the note instead of the usual hint, whatever the plan', () => {
    const html = renderToStaticMarkup(<SkillMenuView query="" hint="加载到本对话，不自动发送" skills={[
      { moduleId: 'coach', name: '运营复盘教练', requiredMemberLevel: 'pro', locked: true },
      { moduleId: 'plain', name: '写文章', requiredMemberLevel: null, locked: false },
    ]} />);
    expect(html).toContain('运营复盘教练');
    expect(html).toContain('会员专享 · Pro 和 Gold 可用');
    expect(html.match(/加载到本对话，不自动发送/g)).toHaveLength(1);
  });

  it('who is locked: free (or a plan not yet known) is, Pro and Gold are not', () => {
    expect(meetsMemberLevel('free', 'pro')).toBe(false);
    expect(meetsMemberLevel(undefined, 'pro')).toBe(false);
    expect(meetsMemberLevel('pro', 'pro')).toBe(true);
    expect(meetsMemberLevel('gold', 'pro')).toBe(true);
    expect(meetsMemberLevel('pro', 'gold')).toBe(false);
    expect(asRequiredLevel('pro') && memberOnlyNote('pro')).toBe('会员专享 · Pro 和 Gold 可用');
  });
});
