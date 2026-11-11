'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { trpc } from '@/trpc/client';
import { retryUnlessMissing } from '@/lib/read-retry';
import { PROFILE_ARCHIVE_TEXT } from '@/components/opc/profile-archive/profile-archive';
import { useDraftArchiveState } from '@/components/opc/profile-archive/profile-archive-api';
import { WorkspaceSkeleton } from '@/components/opc/workspace-skeleton';
import { ReadonlyDraftView } from './readonly-draft-view';

/**
 * In front of a positioning draft's editable pages (the draft and its topics): an archived profile's draft opens
 * read-only (PAYWALL, Owner 2026-10-20), and the editable page, with its queries, polling, autosave and automatic
 * adoption, only mounts once the profile is confirmed active. A deleted conversation keeps its own read-only page.
 */
export function DraftArchiveGate({ draftId, children, area = 'chat' }: { draftId: string; children: ReactNode; area?: 'chat' | 'topics' }) {
  const read = trpc.opc.read.useQuery({ draftId }, { enabled: Boolean(draftId), retry: retryUnlessMissing });
  const deleted = (read.data as { conversationDeleted?: unknown } | undefined)?.conversationDeleted === true;
  // The profiles are asked for with the draft, not after it (SITE-SPEED): both reads leave in one request, so the page
  // opens one round trip sooner (about 1 s on staging, 2026-11-12). What opens is decided as before, below: a deleted
  // conversation and a failed draft read go to the page whatever the profiles say, and nothing editable opens until
  // the draft is read and its profile is confirmed active.
  const archive = useDraftArchiveState(draftId, Boolean(draftId));
  // The page itself shows a missing id, a failed read and a deleted conversation. "Failed" is the last settled read:
  // the page's own read of the same draft refetches the failed query on mount, which puts it back to pending without
  // data. Showing "checking" then would unmount the page, whose next mount refetches again: an endless loop.
  // Only a read that never returned the draft counts: with cached data, a failed refetch still goes through the
  // archive check, so an archived draft never opens its editor.
  const failed = read.data === undefined && (read.isError || (read.errorUpdatedAt ?? 0) > (read.dataUpdatedAt ?? 0));
  if (!draftId || failed || deleted) return children;
  if (read.isPending || archive.state === 'pending') return <WorkspaceSkeleton area={area} label="定位档案读取中" />;
  if (archive.state === 'error') return <main className="p-6"><p role="alert">{PROFILE_ARCHIVE_TEXT.loadFailed}{' '}
    <button type="button" className="underline" onClick={archive.retry}>重试</button></p></main>;
  if (archive.state === 'archived') return <ReadonlyDraftView draftId={draftId} draft={read.data} archived/>;
  return children;
}

/** The gate for a page that reads its draft id from the route (the topics page). */
export function RouteDraftArchiveGate({ children }: { children: ReactNode }) {
  const draftId = useParams<{ draftId: string }>()?.draftId ?? '';
  return <DraftArchiveGate draftId={draftId} area="topics">{children}</DraftArchiveGate>;
}
