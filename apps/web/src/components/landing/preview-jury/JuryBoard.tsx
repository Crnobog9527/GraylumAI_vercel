/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Check, Gavel, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DECISIONS, DECISION_LABEL, FAILED_REASON_LABEL, revisionFailedLabel, SEATS, STANCE_LABEL, type JurySeatNames, type Seat,
} from './jury-events';
import { issueIndexAt, responseTurned } from './jury-poses';
import type { Scene, SteelmanCard } from './jury-scenes';
import { ChapterTag, SeatBadge, SeverityTag, VerdictStamp } from './JuryBits';
import styles from './jury-board.module.css';

type Props = { scene: Scene; names: JurySeatNames; clock: number };

/**
 * The table top under the room: only the scene on stage, laid out so it can be read at 1×. Cards fly in from the
 * person who said them (data-from), and stay put until the scene changes; nothing scrolls past.
 */
export function JuryBoard({ scene, names, clock }: Props) {
  return (
    <section className={styles.board} aria-live="polite" key={`${scene.kind}-${scene.start}`}>
      <SceneBody scene={scene} names={names} clock={clock} />
    </section>
  );
}

function Heading({ step, title, note }: { step?: string; title: string; note?: string }) {
  return (
    <header className={styles.heading}>
      {step ? <span className={styles.step}>{step}</span> : null}
      <h2>{title}</h2>
      {note ? <p>{note}</p> : null}
    </header>
  );
}

function SteelCard({ card, names, delay }: { card: SteelmanCard; names: JurySeatNames; delay: number }) {
  return (
    <article className={styles.card} data-from={card.seat} style={{ animationDelay: `${delay}ms` }}>
      <div className={styles.cardTop}><SeatBadge seat={card.seat} names={names} /><VerdictStamp verdict={card.verdict} /></div>
      <p className={styles.label}>最强理由</p>
      <p className={styles.text}>{card.strongestCase}</p>
      <p className={styles.label}>最强的另一种做法</p>
      <p className={styles.textMuted}>{card.strongestAlternative}</p>
    </article>
  );
}

