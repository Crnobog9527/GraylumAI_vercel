'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { trpc } from '@/trpc/client';
import { ReportView } from '@/components/chat-display/report-view/report-view';
import { PROFILE_ARCHIVE_TEXT as T } from '@/components/opc/profile-archive/profile-archive';
import { ReportExport } from './report-export-button';
import { reportView } from './report-gen';
import { useTurnReport } from './use-turn-report';
import type { ReportDocument } from './report-document';
import { savedFormalReport, savedFormalStrategy, type FormalReport } from './saved-report';

type Draft = { sessionId?: unknown; projectId?: unknown; roundId?: unknown; report?: FormalReport; snapshot?: { state?: unknown } };
const text = (value: unknown) => typeof value === 'string' ? value : '';

/**
 * The report of an archived profile's draft, read-only (PAYWALL profile archive, #1215 handoff item 4). Like the
 * report entry it shows this round's generated report when there is one (its current document, edits included),
 * otherwise the finalized version's saved report. Only existing reads are used: nothing starts, continues, edits or
 * reviews a report here; it can be read and exported (导出报告, no charge). The round's report is read from its turn
 * (`/api/turn/report`, CORE-PATH-V2 V2-12 B6); a report of the old path is not found, and the saved version shows.
 */
export function ArchivedReport({ draft }: { draft: Draft }) {
  const ids = { sessionId: text(draft.sessionId), projectId: text(draft.projectId), roundId: text(draft.roundId) };
  // The turn read needs both ids; without them there is no generated report to look for, only the saved version.
  return ids.sessionId && ids.projectId && ids.roundId ? <ArchivedRoundReport draft={draft} sessionId={ids.sessionId} roundId={ids.roundId} />
    : <SavedOnly draft={draft} />;
}

function SavedOnly({ draft }: { draft: Draft }) {
  const saved = savedFormalReport(draft.snapshot?.state === 'published', draft.report);
  const strategy = savedFormalStrategy(draft.report);
  if (!saved) return null;
  return <section className="space-y-3" aria-label={T.report}>
    <h2 className="text-base font-semibold">{T.report}</h2>
    <ReportView body={saved} {...(strategy ? { data: strategy.data, editedFields: strategy.textEdited } : {})} />
    <ReportExport saved={{ body: saved, strategy }} />
  </section>;
}

function ArchivedRoundReport({ draft, sessionId, roundId }: { draft: Draft; sessionId: string; roundId: string }) {
  const turn = useTurnReport(false, sessionId, roundId);
  const executionId = turn.status?.executionId ?? '';
  const doc = trpc.runtime.reportDocument.useQuery({ executionId }, { enabled: Boolean(executionId), retry: 1 });
  const view = turn.status ? reportView(turn.status) : null;
  const document = doc.data as ReportDocument | undefined;
  // Wait for the reads instead of showing the saved version first and then swapping it out.
  if (!turn.known || (executionId && doc.isPending)) return null;
  if (executionId && view?.kind === 'report' && document?.executionId === executionId)
    return <section className="space-y-3" aria-label={T.report}>
    <h2 className="text-base font-semibold">{T.report}</h2>
    <ReportView body={document.body} data={document.strategy?.data} editedFields={document.strategy?.textEdited} />
    <ReportExport executionId={executionId} notes={view.notices} />
  </section>;
  return <SavedOnly draft={draft} />;
}
