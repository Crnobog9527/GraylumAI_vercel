/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));

import { MentorBudgetPanel } from './MentorBudgetSettings';
import { toBudgetDraft, type BudgetView } from './mentorBudgetDraft';
import { configuredView, legacyView } from './mentorBudgetFixtures';

function render(view: BudgetView, extra: { saveError?: string | null; saved?: boolean } = {}) {
  return renderToStaticMarkup(createElement(MentorBudgetPanel, {
    view,
    draft: toBudgetDraft(view),
    onChange: vi.fn(),
    onSave: vi.fn(),
    saving: false,
    saveError: extra.saveError ?? null,
    saved: extra.saved ?? false,
    onOpenSummaryLimit: vi.fn(),
  }));
}

describe('MentorBudgetPanel', () => {
  it('marks an unconfigured budget as legacy, explains it and blocks saving empty fields', () => {
    const markup = render(legacyView);
    expect(markup).toContain('沿用默认');
    expect(markup).toContain('mentor-budget-legacy');
    expect(markup).toContain('输入上限 64000 字节，历史 100 条');
    expect(markup).toContain('还不能保存：8 项需要修改');
    expect(markup).toMatch(/data-testid="mentor-budget-save"[^>]*disabled/);
  });

  it('shows each cap, the read-only organize output and the reserved report note', () => {
    const markup = render(configuredView);
    expect(markup).toContain('已配置');
    expect(markup).not.toContain('mentor-budget-legacy');
    expect(markup).toContain('系统上限 90000 字节');
    expect(markup).toContain('系统上限 112000 字节');
    expect(markup).toContain('系统上限 3584 token');
    expect(markup).toContain('系统上限 1000 条');
    expect(markup).not.toContain('mentor-budget-organize-maxOutputTokens');
    expect(markup).toContain('2048 token');
    expect(markup).toContain('整理模型回复长度（v3_summary_max_tokens）');
    expect(markup).toContain('mentor-budget-open-summary-limit');
    expect(markup).toContain('报告生成尚未启用，此项预留');
    expect(markup).toContain('只影响之后新发起的对话，进行中的不受影响');
    expect(markup).not.toContain('字数（');
    expect(markup).not.toMatch(/data-testid="mentor-budget-save"[^>]*disabled/);
  });

  it('shows the server error and the saved confirmation', () => {
    expect(render(configuredView, { saveError: '服务端拒绝保存：交互对话 · 输入上限（字节）：不能超过 90000' }))
      .toContain('服务端拒绝保存：交互对话 · 输入上限（字节）：不能超过 90000');
    expect(render(configuredView, { saved: true })).toContain('已保存，并已重新读取服务端的配置。');
  });
});
