/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  DECISION_LABEL, SEVERITY_LABEL, VERDICT_LABEL, revisionFailedLabel, type JuryEvent, type JurySeatNames,
} from './jury-events';
import { STAGES, stageOf, type JuryView, type TimedEvent } from './jury-timeline';
import { SeatDisc, Stamp, Statement } from './JuryStatement';
import styles from './jury-stage.module.css';

const FILTERS = [
  { key: 'all', label: '全部', types: null },
  { key: 'issues', label: '问题', types: ['issue'] },
  { key: 'debate', label: '辩论', types: ['disagreement', 'response'] },
  { key: 'rulings', label: '裁决', types: ['adjudication'] },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

function FeedLine({ event, names }: { event: JuryEvent; names: JurySeatNames }) {
  switch (event.type) {
    case 'decision':
      return (
        <>
          <p className={styles.feedHead}><SeatDisc seat={event.reviewer} size="sm" />{names[event.reviewer]}
            <span>{DECISION_LABEL[event.decision]}：{VERDICT_LABEL[event.verdict]}</span></p>
          <p className={styles.feedText}>最强替代：{event.strongestAlternative}</p>
        </>
      );
    case 'issue':
      return (
        <>
          <p className={styles.feedHead}><SeatDisc seat={event.reviewer} size="sm" />
            <span className={styles.severity} data-severity={event.severity}>{SEVERITY_LABEL[event.severity]}</span>
            <span>{event.section}</span></p>
          <p className={styles.feedText}>{event.problem}</p>
          <p className={styles.feedMeta}>{names[event.reviewer]}，从「{event.perspective}」的角度看</p>
        </>
      );
    case 'disagreement':
      return (
        <p className={styles.feedHead}><span className={styles.splitTag}>分歧</span>{DECISION_LABEL[event.decision]}
          <span>保留：{event.keep.map(seat => names[seat]).join('、')}；改：{event.change.map(seat => names[seat]).join('、')}</span></p>
      );
    case 'response':
      return (
        <>
          <p className={styles.feedHead}><SeatDisc seat={event.reviewer} size="sm" />{names[event.reviewer]}
            <span>回应 {names[event.to]}：{event.stance === 'agree' ? '同意' : '不同意'}</span></p>
          <p className={styles.feedText}>{event.strongestView}</p>
        </>
      );
    case 'reviewer_failed':
      return <p className={styles.feedHead}><SeatDisc seat={event.reviewer} size="sm" />{names[event.reviewer]}<span>没有给出可用意见</span></p>;
    case 'adjudication':
      return (
        <>
          <p className={styles.feedHead}><SeatDisc seat="S" size="sm" /><Stamp adopted={event.adopted} />
            <span>{event.issue}</span></p>
          <p className={styles.feedText}>{event.reason}</p>
        </>
      );
    case 'revision_ready':
      return <p className={styles.feedHead}><SeatDisc seat="S" size="sm" />修订稿完成<span>改了 {event.changedSections} 个章节</span></p>;
    case 'revision_failed':
      return <p className={styles.feedHead}><SeatDisc seat="S" size="sm" />修订稿没有生成成功<span>{revisionFailedLabel(event.reason)}</span></p>;
    default:
      return null;
  }
}

/** The record: everything said so far, newest first, with a filter. Counts are only of what was shown. */
export function RecordFeed({ view, names }: { view: JuryView; names: JurySeatNames }) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const count = (types: readonly string[] | null) => view.feed.filter(event => !types || types.includes(event.type)).length;
  const active = FILTERS.find(item => item.key === filter) ?? FILTERS[0];
  const items = view.feed.filter(event => !active.types || (active.types as readonly string[]).includes(event.type)).reverse();
  return (
    <section aria-labelledby="jury-record-title" className={styles.record}>
      <div className={styles.recordHead}>
        <h2 id="jury-record-title" className={styles.panelTitle}>评审记录</h2>
        <div className={styles.filters} role="group" aria-label="筛选记录">
          {FILTERS.map(item => (
            <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>
              {item.label}<span>{count(item.types)}</span>
            </button>
          ))}
        </div>
      </div>
      {items.length === 0 ? <p className={styles.recordEmpty}>评审交卷后，每一条判断、问题和裁决都会记在这里。</p> : (
        <ol className={styles.feed}>
          {items.map(event => <li key={event.id} data-kind={event.type}><FeedLine event={event} names={names} /></li>)}
        </ol>
      )}
    </section>
  );
}

