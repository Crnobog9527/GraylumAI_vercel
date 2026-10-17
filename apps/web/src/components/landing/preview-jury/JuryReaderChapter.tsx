/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { ChevronDown, Gavel, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DetailIssue, DetailSection, JurySeatNames, RulingFields, Seat } from './jury-events';
import { firstSentence, needsConfirm } from './jury-adopt';
import { changeHunks, type Hunk } from './jury-hunks';
import type { ReaderChapter } from './jury-reader';
import type { Adoption } from './use-adoption';
import { SeatBadge, SeverityTag } from './JuryBits';
import styles from './jury-reader.module.css';
import { DisplayHeading } from '@/components/chat-display/display-heading';


/**
 * One chapter of the report. A changed chapter stands out and opens by default: what changed and why in one line,
 * then only the changed sentences with one sentence of context, then the choice. An unchanged chapter is quiet: in
 * "only changes" it is one line, otherwise what it says and two or three points, the full text on request.
 */
export function JuryReaderChapter({ chapter, names, adoption, compact, open, onToggle }: {
  chapter: ReaderChapter; names: JurySeatNames; adoption: Adoption | null; compact: boolean; open: boolean; onToggle: () => void;
}) {
  const { title, digest, section, issues } = chapter;
  const changed = Boolean(section?.changed);
  const flagged = changed || issues.length > 0;
  const id = `chapter-${title}`;
  if (!flagged && compact && !open) {
    return (
      <article className={styles.chapter} data-tone="quiet" id={id}>
        <button type="button" className={styles.line} onClick={onToggle} aria-expanded={false}>
          <span className={styles.lineTitle}>{title}</span>
          <span className={styles.lineGist}>{digest.gist}</span>
          {(section?.rulings.length ?? 0) > 0 ? <span className={styles.lineTag}>有意见，没改</span> : null}
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </article>
    );
  }
  return (
    <article className={cn(styles.chapter)} data-tone={changed ? 'changed' : issues.length > 0 ? 'issues' : 'quiet'} id={id}>
      <header className={styles.chapterHead}>
        <DisplayHeading as="h3">{title}</DisplayHeading>
        {changed ? <span className={styles.tag} data-tone="changed">修订稿改了这一章</span> : null}
        {section?.wordingOnly ? <span className={styles.tag}>只改了表述</span> : null}
        {!changed && (section?.rulings.length ?? 0) > 0 ? <span className={styles.tag}>有意见，没改</span> : null}
        {issues.length > 0 ? <span className={styles.tag} data-tone="changed">{issues.length} 条评审意见</span> : null}
        {/* In 看全文 every chapter is open, so there is nothing to fold. */}
        {!flagged && compact ? (
          <button type="button" className={styles.fold} onClick={onToggle} aria-expanded={open}>{open ? '收起' : '展开'}</button>
        ) : null}
      </header>
      {changed && section ? <Changed section={section} names={names} adoption={adoption} full={!compact} /> : (
        <>
          <p className={styles.gist}>{digest.gist}</p>
          <ul className={styles.points}>{digest.points.map(point => <li key={point}>{point}</li>)}</ul>
          {issues.length > 0 ? <Issues issues={issues} names={names} /> : null}
          {(section?.rulings.length ?? 0) > 0 ? <Rulings rulings={section?.rulings ?? []} names={names} /> : null}
          {flagged || open ? <FullText body={chapter.body} expanded={!compact} /> : null}
        </>
      )}
    </article>
  );
}

/** The chapter's own text: shown in place in 看全文 (the whole report, one click away), behind a fold otherwise. */
function FullText({ body, expanded }: { body: string; expanded: boolean }) {
  if (!body) return null;
  if (expanded) return <p className={styles.fullText}>{body}</p>;
  return (
    <details className={styles.more}>
      <summary>看这一章全文</summary>
      <p className={styles.fullText}>{body}</p>
    </details>
  );
}

