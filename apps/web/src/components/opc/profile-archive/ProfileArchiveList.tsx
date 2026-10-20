'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import Link from 'next/link';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { PROFILE_ARCHIVE_TEXT as T, profileName, splitProfiles, type ProfileDraft, type ProfileRow } from './profile-archive';
import { useProfileBusinesses } from './profile-archive-api';

/**
 * The caller's positioning profiles with an archive action (PAYWALL, Owner 2026-10-20). Archived ones sit in their
 * own folded group and open read-only. Shown next to "梳理账号定位" and under the profile-limit notice.
 */
export function ProfileArchiveList({ limitReached = false }: { limitReached?: boolean }) {
  const profiles = useProfileBusinesses();
  const drafts = trpc.opc.list.useQuery(undefined, { retry: false });
  const entitlements = trpc.user.getEntitlements.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const archive = trpc.opc.archiveBusiness.useMutation();
  const [confirming, setConfirming] = useState<ProfileRow | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: 'status' | 'alert' } | null>(null);
  const { active, archived } = splitProfiles(profiles.businesses, (drafts.data?.drafts ?? []) as ProfileDraft[]);
  const limit = entitlements.data?.positioningProfileLimit;

  async function confirmArchive() {
    if (!confirming || archive.isPending) return;
    setNotice(null);
    try {
      // Archiving is idempotent on the server, so retrying the same profile after an unclear failure is safe.
      await archive.mutateAsync({ businessId: confirming.businessId });
      setConfirming(null);
      setNotice({ text: T.archived, tone: 'status' });
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      // BUSY: a call on this profile is still settling; DENIED: it is gone (erased) or not the caller's.
      // The staging mapping may append its own wording after the code ("OPC_BUSINESS_BUSY：…").
      const busy = code.includes('OPC_BUSINESS_BUSY'), gone = code.includes('OPC_BUSINESS_DENIED');
      if (gone) setConfirming(null);
      setNotice({ text: busy ? T.archiveBusy : gone ? T.archiveGone : T.archiveFailed, tone: 'alert' });
    }
    await profiles.refetch();
  }

  if (profiles.isPending) return null;
  if (profiles.error) return <p role="alert" className="text-sm">{T.loadFailed}</p>;
  return <section aria-label={T.title} className="mt-5 space-y-3 text-left">
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-sm font-semibold">{T.title}</h3>
      {typeof limit === 'number' && <span className="text-xs text-[var(--text-secondary)]">{T.usage(active.length, limit)}</span>}
    </header>
    {limitReached && <p className="text-xs text-[var(--text-secondary)]">{T.limitHint}</p>}
    {!active.length && !archived.length && <p className="text-xs text-[var(--text-secondary)]">{T.empty}</p>}
    {active.length > 0 && <ul className="divide-y divide-[var(--border-primary)] rounded-lg border border-[var(--border-primary)]">
      {active.map(row => <li key={row.businessId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
        {row.draftId ? <Link href={`/positioning/${row.draftId}`} className="min-w-0 truncate">{profileName(row)}</Link>
          : <span className="min-w-0 truncate">{profileName(row)}</span>}
        <Button type="button" variant="outline" size="sm" disabled={archive.isPending}
          onClick={() => { setNotice(null); setConfirming(row); }}>{T.archive}</Button>
      </li>)}
    </ul>}
    {archived.length > 0 && <details className="text-sm">
      <summary className="cursor-pointer text-xs text-[var(--text-secondary)]">{T.archivedGroup(archived.length)}</summary>
      <ul className="mt-2 divide-y divide-[var(--border-primary)] rounded-lg border border-[var(--border-primary)]">
        {archived.map(row => <li key={row.businessId} className="flex items-center justify-between gap-3 px-3 py-2">
          <span className="min-w-0 truncate text-[var(--text-secondary)]">{profileName(row)}
            <span className="ml-2 text-xs">{T.archivedTag}</span></span>
          {row.draftId ? <Link href={`/positioning/${row.draftId}`} className="text-xs underline">{T.view}</Link>
            : <span className="text-xs text-[var(--text-secondary)]">{T.noDraft}</span>}
        </li>)}
      </ul>
    </details>}
    {notice && !confirming && <p role={notice.tone} className="text-xs">{notice.text}</p>}
    {confirming && <div role="presentation" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <section role="alertdialog" aria-modal="true" aria-label={T.confirmTitle}
        onKeyDown={event => { if (event.key === 'Escape' && !archive.isPending) setConfirming(null); }}
        className="w-full max-w-sm space-y-3 rounded-xl bg-[var(--bg-primary)] p-5 text-[var(--text-primary)] shadow-xl">
        <h2 className="text-base font-semibold">{T.confirmTitle}</h2>
        <p className="text-sm font-medium">{profileName(confirming)}</p>
        <p className="text-sm text-[var(--text-secondary)]">{T.confirmBody}</p>
        {notice?.tone === 'alert' && <p role="alert" className="text-xs">{notice.text}</p>}
        <footer className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" autoFocus disabled={archive.isPending}
            onClick={() => setConfirming(null)}>{T.cancel}</Button>
          <Button type="button" size="sm" disabled={archive.isPending} onClick={() => void confirmArchive()}>
            {archive.isPending ? T.archiving : T.confirm}</Button>
        </footer>
      </section>
    </div>}
  </section>;
}
