/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/trpc/client';
import type { AdoptProposed, AdoptRecorded, JuryDetail, JurySeatNames, SeatCode } from '@/components/landing/preview-jury/jury-events';
import type { Arrived } from '@/components/landing/preview-jury/JuryDossier';
import type { ReaderSource } from '@/components/landing/preview-jury/jury-reader';
import type { AdoptActions } from '@/components/landing/preview-jury/use-adoption';
import { JuryReader } from '@/components/landing/preview-jury/JuryReader';
import { JuryRecords } from '@/components/landing/preview-jury/JuryRecords';
import layout from '@/components/landing/preview-jury/jury-layout.module.css';
import { endedNotice, evidenceText, feeText, type ReviewFee } from './review-adapter';
import styles from './review-page.module.css';

/**
 * The ended review: the whole report made easy to read with the chapter choice (the prototype's result page, now on
 * the real adopt / confirmAdoption), and each person's record beside it. Opening it marks the review as seen.
 */
export function ReviewResult({ draftId, detail, source, names, fee, onChanged }: {
  draftId: string; detail: JuryDetail; source: ReaderSource; names: JurySeatNames;
  /** The review's fixed price and what was actually charged (0294). */
  fee?: ReviewFee;
  /** Read the review again (a choice recorded in another tab, or a new formal version). */
  onChanged: () => void;
}) {
  const utils = trpc.useUtils();
  const adopt = trpc.fusionReview.adopt.useMutation().mutateAsync;
  const confirm = trpc.fusionReview.confirmAdoption.useMutation().mutateAsync;
  const seen = trpc.fusionReview.markSeen.useMutation();
  const markSeen = seen.mutate;
  const [picked, setPicked] = useState<SeatCode | null>(null);
  const reviewId = detail.reviewId;

  useEffect(() => { markSeen({ reviewId }, { onSuccess: () => void utils.fusionReview.mine.invalidate() }); }, [reviewId, markSeen, utils]);

  const actions = useMemo<AdoptActions>(() => ({
    propose: async ({ requestId, choices }) =>
      await adopt({ reviewId, requestId, choices }) as AdoptProposed | AdoptRecorded,
    confirm: async ({ requestId, choices, proposal, decision }) => {
      const recorded = await confirm({ reviewId, requestId, choices, expectedDiffHash: proposal.diffHash, decision });
      // A new formal version changes the positioning page; the sidebar mark goes away once a choice is recorded.
      await Promise.all([utils.opc.read.invalidate({ draftId }), utils.fusionReview.mine.invalidate()]);
      return recorded as AdoptRecorded;
    },
    onRecordedElsewhere: onChanged,
  }), [adopt, confirm, reviewId, draftId, utils, onChanged]);

  const arrived: Arrived = {
    rounds: Object.fromEntries(detail.seats.map(item => [item.seat, item.rounds.map(round => round.round)])) as Arrived['rounds'],
    summary: detail.summary.status !== 'none',
  };
  const notice = endedNotice(detail.state, detail.outcome);
  const charge = feeText(fee);
  const held = evidenceText(detail.evidence);
  return (
    <>
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {charge ? <p className={styles.notice} role="status">{charge}</p> : null}
      {held ? <p className={styles.notice} role="status">{held}</p> : null}
      <div className={layout.results}>
        <JuryReader detail={detail} names={names} source={source} actions={actions} />
        <JuryRecords detail={detail} names={names} arrived={arrived} live={false} following="S" picked={picked}
          onPick={setPicked} onFollow={() => setPicked(null)} />
      </div>
    </>
  );
}