export function SceneBody({ scene, names, clock }: Props) {
  switch (scene.kind) {
    case 'seated':
      return (
        <Heading title="评审团入席" note={`三位评审会各自读完你的 ${scene.sections} 章报告，从报告里每一类受众和你本人的角度提意见；`
          + `意见不一时辩论一轮，最后由${names.S}逐条裁决、写出修订稿。`} />
      );
    case 'reading':
      return (
        <>
          <Heading step={scene.round === 1 ? '第 1 轮' : '第 2 轮'}
            title={scene.round === 1 ? '各自审阅，互相看不到对方的意见' : '每位评审读完别人的第 1 轮意见，准备回应'}
            note="每位评审交卷后，意见才会出现在台面上。" />
          <ul className={styles.status}>
            {SEATS.map(seat => {
              const at = scene.submitAt[seat];
              const done = at !== undefined && clock >= at;
              const failed = done && scene.failed.includes(seat);
              return (
                <li key={seat} data-state={failed ? 'failed' : done ? 'done' : 'working'}>
                  <SeatBadge seat={seat} names={names} compact />
                  <span>{failed ? '没有给出可用意见' : done ? '已交卷' : '审阅中'}</span>
                </li>
              );
            })}
          </ul>
        </>
      );
    case 'steelman':
      return (
        <>
          <Heading step={`钢人判断 ${scene.index + 1}/4`} title={`关键决定：${DECISION_LABEL[scene.decision]}`}
            note="每位评审先把报告原来的选择讲到最强，再讲最强的另一种做法，然后决定保留还是改。" />
          <div className={styles.trio}>
            {scene.cards.map((card, index) => <SteelCard key={card.seat} card={card} names={names} delay={900 + index * 650} />)}
          </div>
        </>
      );
    case 'critique': {
      const shown = issueIndexAt(scene, clock);
      return (
        <>
          <Heading step="挑刺" title={`${names[scene.seat]} 提出的问题（${scene.issues.length} 条）`}
            note="每条都写清楚是哪一章、从谁的角度看、为什么有问题、怎么改。" />
          <ol className={styles.issues}>
            {scene.issues.slice(0, shown + 1).map((issue, index) => (
              <li key={issue.id} className={cn(styles.card, styles.issue, index === shown && styles.current)} data-from={scene.seat}>
                <div className={styles.cardTop}><ChapterTag>{issue.section}</ChapterTag><SeverityTag severity={issue.severity} /></div>
                <p className={styles.perspective}>{issue.perspective}</p>
                <p className={styles.text}><b>为什么：</b>{issue.problem}</p>
                <p className={styles.text}><b>怎么改：</b>{issue.fix}</p>
              </li>
            ))}
          </ol>
        </>
      );
    }
    case 'divergence': {
      const side = (seats: Seat[], verdict: 'keep' | 'change') => (
        <div className={styles.side} data-side={verdict}>
          <VerdictStamp verdict={verdict} label={verdict === 'keep' ? '主张保留' : '主张要改'} />
          {seats.map(seat => {
            const card = scene.cards.find(item => item.seat === seat);
            return (
              <div key={seat} className={styles.sideEntry}>
                <SeatBadge seat={seat} names={names} compact />
                <p className={styles.text}>{verdict === 'keep' ? card?.strongestCase : card?.strongestAlternative}</p>
              </div>
            );
          })}
        </div>
      );
      return (
        <>
          <Heading step={`找分歧 ${scene.index + 1}/${scene.total}`} title={`「${DECISION_LABEL[scene.split.decision]}」上意见不一`}
            note="有人保留、有人要改，所以要开第 2 轮：双方先把对方的观点讲到最强，再表态。" />
          <div className={styles.faceOff}>{side(scene.split.keep, 'keep')}<span className={styles.versus}>对</span>{side(scene.split.change, 'change')}</div>
        </>
      );
    }
    case 'agreed':
      return (
        <>
          <Heading step="找分歧" title="四个关键决定，三位评审意见一致"
            note={`没有分歧，不开第 2 轮，直接交给${names.S}。`} />
          <ul className={styles.agreed}>
            {DECISIONS.map(key => <li key={key}><Check size={16} aria-hidden="true" />{DECISION_LABEL[key]}</li>)}
          </ul>
        </>
      );
    case 'response': {
      const { reviewer, to, decision, strongestView, stance } = scene.response;
      const turned = responseTurned(scene, clock);
      return (
        <>
          <Heading step="第 2 轮辩论" title={`关于「${DECISION_LABEL[decision]}」，${names[reviewer]} 回应 ${names[to]}`} />
          <div className={styles.debate}>
            <article className={styles.card} data-from={reviewer}>
              <div className={styles.cardTop}><SeatBadge seat={reviewer} names={names} /><span className={styles.arrow}>先讲对方最强的观点</span></div>
              <p className={styles.quote}>{strongestView}</p>
            </article>
            {turned ? (
              <div className={styles.stance} data-stance={stance}>
                {stance === 'agree' ? <Check size={18} aria-hidden="true" /> : <X size={18} aria-hidden="true" />}
                <strong>{STANCE_LABEL[stance]}</strong>
                {scene.verdictNow ? <span>现在主张：<VerdictStamp verdict={scene.verdictNow} /></span> : null}
              </div>
            ) : null}
          </div>
        </>
      );
    }
    case 'failed':
      return (
        <Heading step={scene.failure.round === 2 ? '第 2 轮辩论' : '挑刺'} title={`${names[scene.failure.reviewer]} 这一轮没有给出可用意见`}
          note={`${FAILED_REASON_LABEL[scene.failure.reason]}。其他评审的意见照常交给${names.S}。`} />
      );
    case 'writing':
      return (
        <>
          <Heading step="汇总裁决" title={`${names.S}正在汇总意见、写修订稿`} note="下面是汇总要做的事；裁决会一条一条宣读。" />
          <ul className={styles.todo}>
            <li>合并重复的意见，按严重程度排好</li>
            <li>每条意见都回到报告原文核实</li>
            <li>有冲突的，先写出双方最强的理由再裁决</li>
            <li>批评压不过原文的最强理由，就保留原文</li>
          </ul>
        </>
      );
    case 'ruling': {
      const { ruling } = scene;
      return (
        <>
          <Heading step={`汇总裁决 ${scene.index + 1}/${scene.total}`} title={ruling.issue} />
          <article className={cn(styles.card, styles.ruling)} data-from="S">
            <div className={styles.cardTop}>
              <ChapterTag>{ruling.section}</ChapterTag>
              <span className={styles.raisedBy}>提出：{ruling.reviewers.map(seat => <SeatBadge key={seat} seat={seat} names={names} compact />)}</span>
              {ruling.disputed ? <span className={styles.flag}>评审之间有分歧</span> : null}
              {ruling.single ? <span className={styles.flagSoft}>只有一位评审提出</span> : null}
            </div>
            <p className={styles.opinion}>{ruling.opinion}</p>
            <p className={styles.text}><b>理由：</b>{ruling.reason}</p>
            <p className={styles.text}><b>怎么改：</b>{ruling.fix}</p>
            <span className={styles.slam} data-adopted={ruling.adopted}>
              <Gavel size={15} aria-hidden="true" />{ruling.adopted ? '写进修订稿' : '不改原文'}
            </span>
          </article>
        </>
      );
    }
    case 'revision':
      if (scene.result.type === 'revision_failed') {
        return (
          <Heading step="修订稿" title="修订稿没有生成成功"
            note={`${revisionFailedLabel(scene.result.reason)}。三位评审的意见仍可参考，下面按章节整理好了。`} />
        );
      }
      return (
        <>
          <Heading step="修订稿" title={`修订稿写好了：改了 ${scene.result.changedSections} 章，涉及 ${scene.result.changedFields} 项定位内容`}
            note="接下来由你逐章选择：采用修订版，还是保留原文。" />
          <ul className={styles.chapters}>
            {scene.result.changedSectionTitles.map((title, index) => (
              <li key={title} style={{ animationDelay: `${300 + index * 220}ms` }}>{title}</li>
            ))}
          </ul>
        </>
      );
    default:
      return null;
  }
}
