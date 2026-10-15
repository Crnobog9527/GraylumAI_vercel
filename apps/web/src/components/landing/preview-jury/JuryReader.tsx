/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo, useState } from 'react';
import { ArrowDownToLine, Check, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { JuryDetail, JurySeatNames } from './jury-events';
import { keyPoints } from './jury-adopt';
import { REPORT_SECTIONS } from './jury-mock-reviews';
import { flaggedChapters, readerChapters, readingMinutes, summaryLines, type ReaderChapter } from './jury-reader';
import { useAdoption, type Adoption, type Stale } from './use-adoption';
import { useReadingProgress } from './use-reading-progress';
import { ChoiceBar, Done, Review } from './JuryReaderActions';
import { JuryReaderChapter } from './JuryReaderChapter';
import styles from './jury-reader.module.css';

type Mode = 'changes' | 'all';

/**
 * The result page as the whole report, made easy to read: first "30 秒看懂" (the report on one page, the three changes
 * that matter most, and what to do next), then the chapters as cards. Changed chapters stand out and open with only
 * what changed; the rest stay quiet. A contents list on the left tracks progress and choices; a bar at the bottom
 * confirms. The chapter-by-chapter choice in two steps is unchanged (use-adoption.ts).
 */
export function JuryReader({ detail, names }: { detail: JuryDetail; names: JurySeatNames }) {
  const failed = detail.summary.status !== 'usable';
  const chapters = useMemo(() => readerChapters(detail), [detail]);
  const flagged = flaggedChapters(chapters);
  const adoption = useAdoption(detail);
  const [mode, setMode] = useState<Mode>('changes');
  const [opened, setOpened] = useState<string[]>([]);
  const progress = useReadingProgress('jury-reader-chapters');
  const toggle = (title: string) => setOpened(list => (list.includes(title) ? list.filter(item => item !== title) : [...list, title]));
  const jump = (title: string) => {
    if (!opened.includes(title)) setOpened(list => [...list, title]);
    requestAnimationFrame(() => document.getElementById(`chapter-${title}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const nextChange = () => {
    const below = flagged.find(chapter => (document.getElementById(`chapter-${chapter.title}`)?.getBoundingClientRect().top ?? 0) > 140);
    jump((below ?? flagged[0]).title);
  };

  return (
    <div className={styles.reader}>
      <Toc chapters={chapters} adoption={failed ? null : adoption} progress={progress} onJump={jump} onNext={nextChange} />
      <div className={styles.column}>
        <Glance detail={detail} chapters={chapters} adoption={failed ? null : adoption} onJump={jump} />
        <div className={styles.modeRow}>
          <div role="radiogroup" aria-label="显示哪些章节" className={styles.mode}>
            {([['changes', failed ? '只看有意见的章节' : '只看改动'], ['all', '看全文']] as const).map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={mode === key} onClick={() => setMode(key)}>{label}</button>
            ))}
          </div>
          {failed || adoption.result ? null : <StaleSwitch value={adoption.stale} onChange={adoption.setStale} />}
        </div>
        <div className={styles.chapters} id="jury-reader-chapters">
          {chapters.map(chapter => (
            <JuryReaderChapter key={chapter.title} chapter={chapter} names={names} adoption={failed ? null : adoption}
              compact={mode === 'changes'} open={mode === 'all' || opened.includes(chapter.title)} onToggle={() => toggle(chapter.title)} />
          ))}
        </div>
        {failed ? null : adoption.result ? <Done result={adoption.result} />
          : adoption.proposal ? <Review proposal={adoption.proposal} adoption={adoption} /> : <ChoiceBar adoption={adoption} />}
      </div>
    </div>
  );
}

/** "30 秒看懂": the report on one page, the changes that matter most, and the one next step. */
function Glance({ detail, chapters, adoption, onJump }: {
  detail: JuryDetail; chapters: readonly ReaderChapter[]; adoption: Adoption | null; onJump: (title: string) => void;
}) {
  const failed = !adoption;
  const flagged = flaggedChapters(chapters).length;
  const points = keyPoints(detail, REPORT_SECTIONS);
  return (
    <section className={styles.glance} aria-labelledby="jury-glance-title">
      <h2 id="jury-glance-title">{failed ? '修订稿没有生成成功，原文没有任何改动' : '30 秒看懂'}</h2>
      <dl className={styles.onePage}>
        {summaryLines(detail).map(line => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.text}{line.revised ? <span className={styles.revisedMark}>修订后</span> : null}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.top3}>
        <h3>{failed ? `评审对 ${flagged} 章提了意见，最要紧的 ${points.length} 条` : `评审改了 ${flagged} 章，最重要的 ${points.length} 条`}</h3>
        <ol>
          {points.map(point => (
            <li key={point.text}>
              <button type="button" onClick={() => onJump(point.section)}>
                <span className={styles.pointText}>{point.text}</span>
                <span className={styles.pointWhere}>{point.section}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <p className={styles.next}>
        <span>
          {failed ? `下面标亮的 ${flagged} 章有评审意见，你可以照着自己修改，或者重新发起一次评审。`
            : `看完标亮的 ${flagged} 章，逐章选择采用或保留，选完点「确认」。`}
        </span>
        <span className={styles.nextFacts}>
          {adoption ? <b>已选 {adoption.done}/{adoption.total}</b> : null}
          <span>预计阅读约 {readingMinutes(detail, chapters)} 分钟</span>
        </span>
      </p>
    </section>
  );
}

/** The contents on the left: every chapter, changed ones marked with whether they are chosen yet. */
function Toc({ chapters, adoption, progress, onJump, onNext }: {
  chapters: readonly ReaderChapter[]; adoption: Adoption | null; progress: number; onJump: (title: string) => void; onNext: () => void;
}) {
  return (
    <nav className={styles.toc} aria-label="报告目录">
      <button type="button" className={styles.nextChange} onClick={onNext}>
        <ArrowDownToLine size={15} aria-hidden="true" />跳到下一处{adoption ? '改动' : '意见'}
      </button>
      <div className={styles.progress} aria-label={`已读 ${Math.round(progress * 100)}%`}>
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
      <ol>
        {chapters.map(chapter => {
          const flagged = Boolean(chapter.section?.changed || chapter.issues.length > 0);
          const chosen = Boolean(adoption?.state[chapter.title]?.use);
          return (
            <li key={chapter.title} data-flagged={flagged}>
              <button type="button" onClick={() => onJump(chapter.title)}>
                <span className={styles.tocTitle}>{chapter.title}</span>
                {flagged && adoption ? (
                  <span className={cn(styles.tocState, chosen && styles.tocChosen)}>
                    {chosen ? <Check size={12} aria-hidden="true" /> : <Circle size={10} aria-hidden="true" />}{chosen ? '已选' : '未选'}
                  </span>
                ) : flagged ? <span className={styles.tocState}>有意见</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StaleSwitch({ value, onChange }: { value: Stale; onChange: (value: Stale) => void }) {
  return (
    <label className={styles.prototype}>
      原型：模拟提交被拒
      <select value={value} onChange={event => onChange(event.target.value as Stale)}>
        <option value="none">不模拟</option>
        <option value="report">评审之后改过草稿</option>
        <option value="proposal">确认前内容有更新</option>
      </select>
    </label>
  );
}