function Changed({ section, names, adoption, full }: {
  section: DetailSection; names: JurySeatNames; adoption: Adoption | null; full: boolean;
}) {
  const primary = section.rulings.find(item => item.adopted) ?? section.rulings[0];
  const hunks = changeHunks(section.original ?? '', section.revised ?? '');
  const choice = adoption?.state[section.section];
  return (
    <>
      {primary ? (
        <div className={styles.why}>
          <p><b>改了什么</b>{primary.opinion}</p>
          <p><b>为什么</b>{firstSentence(primary.reason)}</p>
        </div>
      ) : null}
      {full ? <WholeRevision hunks={hunks} /> : (
      <div className={styles.compare}>
        {hunks.map((hunk, index) => hunk.type === 'context' ? <p key={index} className={styles.context}>{hunk.text}</p>
          : hunk.type === 'folded' ? <Folded key={index} count={hunk.count} text={hunk.text} />
            : (
              <div key={index} className={styles.change}>
                {hunk.before ? <p data-side="before"><span>改前</span>{hunk.before}</p> : null}
                {hunk.after ? <p data-side="after"><span>改后</span>{hunk.after}</p> : null}
              </div>
            ))}
      </div>
      )}
      {section.fields.length > 0 ? (
        <ul className={styles.fields} aria-label="涉及的定位内容">
          {section.fields.map(item => (
            <li key={`${item.stepId}.${item.fieldId}`}><s>{item.before}</s><span aria-hidden="true">→</span><b>{item.after}</b></li>
          ))}
        </ul>
      ) : null}
      <Rulings rulings={section.rulings} names={names} />
      {adoption ? (
        <fieldset className={styles.choice} disabled={adoption.locked}>
          <legend>这一章用哪个版本？</legend>
          <div className={styles.choiceRow}>
            {(['revised', 'original'] as const).map(use => (
              <label key={use} className={styles.option} data-checked={choice?.use === use}>
                <input type="radio" name={`choice-${section.section}`} checked={choice?.use === use}
                  onChange={() => adoption.use(section.section, use)} />
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
            <label className={cn(styles.confirm, needsConfirm(section, adoption.state) && styles.confirmNeeded)}>
              <input type="checkbox" checked={Boolean(choice.confirmed)}
                onChange={event => adoption.setConfirmed(section.section, event.target.checked)} />
              我看过对比，确认这一章只改了表述，不改变定位事实
            </label>
          ) : null}
        </fieldset>
      ) : null}
    </>
  );
}

/** "看全文": the chapter's whole revised text in one piece, deleted sentences struck through, new ones marked. */
function WholeRevision({ hunks }: { hunks: Hunk[] }) {
  return (
    <p className={styles.whole} aria-label="修订后全文，删掉的句子划线，新增的句子标亮">
      {hunks.map((hunk, index) => hunk.type === 'change' ? (
        <span key={index}>{hunk.before ? <del>{hunk.before}</del> : null}{hunk.after ? <mark>{hunk.after}</mark> : null}</span>
      ) : <span key={index}>{hunk.text}</span>)}
    </p>
  );
}

function Folded({ count, text }: { count: number; text: string }) {
  return (
    <details className={styles.folded}>
      <summary>其余 {count} 句没有改动</summary>
      <p className={styles.context}>{text}</p>
    </details>
  );
}

/** The panel's rulings on a chapter, folded: who raised it, the final opinion, why, how to change it. */
function Rulings({ rulings, names }: { rulings: RulingFields[]; names: JurySeatNames }) {
  if (rulings.length === 0) return null;
  return (
    <details className={styles.more}>
      <summary>评审意见（{rulings.length} 条）</summary>
      <ul className={styles.rulings}>
        {rulings.map(ruling => (
          <li key={ruling.issue}>
            <p className={styles.rulingIssue}>{ruling.issue}</p>
            <p>{ruling.opinion}</p>
            <dl><dt>理由</dt><dd>{ruling.reason}</dd><dt>建议怎么改</dt><dd>{ruling.fix}</dd></dl>
            <div className={styles.meta}>
              <span>提出：{ruling.reviewers.map(seat => <SeatBadge key={seat} seat={seat} names={names} compact />)}</span>
              {ruling.disputed ? <span className={styles.tag} data-tone="changed">有分歧，已辩论</span> : null}
              <span className={styles.decided}><Gavel size={13} aria-hidden="true" />{ruling.adopted ? '写进修订稿' : '不改原文'}</span>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Issues({ issues, names }: { issues: (DetailIssue & { seat: Seat })[]; names: JurySeatNames }) {
  return (
    <ul className={styles.rulings}>
      {issues.map(item => (
        <li key={item.problem}>
          <div className={styles.meta}><SeatBadge seat={item.seat} names={names} compact /><SeverityTag severity={item.severity} /></div>
          <p>{firstSentence(item.problem)}</p>
          <details className={styles.more}>
            <summary>为什么、怎么改</summary>
            <dl><dt>为什么</dt><dd>{item.problem}</dd><dt>建议怎么改</dt><dd>{item.suggestion}</dd></dl>
          </details>
        </li>
      ))}
    </ul>
  );
}
