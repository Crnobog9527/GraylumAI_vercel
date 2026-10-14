/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo } from 'react';
import { DECISIONS, DECISION_LABEL, SEATS, type JuryDetail, type JurySeatNames, type SeatCode } from './jury-events';
import { choosable, finalVerdicts, issueCount, issuesByChapter, splitDecisions } from './jury-adopt';
import { DECISION_SECTION, REPORT_SECTIONS } from './jury-mock-reviews';
import { SeatBadge, SeverityTag, VerdictStamp } from './JuryBits';
import { JuryAdoption } from './JuryAdoption';
import styles from './jury-results.module.css';

/**
 * The result page, the part users care about: per key decision and per chapter, what the panel finally said, why,
 * and how to change it; then the user picks, chapter by chapter, the revision or the original. Mock adopt only.
 */
export function JuryResults({ detail, names, onOpenRecord }: {
  detail: JuryDetail; names: JurySeatNames; onOpenRecord: (seat: SeatCode) => void;
}) {
  const sections = detail.summary.sections;
  const withRulings = sections.filter(item => item.rulings.length > 0 || item.changed);
  const quiet = sections.length - withRulings.length;
  const failed = detail.summary.status !== 'usable';
  const rulings = sections.flatMap(item => item.rulings);
  const verdicts = useMemo(() => finalVerdicts(detail), [detail]);
  const splits = useMemo(() => splitDecisions(detail), [detail]);
  const rounds = detail.seats.some(item => item.rounds.some(round => round.round === 2)) ? 2 : 1;

  return (
    <section className={styles.results} aria-labelledby="jury-results-title">
      <header className={styles.top}>
        <h2 id="jury-results-title">
          {failed ? '修订稿没有生成成功，三位评审的意见仍可参考' : `评审完成：${names.S}改了 ${choosable(sections).length} 章`}
        </h2>
        <ul className={styles.facts}>
          <li>3 位评审独立审阅</li>
          <li>{rounds === 2 ? `辩论了 ${splits.length} 个有分歧的决定` : '没有分歧，没开第 2 轮'}</li>
          <li>提出 {issueCount(detail)} 条问题</li>
          {failed ? null : <li>{rulings.filter(item => item.adopted).length} 条写进修订稿</li>}
        </ul>
        <p className={styles.recordHint}>
          想看某位评审的完整原文：
          {(['A', 'B', 'C', 'S'] as const).map(seat => (
            <button key={seat} type="button" className={styles.recordLink} onClick={() => onOpenRecord(seat)}>
              <SeatBadge seat={seat} names={names} compact />
            </button>
          ))}
        </p>
      </header>

      <section className={styles.block} aria-labelledby="jury-decisions">
        <h3 id="jury-decisions">4 个关键决定</h3>
        <ul className={styles.decisions}>
          {DECISIONS.map(key => {
            const ruling = rulings.find(item => item.section === DECISION_SECTION[key] && item.disputed)
              ?? rulings.find(item => item.section === DECISION_SECTION[key]);
            const changed = SEATS.filter(seat => verdicts[key][seat] === 'change').length;
            return (
              <li key={key} className={styles.decision}>
                <div className={styles.decisionHead}>
                  <strong>{DECISION_LABEL[key]}</strong>
                  {splits.includes(key) ? <span className={styles.flag}>有分歧，已辩论</span> : <span className={styles.flagSoft}>意见一致</span>}
                </div>
                <ul className={styles.votes}>
                  {SEATS.map(seat => verdicts[key][seat] ? (
                    <li key={seat}><SeatBadge seat={seat} names={names} compact /><VerdictStamp verdict={verdicts[key][seat]} /></li>
                  ) : null)}
                </ul>
                <p className={styles.decisionLine}>
                  {ruling ? ruling.opinion : changed === 0 ? '三位评审都主张保留报告原来的选择。' : '见下面对应章节的意见。'}
                </p>
                <a className={styles.jump} href={`#chapter-${DECISION_SECTION[key]}`}>{DECISION_SECTION[key]}</a>
              </li>
            );
          })}
        </ul>
      </section>

      {failed ? <FailedChapters detail={detail} names={names} /> : (
        <JuryAdoption detail={detail} names={names} quiet={quiet} />
      )}
    </section>
  );
}

function FailedChapters({ detail, names }: { detail: JuryDetail; names: JurySeatNames }) {
  const groups = issuesByChapter(detail, REPORT_SECTIONS);
  return (
    <section className={styles.block} aria-labelledby="jury-chapters">
      <h3 id="jury-chapters">按章节整理的评审意见</h3>
      <p className={styles.blockNote}>这次没有修订稿，也没有汇总裁决；下面是评审们的原始意见，你可以自己修改，或者重新发起一次评审。</p>
      <div className={styles.chapters}>
        {groups.map(group => (
          <article key={group.section} className={styles.chapter} id={`chapter-${group.section}`}>
            <header className={styles.chapterHead}><h3>{group.section}</h3></header>
            <ul className={styles.rulings}>
              {group.items.map(item => (
                <li key={item.problem} className={styles.ruling}>
                  <div className={styles.meta}><SeatBadge seat={item.seat} names={names} compact /><SeverityTag severity={item.severity} /></div>
                  <p className={styles.issue}>{item.perspective}</p>
                  <dl className={styles.why}><dt>为什么</dt><dd>{item.problem}</dd><dt>建议怎么改</dt><dd>{item.suggestion}</dd></dl>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      <p className={styles.blockNote}>其余章节评审没有提意见。</p>
    </section>
  );
}
