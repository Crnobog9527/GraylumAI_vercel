'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { trpc } from '@/trpc/client';
import { PROFILE_ARCHIVE_TEXT } from '@/components/opc/profile-archive/profile-archive';
import { useDraftArchiveState } from '@/components/opc/profile-archive/profile-archive-api';
import { ReadonlyDraftView } from './readonly-draft-view';

/**
 * In front of a positioning draft's editable pages (the draft and its topics): an archived profile's draft opens
 * read-only (PAYWALL, Owner 2026-10-20), and the editable page, with its queries, polling, autosave and automatic
 * adoption, only mounts once the profile is confirmed active. A deleted conversation keeps its own read-only page.
 */
export function DraftArchiveGate({ draftId, children }: { draftId: string; children: ReactNode }) {
  const read = trpc.opc.read.useQuery({ draftId }, { enabled: Boolean(draftId) });
  const deleted = (read.data as { conversationDeleted?: unknown } | undefined)?.conversationDeleted === true;
  const archive = useDraftArchiveState(draftId, Boolean(draftId) && read.isSuccess && !deleted);
  // The page itself shows a missing id, a failed read and a deleted conversation. "Failed" is the last settled read:
  // the page's own read of the same draft refetches the failed query on mount, which puts it back to pending without
  // data. Showing "checking" then would unmount the page, whose next mount refetches again: an endless loop.
  const failed = read.isError || (read.errorUpdatedAt ?? 0) > (read.dataUpdatedAt ?? 0);
  if (!draftId || failed || deleted) return children;
  if (read.isPending || archive.state === 'pending') return <main className="p-6" role="status">{PROFILE_ARCHIVE_TEXT.checking}</main>;
  if (archive.state === 'error') return <main className="p-6"><p role="alert">{PROFILE_ARCHIVE_TEXT.loadFailed}{' '}
    <button type="button" className="underline" onClick={archive.retry}>重试</button></p></main>;
  if (archive.state === 'archived') return <ReadonlyDraftView draftId={draftId} draft={read.data} archived/>;
  return children;
}

/** The gate for a page that reads its draft id from the route (the topics page). */
export function RouteDraftArchiveGate({ children }: { children: ReactNode }) {
  const draftId = useParams<{ draftId: string }>()?.draftId ?? '';
  return <DraftArchiveGate draftId={draftId}>{children}</DraftArchiveGate>;
}
