/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo, useState } from 'react';
import { CheckCircle2, Clock3 } from 'lucide-react';
import {
  DECISIONS, DECISION_LABEL, SEATS, type AdoptResult, type JuryDetail, type JurySeatNames, type SeatCode,
} from './jury-events';
import {
  adoptErrorLabel, choosable, chosenCount, finalVerdicts, isComplete, issueCount, issuesByChapter, mockAdopt, needsConfirm, setConfirmed,
  setUse, splitDecisions, toChoices, type ChoiceState,
} from './jury-adopt';
import { DECISION_SECTION, REPORT_SECTIONS } from './jury-mock-reviews';
import { SeatBadge, SeverityTag, VerdictStamp } from './JuryBits';
import { JuryChapter } from './JuryChapter';
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
        <Adoption detail={detail} names={names} quiet={quiet} />
      )}
    </section>
  );
}

function Adoption({ detail, names, quiet }: { detail: JuryDetail; names: JurySeatNames; quiet: number }) {
  const sections = detail.summary.sections;
  const shown = sections.filter(item => item.rulings.length > 0 || item.changed);
  const [state, setState] = useState<ChoiceState>({});
  const [result, setResult] = useState<AdoptResult | null>(detail.adoption);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [later, setLater] = useState(false);
  const total = choosable(sections).length;
  const done = chosenCount(state, sections);

  const submit = () => {
    if (stale) { setError(adoptErrorLabel('REPORT_REVISION_STALE')); return; }
    if (!isComplete(state, sections)) {
      const unconfirmed = choosable(sections).some(item => needsConfirm(item, state));
      setError(adoptErrorLabel(unconfirmed ? 'FUSION_ADOPTION_CONFIRM_REQUIRED' : 'FUSION_ADOPTION_INCOMPLETE'));
      return;
    }
    setError(null);
    setResult(mockAdopt(toChoices(state, sections)));
  };

  return (
    <section className={styles.block} aria-labelledby="jury-chapters">
      <h3 id="jury-chapters">逐章意见和你的选择</h3>
      <p className={styles.blockNote}>
        改过的章节由你决定用修订版还是原文；没改的章节保留原文。全部选完后合成一份新版本。
        {quiet > 0 ? `其余 ${quiet} 章评审团没有意见。` : ''}
      </p>
      {result ? null : (
        <label className={styles.prototypeSwitch}>
          <input type="checkbox" checked={stale} onChange={event => setStale(event.target.checked)} />
          原型开关：模拟「评审之后改过草稿」，看提交被拒时的提示
        </label>
      )}
      <div className={styles.chapters}>
        {shown.map(section => (
          <JuryChapter key={section.section} section={section} names={names} state={state} locked={Boolean(result)}
            onUse={use => { setState(value => setUse(value, sections, section.section, use)); setError(null); }}
            onConfirm={confirmed => setState(value => setConfirmed(value, section.section, confirmed))} />
        ))}
      </div>

      {result ? (
        <div className={styles.done} role="status">
          <CheckCircle2 size={20} aria-hidden="true" />
          {result.versionId
            ? <p>新版本已生成：{result.adopted.length} 章采用修订版{result.kept.length ? `，${result.kept.length} 章保留原文` : ''}。之后的选题和写作会用新版本。</p>
            : <p>你选择全部保留原文，报告没有变化；这次的选择已经记下。</p>}
        </div>
      ) : (
        <div className={styles.bar}>
          <span className={styles.count}>已选 {done}/{total} 章</span>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {later ? <p className={styles.later}><Clock3 size={14} aria-hidden="true" />选择会一直留在这次评审里，你可以先去改草稿，回来再选。</p> : null}
          <div className={styles.barActions}>
            <button type="button" className={styles.secondary} onClick={() => setLater(true)}>先不选，稍后回来</button>
            <button type="button" className={styles.primary} onClick={submit} aria-disabled={done < total}>合成新版本</button>
          </div>
        </div>
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
