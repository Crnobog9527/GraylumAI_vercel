'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { trpc } from '@/trpc/client';
import { ReportView } from '@/components/chat-display/report-view/report-view';
import { PROFILE_ARCHIVE_TEXT as T } from '@/components/opc/profile-archive/profile-archive';
import { ReportExport } from './report-export-button';
import { reportView } from './report-gen';
import type { ReportDocument } from './report-document';
import { savedFormalReport, savedFormalStrategy, type FormalReport } from './saved-report';

type Draft = { sessionId?: unknown; projectId?: unknown; roundId?: unknown; report?: FormalReport; snapshot?: { state?: unknown } };
const text = (value: unknown) => typeof value === 'string' ? value : '';

/**
 * The report of an archived profile's draft, read-only (PAYWALL profile archive, #1215 handoff item 4). Like the
 * report entry it shows this round's generated report when there is one (its current document, edits included),
 * otherwise the finalized version's saved report. Only existing reads are used: nothing starts, continues, edits or
 * reviews a report here; it can be read and exported (导出报告, no charge).
 */
export function ArchivedReport({ draft }: { draft: Draft }) {
  const ids = { sessionId: text(draft.sessionId), projectId: text(draft.projectId), roundId: text(draft.roundId) };
  const known = Boolean(ids.sessionId && ids.projectId && ids.roundId);
  const latest = trpc.runtime.reportLatest.useQuery(ids, { enabled: known, retry: 1 });
  const executionId = latest.data?.executionId ?? '';
  const status = trpc.runtime.reportStatus.useQuery({ executionId }, { enabled: Boolean(executionId) });
  const doc = trpc.runtime.reportDocument.useQuery({ executionId }, { enabled: Boolean(executionId), retry: 1 });
  const view = status.data?.executionId === executionId ? reportView(status.data) : null;
  const document = doc.data as ReportDocument | undefined;
  const saved = savedFormalReport(draft.snapshot?.state === 'published', draft.report);
  const strategy = savedFormalStrategy(draft.report);
  // Wait for the reads instead of showing the saved version first and then swapping it out.
  if ((known && latest.isPending) || (executionId && (status.isPending || doc.isPending))) return null;
  if (executionId && view?.kind === 'report' && document?.executionId === executionId)
    return <section className="space-y-3" aria-label={T.report}>
    <h2 className="text-base font-semibold">{T.report}</h2>
    <ReportView body={document.body} data={document.strategy?.data} editedFields={document.strategy?.textEdited} />
    <ReportExport executionId={executionId} notes={view.notices} />
  </section>;
  if (!saved) return null;
  return <section className="space-y-3" aria-label={T.report}>
    <h2 className="text-base font-semibold">{T.report}</h2>
    <ReportView body={saved} {...(strategy ? { data: strategy.data, editedFields: strategy.textEdited } : {})} />
    <ReportExport saved={{ body: saved, strategy }} />
  </section>;
}
