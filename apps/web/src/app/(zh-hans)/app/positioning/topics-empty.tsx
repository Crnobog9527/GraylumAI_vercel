'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { trpc } from '@/trpc/client';
import { READ_RETRY } from '@/trpc/read-retry';
import { resumableDraftId, splitProfiles, type ProfileDraft } from '@/components/opc/profile-archive/profile-archive';
import { useProfileBusinesses } from '@/components/opc/profile-archive/profile-archive-api';
import styles from './start-work.module.css';

/**
 * What "做一批新选题" shows while no account has a confirmed positioning (walkthrough 2026-11-11, item 4): what is
 * missing, in plain words, and one button to it: back into the positioning that already exists (the same one the
 * profile-limit notice offers, `resumableDraftId`), or start one when there is none. Mounted only in that state, so the
 * profile list is read only then; the draft list is the page's own read.
 */
export function TopicsEmpty({ onStart }: { onStart: () => void }) {
  const profiles = useProfileBusinesses();
  const drafts = trpc.opc.list.useQuery(undefined, READ_RETRY);
  const known = !profiles.isPending && !profiles.error;
  const resume = known ? resumableDraftId(splitProfiles(profiles.businesses, (drafts.data?.drafts ?? []) as ProfileDraft[]).active) : null;
  return <>
    <p>选题要等定位三步都确认后才能做。{resume ? '你有一份还没做完的定位，可以接着做。' : known ? '先做一次定位分析，确认后回到这里就能开始选题。' : ''}</p>
    {resume ? <Link className={styles.selectionAction} href={`/app/positioning/${resume}`}>继续定位</Link>
      : known ? <button type="button" className={styles.selectionAction} onClick={onStart}>开始定位</button> : null}
  </>;
}
