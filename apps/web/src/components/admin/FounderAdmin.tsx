/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { founderAdminError, type FounderOverviewRow } from './founderAdminView';
import { FounderMembersPanel } from './FounderMembersPanel';
import { FounderWallReviewPanel } from './FounderWallReviewPanel';
import { FounderCommunityEntryForm, FounderLivestreamPanel } from './FounderSettingsPanel';

export function FounderAdmin() {
  const overview = trpc.founder.admin.overview.useQuery(undefined, { refetchOnWindowFocus: true });
  const livestreams = trpc.founder.admin.livestreams.useQuery();
  const mark = trpc.founder.admin.markCommunity.useMutation();
  const review = trpc.founder.admin.reviewWall.useMutation();
  const setEntry = trpc.founder.admin.setCommunityEntry.useMutation();
  const record = trpc.founder.admin.recordLivestream.useMutation();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ notice?: string; failure?: string }>({});
  const [savedEntry, setSavedEntry] = useState<{ url: string | null; note: string | null } | null>();

  async function run(work: () => Promise<unknown>, notice: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage({});
    try {
      await work();
      setMessage({ notice });
    } catch (error) {
      setMessage({ failure: founderAdminError(error as never, 'save') });
    } finally {
      running.current = false;
      setBusy(false);
      void overview.refetch();
      void livestreams.refetch();
    }
  }

  const onMark = (row: FounderOverviewRow, action: 'joined' | 'removed') =>
    void run(() => mark.mutateAsync({ userId: row.userId, action }), action === 'joined' ? '已标记入群。' : '已标记移出。');
  const onReview = (row: FounderOverviewRow, decision: 'approved' | 'rejected') => {
    if (!row.wall) return;
    void run(() => review.mutateAsync({ userId: row.userId, decision, seenUpdatedAt: row.wall!.updatedAt }),
      decision === 'approved' ? '已通过。' : '已拒绝。');
  };

  return <div className="space-y-6" data-testid="admin-founders">
    {message.notice && <p role="status">{message.notice}</p>}
    {message.failure && <p role="alert">{message.failure}</p>}
    {overview.error && !overview.data ? <div role="alert" className="space-y-2">
      <p>{founderAdminError(overview.error, 'read')}</p>
      <Button variant="outline" onClick={() => { void overview.refetch(); }}>重新读取</Button>
    </div> : !overview.data ? <p>读取中…</p> : <>
      <FounderMembersPanel rows={overview.data} pending={busy} onMark={onMark} />
      <FounderWallReviewPanel rows={overview.data} pending={busy} onReview={onReview} />
    </>}
    <FounderCommunityEntryForm pending={busy} saved={savedEntry}
      onSave={value => void run(async () => {
        setSavedEntry(await setEntry.mutateAsync({ url: value.url, note: value.note }));
      }, '社群入口已保存。')} />
    <FounderLivestreamPanel items={livestreams.data} failed={Boolean(livestreams.error)}
      onRetry={() => { void livestreams.refetch(); }} pending={busy}
      onRecord={value => void run(() => record.mutateAsync({ requestId: crypto.randomUUID(), ...value }), '直播记录已保存。')} />
  </div>;
}
