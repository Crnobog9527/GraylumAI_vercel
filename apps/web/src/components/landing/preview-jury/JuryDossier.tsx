/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { cn } from '@/lib/utils';
import {
  DECISION_LABEL, STANCE_LABEL, type DetailDecision, type DetailRound, type JuryDetail,
  type JurySeatNames, type Seat, type SeatCode,
} from './jury-events';
import { ChapterTag, SeatBadge, SeverityTag, VerdictStamp } from './JuryBits';
import styles from './jury-dossier.module.css';

export const DOSSIER_SEATS: readonly SeatCode[] = ['A', 'B', 'C', 'S'];

/** Which parts of the owner's full record exist yet: a reviewer's round once its answer arrived, the summary's output. */
export type Arrived = { rounds: Record<Seat, number[]>; summary: boolean };

/**
 * Each person's own folder: the full, uncut text from fusionReview.detail, never mixed with anyone else's.
 * Tabs switch folders; pointing at a person in the room (or tapping them) switches too.
 */
export function JuryDossier({ detail, names, seat, arrived, onSelect, live }: {
  detail: JuryDetail; names: JurySeatNames; seat: SeatCode; arrived: Arrived; onSelect: (seat: SeatCode) => void; live: boolean;
}) {
  return (
    <section className={styles.dossier} aria-label="评审记录夹">
      <div role="tablist" aria-label="选择谁的记录" className={styles.tabs}>
        {DOSSIER_SEATS.map(code => (
          <button key={code} type="button" role="tab" aria-selected={code === seat} id={`dossier-tab-${code}`}
            aria-controls="dossier-panel" onClick={() => onSelect(code)} className={styles.tab} data-seat={code}>
            <SeatBadge seat={code} names={names} compact />
          </button>
        ))}
      </div>
      <div id="dossier-panel" role="tabpanel" aria-labelledby={`dossier-tab-${seat}`} className={styles.panel} key={seat}>
        <DossierBody detail={detail} names={names} seat={seat} arrived={arrived} live={live} />
      </div>
    </section>
  );
}

export function DossierBody({ detail, names, seat, arrived, live }: {
  detail: JuryDetail; names: JurySeatNames; seat: SeatCode; arrived: Arrived; live: boolean;
}) {
  return seat === 'S'
    ? <SummaryFolder detail={detail} names={names} ready={arrived.summary} live={live} />
    : <ReviewerFolder detail={detail} names={names} seat={seat} arrived={arrived.rounds[seat]} live={live} />;
}

function DecisionBlock({ item, before }: { item: DetailDecision; before?: DetailDecision }) {
  const shifted = before && before.verdict !== item.verdict;
  return (
    <li className={styles.entry}>
      <div className={styles.entryTop}>
        <strong>{DECISION_LABEL[item.decision]}</strong>
        {shifted ? <span className={styles.shift}>第 2 轮改判：<VerdictStamp verdict={before.verdict} />→</span> : null}
        <VerdictStamp verdict={item.verdict} />
      </div>
      <dl className={styles.pairs}>
        <dt>最强理由</dt><dd>{item.strongestCase}</dd>
        <dt>最强的另一种做法</dt><dd>{item.strongestAlternative}</dd>
        <dt>依据</dt><dd>{item.basis}</dd>
      </dl>
    </li>
  );
}

