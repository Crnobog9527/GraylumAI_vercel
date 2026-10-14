/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { cn } from '@/lib/utils';
import { DECISION_LABEL, type JurySeatNames, type Seat, type SeatCode } from './jury-events';
import type { MarginItem, Reply } from './jury-desk';
import { RulingSeal, SeatBadge, SeatMark, SeverityTag, VerdictStamp } from './JuryBits';
import styles from './jury-margin.module.css';

export type PeekHandlers = { onPeek: (seat: SeatCode | null) => void; onPick: (seat: SeatCode) => void };
type Props = PeekHandlers & { names: JurySeatNames };

const STANCE: Record<'agree' | 'disagree', string> = { agree: '同意', disagree: '反对' };

/** Hovering (or focusing) a note opens its author's full record beside the document; a tap pins it. */
function peekProps(seat: SeatCode, { onPeek, onPick }: PeekHandlers) {
  return {
    onMouseEnter: () => onPeek(seat), onMouseLeave: () => onPeek(null), onFocus: () => onPeek(seat), onBlur: () => onPeek(null),
    onClick: () => onPick(seat), tabIndex: 0, 'data-seat': seat,
  };
}

/** One chapter's margin: the notes the review has left on it so far. */
export function JuryMargin({ items, ...props }: Props & { items: readonly MarginItem[] }) {
  return (
    <ul className={styles.margin}>
      {items.map(item => <li key={item.key} className={styles.slot}><Note item={item} {...props} /></li>)}
    </ul>
  );
}

function Note({ item, ...props }: Props & { item: MarginItem }) {
  switch (item.kind) {
    case 'decision': return <Decision item={item} {...props} />;
    case 'issue': return <Issue item={item} {...props} />;
    case 'split': return <Split item={item} {...props} />;
    case 'ruling': return <Ruling item={item} {...props} />;
  }
}

