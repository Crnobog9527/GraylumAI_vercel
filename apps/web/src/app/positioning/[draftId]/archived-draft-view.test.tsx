/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const queried: string[] = [];
const idle = { data: undefined, isLoading: false, error: null };
vi.mock('@/trpc/client', () => ({
  trpc: new Proxy({}, { get: (_, area) => new Proxy({}, { get: (_, procedure) => ({
    useQuery: (_input: unknown, options?: { enabled?: boolean }) => {
      if (options?.enabled !== false) queried.push(`${String(area)}.${String(procedure)}`);
      return idle;
    },
  }) }) }),
}));
vi.mock('@/components/opc/workspace-frame', () => ({ WorkspaceFrame: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('./report-export-button', () => ({ ReportExport: ({ saved }: { saved?: { body: string } }) =>
  <button data-saved={saved?.body}>导出报告</button> }));
vi.mock('./InformationExport', () => ({ InformationExport: () => <button>导出已确认资料</button> }));
vi.mock('@/components/chat-display/report-view/report-view', () => ({ ReportView: ({ body }: { body: string }) => <article>{body}</article> }));

const draft = {
  draftId: 'draft', projectId: 'project', roundId: 'round', sessionId: 'session',
  snapshot: { state: 'published', workflow: { steps: [{ id: 's', title: '了解你' }] }, steps: { s: { version: 1, reviewVersion: 0, valid: true } } },
  information: { s: { schema: [{ id: 'a', title: '目标' }], values: { a: { value: '涨粉到一万', status: 'confirmed' } } } },
  report: { available: true, id: 'v1', report: { generatedReport: { body: '# 定位报告正文' } } },
};

describe('read-only view of an archived profile', () => {
  it('shows confirmed content and the saved report with exports, and nothing that continues the work', async () => {
    const { ReadonlyDraftView } = await import('./readonly-draft-view');
    const html = renderToStaticMarkup(<ReadonlyDraftView draftId="draft" draft={draft} archived/>);
    expect(html).toContain('定位分析（已归档）');
    expect(html).toContain('这个定位档案已归档，只能查看和导出，不能继续对话或生成报告。');
    expect(html).toContain('涨粉到一万');
    expect(html).toContain('# 定位报告正文');
    expect(html).toContain('导出报告');
    expect(html).toContain('导出已确认资料');
    expect(html).not.toMatch(/这段定位对话已删除|整份删除|<textarea|发送|生成报告<\/button>|评审/);
    expect(html).toContain('data-saved="# 定位报告正文"');
    // Only the existing report reads: this round's generated report is looked up, nothing is started.
    expect(queried).toEqual(['runtime.reportLatest']);
  });

  it('keeps the deleted-conversation wording when not archived', async () => {
    const { ReadonlyDraftView } = await import('./readonly-draft-view');
    const html = renderToStaticMarkup(<ReadonlyDraftView draftId="draft" draft={{ ...draft, report: null }}/>);
    expect(html).toContain('这段定位对话已删除');
    expect(html).not.toContain('导出报告');
  });
});
