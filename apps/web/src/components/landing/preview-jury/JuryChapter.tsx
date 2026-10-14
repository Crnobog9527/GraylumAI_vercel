/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Gavel, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DetailSection, JurySeatNames, RulingFields } from './jury-events';
import { needsConfirm, type ChoiceState, type Use } from './jury-adopt';
import { SeatBadge } from './JuryBits';
import styles from './jury-results.module.css';

/** One ruling, written so it reads on its own: the panel's opinion, why, and what to change, with who raised it. */
function Ruling({ ruling, names }: { ruling: RulingFields; names: JurySeatNames }) {
  return (
    <li className={styles.ruling}>
      <p className={styles.issue}>{ruling.issue}</p>
      <p className={styles.opinion}>{ruling.opinion}</p>
      <dl className={styles.why}>
        <dt>理由</dt><dd>{ruling.reason}</dd>
        <dt>建议怎么改</dt><dd>{ruling.fix}</dd>
      </dl>
      <div className={styles.meta}>
        <span className={styles.raised}>提出：{ruling.reviewers.map(seat => <SeatBadge key={seat} seat={seat} names={names} compact />)}</span>
        {ruling.disputed ? <span className={styles.flag}>评审之间有分歧，已辩论</span> : null}
        {ruling.single ? <span className={styles.flagSoft}>只有一位评审提出</span> : null}
        <span className={styles.decided} data-adopted={ruling.adopted}>
          <Gavel size={13} aria-hidden="true" />{names.S}：{ruling.adopted ? '写进修订稿' : '不改原文'}
        </span>
      </div>
    </li>
  );
}

/**
 * A chapter of the result page: what the panel concluded about it and, when the revision changed it, the user's
 * choice between the revision and the original, with both texts side by side on request.
 */
export function JuryChapter({ section, names, state, locked, onUse, onConfirm }: {
  section: DetailSection; names: JurySeatNames; state: ChoiceState; locked: boolean;
  onUse: (use: Use) => void; onConfirm: (confirmed: boolean) => void;
}) {
  const choice = state[section.section];
  const name = `choice-${section.section}`;
  return (
    <article className={cn(styles.chapter, section.changed && styles.chapterChanged)} id={`chapter-${section.section}`}>
      <header className={styles.chapterHead}>
        <h3>{section.section}</h3>
        <span className={styles.changeTag} data-changed={section.changed}>{section.changed ? '修订稿改了这一章' : '修订稿没改这一章'}</span>
        {section.wordingOnly ? <span className={styles.flagSoft}>只改了表述</span> : null}
      </header>
      {section.rulings.length > 0 ? (
        <ul className={styles.rulings}>{section.rulings.map(item => <Ruling key={item.issue} ruling={item} names={names} />)}</ul>
      ) : null}

      {section.changed ? (
        <>
          <details className={styles.compare}>
            <summary>对比原文和修订版{section.fields.length > 0 ? `（涉及 ${section.fields.length} 项定位内容）` : ''}</summary>
            <div className={styles.compareGrid}>
              <div><p className={styles.compareLabel}>原文</p><p className={styles.compareText}>{section.original}</p></div>
              <div><p className={styles.compareLabel}>修订版</p><p className={cn(styles.compareText, styles.revised)}>{section.revised}</p></div>
            </div>
            {section.fields.length > 0 ? (
              <ul className={styles.fields}>
                {section.fields.map(item => (
                  <li key={`${item.stepId}.${item.fieldId}`}><s>{item.before}</s><span aria-hidden="true">→</span><b>{item.after}</b></li>
                ))}
              </ul>
            ) : null}
          </details>

          <fieldset className={styles.choice} disabled={locked}>
            <legend>这一章用哪个版本？</legend>
            <div className={styles.choiceRow}>
              {(['revised', 'original'] as const).map(use => (
                <label key={use} className={styles.option} data-checked={choice?.use === use}>
                  <input type="radio" name={name} checked={choice?.use === use} onChange={() => onUse(use)} />
                  {use === 'revised' ? '采用修订版' : '保留原文'}
                </label>
              ))}
            </div>
            {section.linkedSections.length > 0 ? (
              <p className={styles.linked}>
                <Link2 size={14} aria-hidden="true" />和{section.linkedSections.join('、')}共用同一项定位内容，会一起切换。
              </p>
            ) : null}
            {section.wordingOnly && choice?.use === 'revised' ? (
              <label className={cn(styles.confirm, needsConfirm(section, state) && styles.confirmNeeded)}>
                <input type="checkbox" checked={Boolean(choice.confirmed)} onChange={event => onConfirm(event.target.checked)} />
                我看过对比，确认这一章只改了表述，不改变定位事实
              </label>
            ) : null}
          </fieldset>
        </>
      ) : section.rulings.length > 0 ? <p className={styles.keptNote}>这一章保留原文，不用选择。</p> : null}
    </article>
  );
}
