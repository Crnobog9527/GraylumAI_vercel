/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { exportFixture } from './information-export.test';

vi.mock('@/components/opc/workspace-frame', () => ({
  WorkspaceFrame: ({ children, activeWorkItemId }: { children: ReactNode; activeWorkItemId?: string }) =>
    <div data-active={activeWorkItemId}>{children}</div>,
}));
vi.mock('./InformationExport', () => ({ InformationExport: () => <button>导出已确认资料</button> }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));

describe('ReadonlyDraftView', () => {
  it('shows only confirmed content and export, with no way to talk or edit', async () => {
    const { ReadonlyDraftView } = await import('./readonly-draft-view');
    const html = renderToStaticMarkup(<ReadonlyDraftView draftId="draft" draft={{ ...exportFixture(2), conversationDeleted: true }}/>);
    expect(html).toContain('这段定位对话已删除');
    expect(html).toContain('中文资料0');
    expect(html).toContain('导出已确认资料');
    expect(html).not.toMatch(/不能导出|不可导出|内部|textarea|给导师的回复/);
    // Deleting the whole draft while it is open leaves the page (work = the draft's project).
    expect(html).toContain('data-active="project"');
  });

  it('says so when nothing was confirmed', async () => {
    const { ReadonlyDraftView } = await import('./readonly-draft-view');
    expect(renderToStaticMarkup(<ReadonlyDraftView draftId="draft" draft={{ ...exportFixture(0), conversationDeleted: true }}/>))
      .toContain('没有未发布的已确认内容');
  });
});
