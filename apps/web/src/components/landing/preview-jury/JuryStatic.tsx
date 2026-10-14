/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { cn } from '@/lib/utils';
import type { JuryDetail, JurySeatNames, Seat, SeatCode } from './jury-events';
import { STAGES, type Scene } from './jury-scenes';
import { SceneBody } from './JuryBoard';
import { DOSSIER_SEATS, DossierBody, type Arrived } from './JuryDossier';
import { JuryResults } from './JuryResults';
import board from './jury-board.module.css';
import styles from './jury.module.css';

/**
 * Reduced motion: the whole review at once, no room and no movement. One block per stage with each scene as it
 * ends, then every person's record in its own column, then the result page.
 */
export function JuryStatic({ scenes, detail, names, skipped, onOpenRecord }: {
  scenes: readonly Scene[]; detail: JuryDetail; names: JurySeatNames; skipped: readonly string[];
  onOpenRecord: (seat: SeatCode) => void;
}) {
  const roundsOf = (seat: Seat) => detail.seats.find(item => item.seat === seat)?.rounds.map(round => round.round) ?? [];
  const arrived: Arrived = { rounds: { A: roundsOf('A'), B: roundsOf('B'), C: roundsOf('C') }, summary: detail.summary.status !== 'none' };
  return (
    <div className={styles.static}>
      <ol className={styles.staticStages}>
        {STAGES.map((stage, index) => {
          const own = scenes.filter(scene => scene.stage === stage.key);
          return (
            <li key={stage.key} className={styles.staticStage}>
              <h2><span>{index + 1}</span>{stage.label}</h2>
              {own.length === 0
                ? <p className={styles.staticEmpty}>{skipped.includes(stage.key) ? '三位评审意见一致，这一步跳过。' : '这一步没有发生。'}</p>
                : own.map(scene => (
                  <div key={`${scene.kind}-${scene.start}`} className={cn(board.board, board.still)}>
                    <SceneBody scene={scene} names={names} clock={scene.end} />
                  </div>
                ))}
            </li>
          );
        })}
      </ol>
      <section aria-labelledby="static-records" className={styles.staticRecords}>
        <h2 id="static-records">每个人的记录</h2>
        <div className={styles.staticColumns}>
          {DOSSIER_SEATS.map(seat => (
            <article key={seat} id={`record-${seat}`} className={styles.staticRecord} aria-label={`${names[seat]}的记录`}>
              <h3>{names[seat]}</h3>
              <DossierBody detail={detail} names={names} seat={seat} arrived={arrived} live={false} />
            </article>
          ))}
        </div>
      </section>
      <JuryResults detail={detail} names={names} onOpenRecord={onOpenRecord} />
    </div>
  );
}