function RoundBlock({ round, names, previous }: { round: DetailRound; names: JurySeatNames; previous?: DetailRound }) {
  if (round.status === 'failed') {
    return <p className={styles.failed}>这一轮没有给出可用意见，不计入汇总。</p>;
  }
  const decisions = round.round === 2
    ? (round.decisions ?? []).filter(item => previous?.decisions?.find(old => old.decision === item.decision)?.verdict !== item.verdict)
    : round.decisions ?? [];
  return (
    <>
      {round.responses?.length ? (
        <>
          <h4>回应别人（{round.responses.length} 条）</h4>
          <ul className={styles.list}>
            {round.responses.map(item => (
              <li key={`${item.reviewer}-${item.decision}`} className={styles.entry}>
                <div className={styles.entryTop}>
                  <span>回应 <SeatBadge seat={item.reviewer} names={names} compact /> 关于「{DECISION_LABEL[item.decision]}」</span>
                  <span className={styles.stance} data-stance={item.stance}>{STANCE_LABEL[item.stance]}</span>
                </div>
                <dl className={styles.pairs}>
                  <dt>先把对方观点讲到最强</dt><dd>{item.strongestView}</dd>
                  <dt>为什么这样表态</dt><dd>{item.reason}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {round.round === 1 || decisions.length > 0 ? (
        <>
          <h4>{round.round === 1 ? '4 个关键决定' : '改判的决定'}</h4>
          <ul className={styles.list}>
            {decisions.map(item => (
              <DecisionBlock key={item.decision} item={item} before={previous?.decisions?.find(old => old.decision === item.decision)} />
            ))}
          </ul>
        </>
      ) : <p className={styles.note}>其余决定和第 1 轮相同。</p>}
      {round.issues?.length ? (
        <>
          <h4>提出的问题（{round.issues.length} 条）</h4>
          <ul className={styles.list}>
            {round.issues.map(item => (
              <li key={item.problem} className={styles.entry}>
                <div className={styles.entryTop}><ChapterTag>{item.location}</ChapterTag><SeverityTag severity={item.severity} /></div>
                <p className={styles.perspective}>{item.perspective}</p>
                <dl className={styles.pairs}><dt>为什么</dt><dd>{item.problem}</dd><dt>怎么改</dt><dd>{item.suggestion}</dd></dl>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function ReviewerFolder({ detail, names, seat, arrived, live }: {
  detail: JuryDetail; names: JurySeatNames; seat: Seat; arrived: number[]; live: boolean;
}) {
  const rounds = detail.seats.find(item => item.seat === seat)?.rounds ?? [];
  return (
    <>
      <p className={styles.lead}>{names[seat]}的完整意见原文，按轮次排列。</p>
      {rounds.map(round => (
        <section key={round.round} className={styles.round}>
          <h3>第 {round.round} 轮</h3>
          {arrived.includes(round.round)
            ? <RoundBlock round={round} names={names} previous={rounds.find(item => item.round === 1)} />
            : <p className={cn(styles.note, live && styles.waiting)}>{live ? '还在审阅，交卷后这里会出现完整原文。' : '这一轮没有进行。'}</p>}
        </section>
      ))}
    </>
  );
}

function SummaryFolder({ detail, names, ready, live }: { detail: JuryDetail; names: JurySeatNames; ready: boolean; live: boolean }) {
  if (!ready) return <p className={cn(styles.note, live && styles.waiting)}>{names.S}还没开始写，三位评审交卷后才会汇总。</p>;
  if (detail.summary.status !== 'usable') {
    return <p className={styles.failed}>修订稿没有通过检查，这次没有裁决记录；三位评审的意见在各自的记录夹里。</p>;
  }
  const sections = detail.summary.sections.filter(item => item.rulings.length > 0);
  return (
    <>
      <p className={styles.lead}>{names.S}的全部裁决，按报告章节排列。</p>
      {sections.map(section => (
        <section key={section.section} className={styles.round}>
          <h3>{section.section}{section.changed ? <span className={styles.changed}>修订稿改了这一章</span> : null}</h3>
          <ul className={styles.list}>
            {section.rulings.map(item => (
              <li key={item.issue} className={styles.entry}>
                <div className={styles.entryTop}><strong>{item.issue}</strong>
                  <span className={styles.stance} data-stance={item.adopted ? 'agree' : 'disagree'}>{item.adopted ? '写进修订稿' : '不改原文'}</span>
                </div>
                <dl className={styles.pairs}>
                  <dt>最终意见</dt><dd>{item.opinion}</dd><dt>理由</dt><dd>{item.reason}</dd><dt>怎么改</dt><dd>{item.fix}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
