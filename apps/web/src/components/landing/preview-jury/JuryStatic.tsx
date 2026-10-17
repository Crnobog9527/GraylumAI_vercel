/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { JuryDetail, JurySeatNames, Seat, SeatCode } from './jury-events';
import { deskAt } from './jury-desk';
import type { Scene } from './jury-scenes';
import { SeatMark } from './JuryBits';
import { JuryDocument } from './JuryDocument';
import { DOSSIER_SEATS, DossierBody, type Arrived } from './JuryDossier';
import { JuryReader } from './JuryReader';
import styles from './jury.module.css';
import { DisplayHeading } from '@/components/chat-display/display-heading';

/**
 * Reduced motion: no movement and no playback. The report with every note of the review on it at once (issues with
 * the summary's seal, debates with their replies, rulings, the redline), then each person's record, then the result.
 */
export function JuryStatic({ scenes, detail, names, skipped, onOpenRecord }: {
  scenes: readonly Scene[]; detail: JuryDetail; names: JurySeatNames; skipped: readonly string[];
  onOpenRecord: (seat: SeatCode) => void;
}) {
  const roundsOf = (seat: Seat) => detail.seats.find(item => item.seat === seat)?.rounds.map(round => round.round) ?? [];
  const arrived: Arrived = { rounds: { A: roundsOf('A'), B: roundsOf('B'), C: roundsOf('C') }, summary: detail.summary.status !== 'none' };
  const view = deskAt(scenes, Infinity, true);
  const hover = { onPeek: () => {}, onPick: onOpenRecord };
  return (
    <div className={styles.static}>
      <p className={styles.staticLead}>
        已开启「减少动态效果」：下面一次列出整份报告和评审留下的全部批注与裁决。
        {skipped.includes('debate') ? '三位评审意见一致，没有开第 2 轮。' : ''}
      </p>
      <div className={styles.staticDesk}>
        <JuryDocument view={view} names={names} still {...hover} />
      </div>
      <section aria-labelledby="static-records" className={styles.staticRecords}>
        <DisplayHeading as="h2" id="static-records">每个人的记录</DisplayHeading>
        <div className={styles.staticColumns}>
          {DOSSIER_SEATS.map(seat => (
            <article key={seat} id={`record-${seat}`} className={styles.staticRecord} aria-label={`${names[seat]}的记录`}>
              <DisplayHeading as="h3"><SeatMark seat={seat} names={names} />{names[seat]}</DisplayHeading>
              <DossierBody detail={detail} names={names} seat={seat} arrived={arrived} live={false} />
            </article>
          ))}
        </div>
      </section>
      <JuryReader detail={detail} names={names} />
    </div>
  );
}
