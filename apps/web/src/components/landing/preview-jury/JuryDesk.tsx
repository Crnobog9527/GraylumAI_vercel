/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { cn } from '@/lib/utils';
import { DECISION_LABEL, FAILED_REASON_LABEL, revisionFailedLabel, type JurySeatNames, type Seat, type SeatCode } from './jury-events';
import { DOSSIER_SEATS } from './JuryDossier';
import type { DeskView } from './jury-desk';
import { seatStates } from './jury-desk';
import type { Scene } from './jury-scenes';
import { SeatMark } from './JuryBits';
import { JuryDocument } from './JuryDocument';
import type { PeekHandlers } from './JuryMargin';
import styles from './jury-desk.module.css';

type Caption = { step?: string; title: string; note?: string };

/** "评审 A 的批注" but "首席主笔的批注": a space only after a name ending in a Latin letter or digit. */
const of = (name: string) => (/[A-Za-z0-9]$/.test(name) ? `${name} ` : name);

/** What the stage is doing, in one line plus a short explanation. */
export function sceneCaption(scene: Scene | null, names: JurySeatNames): Caption {
  switch (scene?.kind) {
    case 'reading':
      return scene.round === 1
        ? { step: '第 1 轮', title: '三位评审各自审阅，互相看不到对方的意见', note: '评审交卷后，意见才会出现在页边。' }
        : { step: '第 2 轮', title: '每位评审读完别人的第 1 轮意见，准备回复', note: '回复会接在有分歧的批注下面。' };
    case 'steelman':
      return {
        step: `钢人判断 ${scene.index + 1}/4`, title: `关键决定「${DECISION_LABEL[scene.decision]}」`,
        note: '每位评审先把报告原来的选择讲到最强，再讲最强的另一种做法，然后决定保留还是改。',
      };
    case 'critique':
      return { step: '挑刺', title: `${of(names[scene.seat])}的批注（${scene.issues.length} 条）`, note: '每条都写明哪一章、从谁的角度看、为什么、怎么改。' };
    case 'divergence':
      return {
        step: `找分歧 ${scene.index + 1}/${scene.total}`, title: `「${DECISION_LABEL[scene.split.decision]}」上意见不一`,
        note: '有人保留、有人要改，所以开第 2 轮：双方先复述对方最强的观点，再表态。',
      };
    case 'agreed':
      return { step: '找分歧', title: '四个关键决定，三位评审意见一致', note: `没有分歧，不开第 2 轮，直接交给${names.S}。` };
    case 'response':
      return {
        step: '第 2 轮', title: `${of(names[scene.response.reviewer])}回复 ${names[scene.response.to]}`,
        note: `关于「${DECISION_LABEL[scene.response.decision]}」。`,
      };
    case 'failed':
      return {
        step: scene.failure.round === 2 ? '第 2 轮' : '挑刺', title: `${of(names[scene.failure.reviewer])}这一轮没有给出可用意见`,
        note: `${FAILED_REASON_LABEL[scene.failure.reason]}。其他评审的意见照常交给${names.S}。`,
      };
    case 'writing':
      return { step: '汇总裁决', title: `${names.S}正在通读全文和全部批注`, note: '合并重复的意见，回到原文核实；批评压不过原文的最强理由，就保留原文。' };
    case 'ruling':
      return { step: `汇总裁决 ${scene.index + 1}/${scene.total}`, title: scene.ruling.issue, note: `${names.S}逐条裁决，并写明理由。` };
    case 'revision':
      return scene.result.type === 'revision_failed'
        ? { step: '修订稿', title: '修订稿没有生成成功', note: `${revisionFailedLabel(scene.result.reason)}。评审意见仍可参考。` }
        : {
          step: '修订稿', title: `修订稿改了 ${scene.result.changedSections} 章，涉及 ${scene.result.changedFields} 项定位内容`,
          note: '删除线是删掉的，底色是新增的。接下来由你逐章决定用不用。',
        };
    default:
      return {
        title: '评审团入席', note: `三位评审会各自读完这份报告，从每一类受众和你本人的角度批注；意见不一时辩论一轮，最后由${names.S}逐条裁决、写出修订稿。`,
      };
  }
}

/**
 * The review stage: who is on the panel and what each is doing, then the report with the review's notes on it.
 * Pointing at a person (tapping on a phone) opens that person's full record beside the page.
 */
export function JuryDesk({ scene, view, names, clock, failed, selected, ...handlers }: PeekHandlers & {
  scene: Scene | null; view: DeskView; names: JurySeatNames; clock: number; failed: readonly Seat[]; selected: SeatCode | null;
}) {
  const caption = sceneCaption(scene, names);
  const states = seatStates(scene, clock, failed, false);
  return (
    <section className={styles.desk} aria-label="评审进行中">
      <header className={styles.caption} aria-live="polite" key={`${scene?.kind}-${scene?.start}`}>
        {caption.step ? <span className={styles.step}>{caption.step}</span> : null}
        <h2>{caption.title}</h2>
        {caption.note ? <p>{caption.note}</p> : null}
      </header>
      <ul className={styles.panel} aria-label="评审团">
        {DOSSIER_SEATS.map(seat => (
          <li key={seat}>
            <button type="button" className={cn(styles.person, selected === seat && styles.selected)} data-seat={seat}
              data-tone={states[seat].tone} aria-pressed={selected === seat}
              aria-label={`${names[seat]}：${states[seat].text}。查看这位的完整记录`}
              onMouseEnter={() => handlers.onPeek(seat)} onMouseLeave={() => handlers.onPeek(null)}
              onFocus={() => handlers.onPeek(seat)} onBlur={() => handlers.onPeek(null)} onClick={() => handlers.onPick(seat)}>
              <SeatMark seat={seat} names={names} size="lg" />
              <span className={styles.who}>
                <span className={styles.name} title={names[seat]}>{names[seat]}</span>
                <span className={styles.state}>{states[seat].text}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <JuryDocument view={view} names={names} {...handlers} />
    </section>
  );
}
