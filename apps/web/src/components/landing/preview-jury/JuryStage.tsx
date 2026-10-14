/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DECISIONS, DECISION_LABEL, SEATS, VERDICT_LABEL, type JurySeatNames, type SeatCode } from './jury-events';
import { formatElapsed, STAGES, type JuryView, type SeatState } from './jury-timeline';
import { SeatDisc, Statement } from './JuryStatement';
import styles from './jury-stage.module.css';

/** The stations of the ceremony. A station lights only after an event of it was shown; nothing here is a fake bar. */
export function StageRail({ view }: { view: JuryView }) {
  const current = STAGES[view.stage];
  return (
    <nav aria-label="评审进程" className={styles.rail}>
      <p className={styles.railPhone} aria-hidden="true">
        {current ? <>第 {view.stage + 1} 站<strong>{current.label}</strong></> : '等待开始'}
      </p>
      <ol>
        {STAGES.map((stage, index) => {
          const skipped = view.skipped.includes(stage.key);
          const state = skipped ? 'skipped' : index < view.stage ? 'done' : index === view.stage ? 'current' : 'todo';
          return (
            <li key={stage.key} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
              <span className={styles.railDot} aria-hidden="true" />
              <span className={styles.railLabel}>{stage.label}{skipped ? <small>（意见一致，跳过）</small> : null}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const PHASE_LINE: Record<SeatState['phase'], string> = {
  idle: '等待入席',
  thinking: '独立审阅中',
  ready: '已交卷，等待宣读',
  speaking: '正在发言',
  done: '发言完毕',
  failed: '没有给出可用意见',
};
const SUMMARY_LINE: Record<SeatState['phase'], string> = {
  idle: '等待汇总',
  thinking: '正在汇总意见、写修订稿',
  ready: '已写完，等待宣读裁决',
  speaking: '正在宣读裁决',
  done: '裁决完毕',
  failed: '修订稿没有生成成功',
};

function SeatCard({ seat, state, name, now, verdicts }: {
  seat: SeatCode; state: SeatState; name: string; now: number; verdicts?: JuryView['verdicts'];
}) {
  const round = seat === 'S' ? '' : state.round === 2 ? '第 2 轮' : state.round === 1 ? '第 1 轮' : '';
  const line = (seat === 'S' ? SUMMARY_LINE : PHASE_LINE)[state.phase];
  return (
    <li className={styles.seat} data-phase={state.phase} data-seat={seat}>
      <div className={styles.seatTop}>
        <SeatDisc seat={seat} size="lg" />
        {state.phase === 'thinking' ? <span className={styles.pages} aria-hidden="true"><i /><i /><i /></span> : null}
      </div>
      <p className={styles.seatName}>{name}</p>
      <p className={styles.seatPhase}>
        {`${round}${line}`}
        {state.phase === 'thinking' ? <span className={styles.timer}>已用 {formatElapsed(now - state.since)}</span> : null}
      </p>
      {verdicts && seat !== 'S' ? (
        <ul className={styles.tally} aria-label={`${name}对四个关键决定的判断`}>
          {DECISIONS.map(key => {
            const verdict = verdicts[key][seat];
            return (
              <li key={key} data-verdict={verdict ?? 'none'} title={DECISION_LABEL[key]}>
                <span>{DECISION_LABEL[key]}</span>
                <b>{verdict ? VERDICT_LABEL[verdict] : '—'}</b>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

/** The bench: three reviewers in a row, the summary writer's seat taking the floor once the ruling starts. */
export function Bench({ view, names, now }: { view: JuryView; names: JurySeatNames; now: number }) {
  return (
    <section aria-label="评审席" className={styles.bench}>
      <ul className={styles.seats}>
        {SEATS.map(seat => <SeatCard key={seat} seat={seat} state={view.seats[seat]} name={names[seat]} now={now} verdicts={view.verdicts} />)}
      </ul>
      {view.summary.phase !== 'idle' ? (
        <ul className={cn(styles.seats, styles.summarySeat)}>
          <SeatCard seat="S" state={view.summary} name={names.S} now={now} />
        </ul>
      ) : null}
    </section>
  );
}

/** The podium: one statement at a time, re-keyed so each arrival plays its entrance. */
export function Podium({ view, names }: { view: JuryView; names: JurySeatNames }) {
  // At the end the outcome takes the podium's place, so the result is not read out twice.
  if (view.revision) return null;
  const thinking = SEATS.filter(seat => view.seats[seat].phase === 'thinking').length;
  const secondRound = SEATS.some(seat => view.seats[seat].round === 2);
  const waiting = view.summary.phase === 'thinking'
    ? `${names.S}正在汇总全部意见、裁决分歧并写修订稿。写完并通过检查后，裁决会在这里逐条宣读。`
    : secondRound
      ? '评审们正在读彼此的意见，准备第 2 轮回应：先把对方的观点讲到最强，再表态。'
      : view.sections > 0
        ? `${thinking || 3} 位评审正在各自独立审阅这份 ${view.sections} 章的报告，互相看不到对方的意见。交卷后逐条在这里宣读。`
        : '评审团正在入席。';
  return (
    <section aria-label="发言台" aria-live="polite" className={styles.podium}>
      {view.current && !view.waiting ? (
        <div key={view.current.id} className={styles.podiumIn}><Statement event={view.current} names={names} /></div>
      ) : (
        <div key={`wait-${secondRound}-${view.summary.phase}`} className={cn(styles.podiumIn, styles.waiting)}>
          <span className={styles.waitMark} aria-hidden="true"><i /><i /><i /></span>
          <p>{waiting}</p>
        </div>
      )}
    </section>
  );
}

/** The four key decisions with each reviewer's verdict; a split decision is outlined and marked. */
export function DecisionBoard({ view, names }: { view: JuryView; names: JurySeatNames }) {
  return (
    <section aria-labelledby="jury-board-title" className={styles.board}>
      <h2 id="jury-board-title" className={styles.panelTitle}>四个关键决定</h2>
      <table>
        <thead>
          <tr><th scope="col"><span className="sr-only">决定</span></th>{SEATS.map(seat => (
            <th key={seat} scope="col" title={names[seat]}><SeatDisc seat={seat} size="sm" /><span className="sr-only">{names[seat]}</span></th>
          ))}</tr>
        </thead>
        <tbody>
          {DECISIONS.map(key => {
            const split = view.disagreements.some(item => item.decision === key);
            return (
              <tr key={key} data-split={split}>
                <th scope="row">{DECISION_LABEL[key]}{split ? <span className={styles.splitTag}>有分歧</span> : null}</th>
                {SEATS.map(seat => {
                  const verdict = view.verdicts[key][seat];
                  return (
                    <td key={seat} data-verdict={verdict ?? 'none'}>
                      {verdict === 'keep' ? <Check size={14} aria-hidden="true" /> : verdict === 'change' ? <X size={14} aria-hidden="true" /> : null}
                      <span>{verdict ? VERDICT_LABEL[verdict] : '—'}</span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
