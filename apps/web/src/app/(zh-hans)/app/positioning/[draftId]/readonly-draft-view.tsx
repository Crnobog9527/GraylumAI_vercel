'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { InformationExport } from './InformationExport';
import { confirmedSections } from './information-export';
import { ArchivedReport } from './archived-report';
// The gate imports this view; re-exported here so the pages keep one import line.
export { DraftArchiveGate, RouteDraftArchiveGate } from './draft-archive-gate';
// Every read of the draft behind the gate stops at a missing or someone else's draft, as the gate's own read does.
export { retryUnlessMissing } from '@/lib/read-retry';
import { PROFILE_ARCHIVE_TEXT } from '@/components/opc/profile-archive/profile-archive';

/**
 * A positioning draft whose conversation was deleted (Owner 2026-10-14: "删除定位对话后，已确认的内容
 * 保留为只读，可以再整份删除。"). Only the confirmed content is shown, the same list the export writes;
 * there is no conversation, editing, confirming or report here. The whole draft is deleted from the
 * sidebar's "⋯" menu.
 * `archived`: the draft's positioning profile was archived (PAYWALL, Owner 2026-10-20). The draft read is the full one,
 * so the same confirmed content is shown together with its report, and both can be exported; nothing can be changed.
 */
export function ReadonlyDraftView({ draftId, draft, archived = false }: { draftId: string; draft: unknown; archived?: boolean }) {
  let sections: ReturnType<typeof confirmedSections> = [];
  try { sections = confirmedSections(draft, draftId); } catch { sections = []; }
  // Deleting the whole draft (its work) from the sidebar while it is open leaves this page.
  const projectId = (draft as { projectId?: unknown } | null)?.projectId;
  return <WorkspaceFrame area="chat" activeWorkItemId={typeof projectId === 'string' ? projectId : undefined}>
    <main className="mx-auto w-full max-w-3xl space-y-5 overflow-y-auto p-4 text-[var(--text-primary)] sm:p-6">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold">{archived ? PROFILE_ARCHIVE_TEXT.readonlyTitle : '定位分析（只读）'}</h1>
        <p role="status" className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-sm">
          {archived ? PROFILE_ARCHIVE_TEXT.readonlyNotice : <>这段定位对话已删除。下面是你已确认的内容，只能查看和导出，不能继续对话或修改。
          不需要时，可以在左侧列表这一项的「⋯」里整份删除。</>}
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
      </section>) : archived ? null : <p className="text-sm text-[var(--text-secondary)]">
        这里没有未发布的已确认内容。如果这份定位有已发布的版本，发布版本按原来的规则保留；不需要时可以在左侧列表这一项的「⋯」里整份删除。
      </p>}
      {archived && <ArchivedReport draft={draft as Parameters<typeof ArchivedReport>[0]['draft']}/>}
      <footer className="flex flex-wrap items-center gap-3">
        <InformationExport draftId={draftId} current={draft}/>
        <Link href="/app/positioning" className="text-sm underline">开始新的定位</Link>
      </footer>
    </main>
  </WorkspaceFrame>;
}
