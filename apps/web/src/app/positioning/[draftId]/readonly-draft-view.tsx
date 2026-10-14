'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { InformationExport } from './InformationExport';
import { confirmedSections } from './information-export';

/**
 * A positioning draft whose conversation was deleted (Owner 2026-10-14: "删除定位对话后，已确认的内容
 * 保留为只读，可以再整份删除。"). Only the confirmed content is shown, the same list the export writes;
 * there is no conversation, editing, confirming or report here. The whole draft is deleted from the
 * sidebar's "⋯" menu.
 */
export function ReadonlyDraftView({ draftId, draft }: { draftId: string; draft: unknown }) {
  let sections: ReturnType<typeof confirmedSections> = [];
  try { sections = confirmedSections(draft, draftId); } catch { sections = []; }
  // Deleting the whole draft (its work) from the sidebar while it is open leaves this page.
  const projectId = (draft as { projectId?: unknown } | null)?.projectId;
  return <WorkspaceFrame area="chat" activeWorkItemId={typeof projectId === 'string' ? projectId : undefined}>
    <main className="mx-auto w-full max-w-3xl space-y-5 overflow-y-auto p-4 text-[var(--text-primary)] sm:p-6">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold">定位分析（只读）</h1>
        <p role="status" className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-sm">
          这段定位对话已删除。下面是你已确认的内容，只能查看和导出，不能继续对话或修改。
          不需要时，可以在左侧列表这一项的「⋯」里整份删除。
        </p>
      </header>
      {sections.length ? sections.map(section => <section key={section.title} className="space-y-3">
        <h2 className="text-base font-semibold">{section.title}</h2>
        <dl className="space-y-3">
          {section.fields.map(field => <div key={field.title}
            className="rounded-lg border border-[var(--border-primary)] p-3">
            <dt className="text-sm font-medium">{field.title}
              <span className="ml-2 text-xs text-[var(--text-secondary)]">{field.nature}</span></dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-sm">{field.value}</dd>
          </div>)}
        </dl>
      </section>) : <p className="text-sm text-[var(--text-secondary)]">
        这里没有未发布的已确认内容。如果这份定位有已发布的版本，发布版本按原来的规则保留；不需要时可以在左侧列表这一项的「⋯」里整份删除。
      </p>}
      <footer className="flex flex-wrap items-center gap-3">
        <InformationExport draftId={draftId} current={draft}/>
        <Link href="/positioning" className="text-sm underline">开始新的定位</Link>
      </footer>
    </main>
  </WorkspaceFrame>;
}
