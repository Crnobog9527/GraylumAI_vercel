/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Gavel } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DECISION_LABEL, FAILED_REASON_LABEL, SEVERITY_LABEL, VERDICT_LABEL, revisionFailedLabel,
  type JuryEvent, type JurySeatNames, type Seat, type SeatCode,
} from './jury-events';
import styles from './jury-stage.module.css';

/** One seat's mark: the seat letter in its tone. The display name sits beside it, never a model name. */
export function SeatDisc({ seat, size = 'md' }: { seat: SeatCode; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={cn(styles.disc, styles[`disc_${size}`])} data-seat={seat} aria-hidden="true">
      {seat === 'S' ? <Gavel size={size === 'lg' ? 22 : 14} strokeWidth={2.2} /> : seat}
    </span>
  );
}

export function Stamp({ adopted, label }: { adopted: boolean; label?: string }) {
  return <span className={styles.stamp} data-adopted={adopted}>{label ?? (adopted ? '采纳' : '不采纳')}</span>;
}

const joinSeats = (seats: Seat[], names: JurySeatNames) => seats.map(seat => names[seat]).join('、');

/** The full statement, as read out on the podium (and listed in the reduced-motion version). */
export function Statement({ event, names }: { event: JuryEvent; names: JurySeatNames }) {
  switch (event.type) {
    case 'decision':
      return (
        <article className={styles.statement} data-kind="decision">
          <Speaker seat={event.reviewer} names={names} action={`钢人判断：${DECISION_LABEL[event.decision]}`} />
          <dl className={styles.steelman}>
            <div><dt>这样选的最强理由</dt><dd>{event.strongestCase}</dd></div>
            <div><dt>最强的替代方案</dt><dd>{event.strongestAlternative}</dd></div>
          </dl>
          <p className={styles.verdictLine}>
            判断<Stamp adopted={event.verdict === 'keep'} label={VERDICT_LABEL[event.verdict]} />
          </p>
        </article>
      );
    case 'issue':
      return (
        <article className={styles.statement} data-kind="issue">
          <Speaker seat={event.reviewer} names={names} action={event.round === 2 ? '第 2 轮补充问题' : '挑出一个问题'} />
          <p className={styles.issueMeta}>
            <span className={styles.severity} data-severity={event.severity}>{SEVERITY_LABEL[event.severity]}</span>
            <span>{event.section}</span>
            <span className={styles.perspective}>从「{event.perspective}」的角度看</span>
          </p>
          <dl className={styles.issueBody}>
            <div><dt>为什么</dt><dd className={styles.quote}>{event.problem}</dd></div>
            <div data-fix><dt>怎么改</dt><dd>{event.fix}</dd></div>
          </dl>
        </article>
      );
    case 'disagreement':
      return (
        <article className={styles.statement} data-kind="disagreement">
          <p className={styles.speakerAction}>发现分歧：{DECISION_LABEL[event.decision]}</p>
          <div className={styles.sides}>
            <div data-side="keep"><span>主张保留</span><strong>{joinSeats(event.keep, names)}</strong></div>
            <div data-side="change"><span>主张改</span><strong>{joinSeats(event.change, names)}</strong></div>
          </div>
          <p className={styles.note}>这个决定要进入第 2 轮：每位评审先把对方的观点讲到最强，再表态。</p>
        </article>
      );
    case 'response':
      return (
        <article className={styles.statement} data-kind="response">
          <Speaker seat={event.reviewer} names={names} action={`回应 ${names[event.to]}：${DECISION_LABEL[event.decision]}`} />
          <p className={styles.restateLabel}>先把对方的观点讲到最强</p>
          <p className={styles.quote}>{event.strongestView}</p>
          <p className={styles.verdictLine}>
            表态<Stamp adopted={event.stance === 'agree'} label={event.stance === 'agree' ? '同意' : '不同意'} />
          </p>
        </article>
      );
    case 'reviewer_failed':
      return (
        <article className={styles.statement} data-kind="failed">
          <Speaker seat={event.reviewer} names={names} action="没有给出可用意见" />
          <p className={styles.quote}>{FAILED_REASON_LABEL[event.reason]}。其他评审的意见照常进入汇总。</p>
        </article>
      );
    case 'adjudication':
      return (
        <article className={styles.statement} data-kind="ruling">
          <Speaker seat="S" names={names} action="裁决" />
          <p className={styles.rulingIssue}>{event.issue}</p>
          <p className={styles.rulingWho}>
            提出：{joinSeats(event.reviewers, names)}
            {event.single ? <span className={styles.single}>只有一位评审提到</span> : null}
          </p>
          <div className={styles.rulingBody}>
            <Stamp adopted={event.adopted} />
            <p>{event.reason}</p>
          </div>
        </article>
      );
    case 'revision_ready':
      return (
        <article className={styles.statement} data-kind="revision">
          <Speaker seat="S" names={names} action="修订稿完成" />
          <p className={styles.quote}>改了 {event.changedSections} 个章节、{event.changedFields} 个定位字段：{event.changedSectionTitles.join('、')}。</p>
        </article>
      );
    case 'revision_failed':
      return (
        <article className={styles.statement} data-kind="failed">
          <Speaker seat="S" names={names} action="修订稿没有生成成功" />
          <p className={styles.quote}>{revisionFailedLabel(event.reason)}。评审意见仍可参考，原报告保持不变。</p>
        </article>
      );
    default:
      return null;
  }
}

function Speaker({ seat, names, action }: { seat: SeatCode; names: JurySeatNames; action: string }) {
  return (
    <header className={styles.speaker}>
      <SeatDisc seat={seat} />
      <span className={styles.speakerName}>{names[seat]}</span>
      <span className={styles.speakerAction}>{action}</span>
    </header>
  );
}