/** The close: the finished revision with what was adopted, or the failure with what is still usable. */
export function Outcome({ view, names }: { view: JuryView; names: JurySeatNames }) {
  const revision = view.revision;
  if (!revision) return null;
  const adopted = view.rulings.filter(item => item.adopted);
  const declined = view.rulings.filter(item => !item.adopted);
  if (revision.type === 'revision_failed') {
    return (
      <section aria-labelledby="jury-outcome" className={cn(styles.outcome, styles.outcomeFailed)}>
        <h2 id="jury-outcome" className={styles.outcomeTitle}>修订稿没有生成成功</h2>
        <p className={styles.outcomeLede}>
          {revisionFailedLabel(revision.reason)}。评审团提出的 {view.issues.length} 条问题仍可逐条参考，原报告保持不变。
          想再试，需要重新开始一次评审。
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="jury-outcome" className={styles.outcome}>
      <div className={styles.seal} aria-hidden="true"><span>定稿</span></div>
      <div className={styles.outcomeBody}>
        <h2 id="jury-outcome" className={styles.outcomeTitle}>修订稿已完成</h2>
        <p className={styles.outcomeLede}>
          {names.S}按裁决改了 {revision.changedSections} 个章节、{revision.changedFields} 个定位字段。
          {view.skipped.length > 0 ? '三位评审在四个关键决定上意见一致，没有开第 2 轮。' : ''}
          先和原稿并排对比，确认后再采用。
        </p>
        <div className={styles.outcomeLists}>
          <div>
            <h3>采纳 {adopted.length} 条</h3>
            <ul>{adopted.map(item => <li key={item.id}>{item.issue}</li>)}</ul>
          </div>
          {declined.length > 0 ? (
            <div>
              <h3>不采纳 {declined.length} 条</h3>
              <ul>{declined.map(item => <li key={item.id}>{item.issue}</li>)}</ul>
            </div>
          ) : null}
        </div>
        <p className={styles.outcomeActions}>
          <button type="button" disabled>和原稿并排对比</button>
          <span>原型只用模拟数据，不打开真实修订稿。</span>
        </p>
      </div>
    </section>
  );
}

/** Reduced motion: the same review as a plain ordered list, grouped by station, everything visible at once. */
export function StaticReplay({ timed, view, names }: { timed: readonly TimedEvent[]; view: JuryView; names: JurySeatNames }) {
  return (
    <div className={styles.static}>
      <p className={styles.staticNote}>你开启了「减少动态效果」，评审过程按顺序完整列出，不播放动画。</p>
      <ol className={styles.staticStages}>
        {STAGES.map(stage => {
          const events = timed.map(item => item.event).filter(event => stageOf(event) === stage.key && event.type !== 'review_ended');
          const skipped = view.skipped.includes(stage.key);
          if (events.length === 0 && !skipped) return null;
          return (
            <li key={stage.key}>
              <h2 className={styles.panelTitle}>{stage.label}{skipped ? '（意见一致，跳过）' : ''}</h2>
              <ol className={styles.staticItems}>
                {events.map(event => (
                  <li key={event.id}>
                    {event.type === 'review_started' ? <p className={styles.note}>报告共 {event.sections} 章，交给三位评审。</p>
                      : event.type === 'reviewer_started' ? <p className={styles.note}><SeatDisc seat={event.reviewer} size="sm" />
                        {names[event.reviewer]} 开始第 {event.round} 轮审阅</p>
                        : event.type === 'summary_started' ? <p className={styles.note}><SeatDisc seat="S" size="sm" />{names.S} 开始汇总</p>
                          : <Statement event={event} names={names} />}
                  </li>
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
      <Outcome view={view} names={names} />
    </div>
  );
}