function Decision({ item, names }: Props & { item: Extract<MarginItem, { kind: 'decision' }> }) {
  const label = DECISION_LABEL[item.decision];
  if (!item.open) {
    return (
      <div className={styles.line} aria-label={`关键决定「${label}」`}>
        <span className={styles.lineTitle}>关键决定「{label}」</span>
        <span className={styles.votes}>
          {item.cards.map(card => (
            <span key={card.seat} className={styles.vote}><SeatMark seat={card.seat} names={names} size="sm" /><VerdictStamp verdict={card.verdict} /></span>
          ))}
        </span>
      </div>
    );
  }
  return (
    <article className={cn(styles.card, styles.decision)} aria-label={`关键决定「${label}」`}>
      <header className={styles.cardHead}><strong>关键决定「{label}」</strong><span className={styles.hint}>先把原来的选择讲到最强</span></header>
      <ol className={styles.steel}>
        {item.cards.slice(0, item.revealed).map(card => (
          <li key={card.seat} className={styles.steelRow} data-seat={card.seat}>
            <div className={styles.steelHead}><SeatBadge seat={card.seat} names={names} compact /><VerdictStamp verdict={card.verdict} /></div>
            <p><span className={styles.key}>最强理由</span>{card.strongestCase}</p>
            <p className={styles.alt}><span className={styles.key}>最强替代</span>{card.strongestAlternative}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}

function Issue({ item, names, ...handlers }: Props & { item: Extract<MarginItem, { kind: 'issue' }> }) {
  const { issue, seat } = item;
  if (item.tone === 'quiet') {
    return (
      <div className={cn(styles.line, styles.quiet)} {...peekProps(seat, handlers)} aria-label={`${names[seat]}的批注：${issue.problem}`}>
        <SeatMark seat={seat} names={names} size="sm" />
        <span className={styles.lineText}>{issue.problem}</span>
        {item.stamp === null ? null : <RulingSeal adopted={item.stamp} />}
      </div>
    );
  }
  return (
    <article className={cn(styles.card, styles.comment, item.tone === 'current' && styles.current)} {...peekProps(seat, handlers)}
      aria-label={`${names[seat]}的批注`}>
      <header className={styles.cardHead}>
        <SeatBadge seat={seat} names={names} compact />
        <SeverityTag severity={issue.severity} />
        {item.stamp === null ? null : <RulingSeal adopted={item.stamp} />}
      </header>
      <p className={styles.angle}>{issue.section}，从「{issue.perspective}」的角度</p>
      <p><span className={styles.key}>为什么</span>{issue.problem}</p>
      <p><span className={styles.key}>怎么改</span>{issue.fix}</p>
    </article>
  );
}

function Side({ seats, verdict, item, names, handlers }: {
  seats: Seat[]; verdict: 'keep' | 'change'; item: Extract<MarginItem, { kind: 'split' }>; names: JurySeatNames; handlers: PeekHandlers;
}) {
  return (
    <div className={styles.side} data-side={verdict}>
      <p className={styles.sideTitle}>{verdict === 'keep' ? '主张保留' : '主张改'}</p>
      {seats.map(seat => {
        const card = item.cards.find(entry => entry.seat === seat);
        return (
          <div key={seat} className={styles.sideEntry} {...peekProps(seat, handlers)}>
            <SeatBadge seat={seat} names={names} compact />
            <p>{verdict === 'keep' ? card?.strongestCase : card?.strongestAlternative}</p>
          </div>
        );
      })}
    </div>
  );
}

function Split({ item, names, ...handlers }: Props & { item: Extract<MarginItem, { kind: 'split' }> }) {
  return (
    <article className={cn(styles.card, styles.split, item.current && styles.current)} aria-label={`「${DECISION_LABEL[item.split.decision]}」上的分歧`}>
      <header className={styles.cardHead}><strong>「{DECISION_LABEL[item.split.decision]}」意见不一</strong></header>
      <div className={styles.pair}>
        <Side seats={item.split.keep} verdict="keep" item={item} names={names} handlers={handlers} />
        <div className={styles.crux} aria-hidden="true"><span>分歧点：保留还是改</span></div>
        <Side seats={item.split.change} verdict="change" item={item} names={names} handlers={handlers} />
      </div>
      {item.replies.length > 0 ? (
        <ol className={styles.thread} aria-label="第 2 轮回复">
          {item.replies.map(reply => <ReplyRow key={reply.response.id} reply={reply} names={names} handlers={handlers} />)}
        </ol>
      ) : null}
    </article>
  );
}

function ReplyRow({ reply, names, handlers }: { reply: Reply; names: JurySeatNames; handlers: PeekHandlers }) {
  const { reviewer, to, strongestView, stance } = reply.response;
  return (
    <li className={cn(styles.reply, reply.current && styles.replyCurrent)} {...peekProps(reviewer, handlers)}>
      <div className={styles.replyHead}>
        <SeatBadge seat={reviewer} names={names} compact />
        <span className={styles.replyTo}>回复</span>
        <SeatMark seat={to} names={names} size="sm" />
      </div>
      <p className={styles.restate}><span className={styles.key}>先复述对方最强的观点</span>{strongestView}</p>
      {reply.turned ? (
        <p className={styles.stance} data-stance={stance}>
          <strong>{STANCE[stance]}</strong>
          {reply.verdictNow ? <span>现在主张 <VerdictStamp verdict={reply.verdictNow} /></span> : null}
        </p>
      ) : null}
    </li>
  );
}

function Ruling({ item, names, ...handlers }: Props & { item: Extract<MarginItem, { kind: 'ruling' }> }) {
  const { ruling } = item;
  if (item.compact) {
    return (
      <div className={cn(styles.line, styles.rulingLine)} {...peekProps('S', handlers)}>
        <RulingSeal adopted={ruling.adopted} />
        <span className={styles.lineText}>{ruling.opinion}</span>
      </div>
    );
  }
  return (
    <article className={cn(styles.card, styles.ruling, item.current && styles.current)} {...peekProps('S', handlers)}
      aria-label={`${names.S}的裁决：${ruling.adopted ? '采纳' : '不采纳'}`}>
      <header className={styles.cardHead}>
        <SeatBadge seat="S" names={names} compact />
        <span className={styles.stampSlot} data-live={item.current}><RulingSeal adopted={ruling.adopted} large /></span>
      </header>
      <p className={styles.opinion}>{ruling.opinion}</p>
      <p><span className={styles.key}>裁决理由</span>{ruling.reason}</p>
      <footer className={styles.rulingFoot}>
        <span className={styles.raised}>提出 {ruling.reviewers.map(seat => <SeatMark key={seat} seat={seat} names={names} size="sm" />)}</span>
        {ruling.disputed ? <span className={styles.flag}>评审之间有分歧</span> : null}
        {ruling.single ? <span className={styles.flag}>只有一位评审提出</span> : null}
      </footer>
    </article>
  );
}
