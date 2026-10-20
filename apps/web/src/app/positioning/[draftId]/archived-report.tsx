'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { ReportView } from '@/components/chat-display/report-view/report-view';
import { downloadReport, PROFILE_ARCHIVE_TEXT as T } from '@/components/opc/profile-archive/profile-archive';
import { savedFormalReport, savedFormalStrategy, type FormalReport } from './saved-report';

type Draft = { sessionId?: unknown; projectId?: unknown; roundId?: unknown; report?: FormalReport; snapshot?: { state?: unknown } };
const text = (value: unknown) => typeof value === 'string' ? value : '';

/**
 * The report of an archived profile's draft, read-only (PAYWALL profile archive): the finalized version's saved
 * report when there is one, otherwise this round's latest generated report. Nothing here starts, continues, edits
 * or reviews a report; it can only be read and downloaded.
 */
export function ArchivedReport({ draft }: { draft: Draft }) {
  const ids = { sessionId: text(draft.sessionId), projectId: text(draft.projectId), roundId: text(draft.roundId) };
  const saved = savedFormalReport(draft.snapshot?.state === 'published', draft.report);
  const latest = trpc.runtime.reportLatest.useQuery(ids, { enabled: !saved && Boolean(ids.sessionId && ids.projectId && ids.roundId),
    retry: 1 });
  const executionId = latest.data?.executionId ?? '';
  const status = trpc.runtime.reportStatus.useQuery({ executionId }, { enabled: !saved && Boolean(executionId) });
  const generated = status.data?.executionId === executionId ? status.data.body : null;
  const body = saved ?? (generated || null);
  const strategy = saved ? savedFormalStrategy(draft.report) : null;
  const [notice, setNotice] = useState('');
  if (!body) return null;
  return <section className="space-y-3" aria-label={T.report}>
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">{T.report}</h2>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm"
          onClick={() => { downloadReport(body, T.report); setNotice(T.reportExported); }}>{T.exportReport}</Button>
        {notice && <span role="status" className="text-sm">{notice}</span>}
      </div>
    </header>
    <ReportView body={body} streaming={false} {...(strategy ? { data: strategy.data, editedFields: strategy.textEdited } : {})} />
  </section>;
}
