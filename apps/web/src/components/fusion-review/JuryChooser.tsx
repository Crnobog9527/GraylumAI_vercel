/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import Link from 'next/link';
import { trpc } from '@/trpc/client';
import { READ_RETRY } from '@/trpc/read-retry';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { platformName } from '@/components/publish-monitor/labels';
import { resumableDraftId, splitProfiles, type ProfileDraft } from '@/components/opc/profile-archive/profile-archive';
import { useProfileBusinesses } from '@/components/opc/profile-archive/profile-archive-api';
import { ACTIVE, latestByDraft, reviewHref, type MineItem } from './review-adapter';
import styles from './jury-entry.module.css';

/** The mark that opens the jury card on a positioning's report page (JuryEntry reads it). */
export const JURY_ENTRY_PARAM = 'jury';
export const juryEntryHref = (draftId: string) => `/app/positioning/${draftId}?${JURY_ENTRY_PARAM}=1`;

type Account = { projectId: string; platform: string; account: string; strategyDraftId?: string | null };
type Business = { name?: string | null; accounts: Account[] };
type Draft = { draftId: string; state?: string; currentVersion?: number };
export type JuryChoice = { draftId: string; name: string; business: string; review?: MineItem };

/**
 * The positionings a jury can review: one row per confirmed positioning (a published version, or a draft round on top of
 * one), named by its account, with its newest review when there is one. The same rule as the topic list of the start page.
 */
export function juryChoices(businesses: readonly Business[] | undefined, drafts: readonly Draft[] | undefined, reviews: readonly MineItem[] | undefined): JuryChoice[] {
  const latest = latestByDraft(reviews ?? []);
  const seen = new Set<string>();
  return (businesses ?? []).flatMap(business => business.accounts.flatMap(account => {
    const draftId = account.strategyDraftId ?? '';
    const draft = (drafts ?? []).find(item => item.draftId === draftId);
    if (!draftId || seen.has(draftId) || !draft || !(draft.state === 'published' || (draft.currentVersion ?? 0) > 0)) return [];
    seen.add(draftId);
    return [{ draftId, name: `${platformName(account.platform)} · ${account.account}`, business: business.name ?? '', review: latest.get(draftId) }];
  }));
}

/** What a positioning's newest review offers, in the words the report page's own entry uses. */
const reviewLine = (review: MineItem) => (ACTIVE.has(review.state)
  ? (review.state === 'paused' ? '评审团已暂停，去看看 →' : '评审团正在审阅，去看看 →')
  : review.awaitingChoice ? '评审完成，去逐章选择 →' : '查看上次评审 →');

/**
 * The rail's "评审团" entry for a member whose plan has the jury (Owner 2026-11-12). The jury has no page of its own: it
 * reviews the report of one positioning, from that positioning's report page. So the entry asks which one, and takes the
 * user there with the jury card open; a review that is running or finished is one click away from the same list. Without
 * a confirmed positioning it says what the jury reviews and leads to the positioning instead.
 */
export function JuryChooser({ onClose }: { onClose: () => void }) {
  // The same reads, with the same keys, as the frame's rail: nothing more is asked of the server here.
  const library = trpc.opc.library.useQuery({ search: '', from: null, to: null });
  const drafts = trpc.opc.list.useQuery();
  const reviews = trpc.fusionReview.mine.useQuery({ limit: 50 }, { staleTime: 30_000, ...READ_RETRY });
  const profiles = useProfileBusinesses();
  const known = library.isSuccess && drafts.isSuccess;
  const choices = juryChoices(library.data?.businesses as Business[] | undefined, drafts.data?.drafts as Draft[] | undefined,
    Array.isArray(reviews.data) ? reviews.data : []);
  const resume = resumableDraftId(splitProfiles(profiles.businesses, (drafts.data?.drafts ?? []) as ProfileDraft[]).active);
  return (
    <Dialog open onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent tone="light" className={styles.chooser}>
        <DialogHeader>
          <DialogTitle>请评审团审阅哪一份报告</DialogTitle>
          <DialogDescription>评审团审阅的是一份定位的运营策略报告。选一份，在它的报告页开始。</DialogDescription>
        </DialogHeader>
        {library.error || drafts.error ? <p role="alert" className={styles.error}>暂时读不到你的定位，请稍后再试。</p>
          : !known ? <div aria-busy="true" className={styles.chooserWait} />
            : choices.length === 0 ? <div className={styles.chooserEmpty}>
              <p>还没有确认过的定位。先完成定位、生成运营策略报告，再请评审团审阅。</p>
              <Link className={styles.chooserAction} href={resume ? `/app/positioning/${resume}` : '/app/positioning'} onClick={onClose}>
                {resume ? '继续定位' : '开始定位'}</Link>
            </div>
              : <ul className={styles.chooserList}>
                {choices.map(choice => <li key={choice.draftId}>
                  <Link className={styles.chooserRow} href={juryEntryHref(choice.draftId)} onClick={onClose}>
                    <span>{choice.name}{choice.business && <small>{choice.business}</small>}</span><span aria-hidden="true">→</span></Link>
                  {choice.review && <Link className={styles.link} href={reviewHref(choice.draftId, choice.review.reviewId)} onClick={onClose}>
                    {reviewLine(choice.review)}</Link>}
                </li>)}
              </ul>}
      </DialogContent>
    </Dialog>
  );
}
