/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useMemo, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDownToLine, Check, Circle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { JuryDetail, JurySeatNames } from './jury-events';
import { keyPoints } from './jury-adopt';
import {
  flaggedChapters, keptAsIs, MOCK_READER_SOURCE, readerChapters, readingMinutes, sectionOrder, summaryLines, type ReaderChapter, type ReaderSource,
} from './jury-reader';
import { MOCK_ADOPT_ACTIONS, useAdoption, type Adoption, type AdoptActions, type Stale } from './use-adoption';
import { useReadingProgress } from './use-reading-progress';
import { ChoiceBar, Done, Review } from './JuryReaderActions';
import { JuryReaderChapter } from './JuryReaderChapter';
import styles from './jury-reader.module.css';
import { DisplayHeading } from '@/components/chat-display/display-heading';

type Mode = 'changes' | 'all';

/**
 * The result page as the whole report, made easy to read: first "30 秒看懂" (the report on one page, the three changes
 * that matter most, and what to do next), then the chapters as cards. Changed chapters stand out and open with only
 * what changed; the rest stay quiet. A contents list on the left tracks progress and choices; a bar at the bottom
 * confirms. The chapter-by-chapter choice in two steps is unchanged (use-adoption.ts). `scrollRoot` is the box the
 * page scrolls in when it is not the window (the landing page's frame): jumps and reading progress then move that box
 * only, never the page around it.
 */
export function JuryReader({ detail, names, source = MOCK_READER_SOURCE, actions = MOCK_ADOPT_ACTIONS, tools, scrollRoot }: {
  detail: JuryDetail; names: JurySeatNames;
  /** The reviewed report and its reading aids; the prototype's mock creator by default. */
  source?: ReaderSource;
  /** adopt / confirmAdoption; mock answers by default. */
  actions?: AdoptActions;
  /** Extra controls next to the mode switch (the prototype's simulated refusals). */
  tools?: ReactNode;
  scrollRoot?: RefObject<HTMLElement | null>;
}) {
  const failed = detail.summary.status !== 'usable';
  const chapters = useMemo(() => readerChapters(detail, source), [detail, source]);
  const flagged = flaggedChapters(chapters);
  const adoption = useAdoption(detail, actions);
  // Choosing only applies to a revision; a usable summary that changed nothing has nothing to choose.
  const choosing = !failed && adoption.total > 0 ? adoption : null;
  const [mode, setMode] = useState<Mode>('changes');
  const [opened, setOpened] = useState<string[]>([]);
  const progress = useReadingProgress('jury-reader-chapters', scrollRoot);
  /** Where the reading line is: the top of the scrolling box (or of the window, under its sticky bar). */
  const lineTop = () => (scrollRoot?.current?.getBoundingClientRect().top ?? 0) + (scrollRoot?.current ? 24 : 140);
  const toggle = (title: string) => setOpened(list => (list.includes(title) ? list.filter(item => item !== title) : [...list, title]));
  const jump = (title: string) => {
    if (!opened.includes(title)) setOpened(list => [...list, title]);
    requestAnimationFrame(() => {
      const node = document.getElementById(`chapter-${title}`);
      const box = scrollRoot?.current;
      if (!node) return;
      if (!box) { node.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12;
      box.scrollTo({ top, behavior: 'smooth' });
    });
  };
  const nextChange = () => {
    if (flagged.length === 0) return;
    const below = flagged.find(chapter => (document.getElementById(`chapter-${chapter.title}`)?.getBoundingClientRect().top ?? 0) > lineTop());
    jump((below ?? flagged[0]).title);
  };

  return (
    <div className={styles.reader}>
      <Toc chapters={chapters} adoption={choosing} failed={failed} progress={progress} onJump={jump}
        onNext={flagged.length > 0 ? nextChange : null} />
      <div className={styles.column}>
        <Glance detail={detail} chapters={chapters} source={source} adoption={choosing} failed={failed} onJump={jump} />
        <div className={styles.modeRow}>
          <div role="radiogroup" aria-label="显示哪些章节" className={styles.mode}>
            {([['changes', failed ? '只看有意见的章节' : '只看改动'], ['all', '看全文']] as const).map(([key, label]) => (
              <button key={key} type="button" role="radio" aria-checked={mode === key} onClick={() => setMode(key)}>{label}</button>
            ))}
          </div>
          {failed || adoption.result ? null : tools}
        </div>
        <div className={styles.chapters} id="jury-reader-chapters">
          {chapters.map(chapter => (
            <JuryReaderChapter key={chapter.title} chapter={chapter} names={names} adoption={choosing}
              compact={mode === 'changes'} open={mode === 'all' || opened.includes(chapter.title)} onToggle={() => toggle(chapter.title)} />
          ))}
        </div>
        {!choosing ? null : choosing.result ? <Done result={choosing.result} />
          : choosing.proposal ? <Review proposal={choosing.proposal} adoption={choosing} /> : <ChoiceBar adoption={choosing} />}
      </div>
    </div>
  );
}

/** "30 秒看懂": the report on one page, the changes that matter most, and the one next step. */
function Glance({ detail, chapters, source, adoption, failed, onJump }: {
  detail: JuryDetail; chapters: readonly ReaderChapter[]; source: ReaderSource; adoption: Adoption | null; failed: boolean;
  onJump: (title: string) => void;
}) {
  const flagged = flaggedChapters(chapters).length;
  const points = keyPoints(detail, sectionOrder(source));
  const lines = summaryLines(detail, source);
  return (
    <section className={styles.glance} aria-labelledby="jury-glance-title">
      <DisplayHeading as="h2" id="jury-glance-title">{!failed ? '30 秒看懂' : keptAsIs(detail) ? '评审团认为这份报告不需要修改'
        : '修订稿没有生成成功，原文没有任何改动'}</DisplayHeading>
      {lines.length > 0 ? <dl className={styles.onePage}>
        {lines.map(line => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.text}{line.revised ? <span className={styles.revisedMark}>修订后</span> : null}</dd>
          </div>
        ))}
      </dl> : null}
      {points.length > 0 ? <div className={styles.top3}>
        <DisplayHeading as="h3">{failed ? `评审对 ${flagged} 章提了意见，最要紧的 ${points.length} 条` : `评审改了 ${flagged} 章，最重要的 ${points.length} 条`}</DisplayHeading>
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
      </div> : null}
      <p className={styles.next}>
        <span>
          {failed && keptAsIs(detail) ? (flagged ? `下面标亮的 ${flagged} 章有评审的小意见，供你参考；报告保持原样。` : '报告保持原样。')
            : failed ? `下面标亮的 ${flagged} 章有评审意见，你可以照着自己修改，或者重新发起一次评审。`
            : adoption?.result ? `这次评审已经选过了，下面标亮的 ${flagged} 章显示的是最后用的版本。`
            : adoption ? `看完标亮的 ${flagged} 章，逐章选择采用或保留，选完点「确认」。请注意甄别是否采纳修订意见：评审的意见不一定都对。`
              : '评审团认为这份报告不需要修改，下面是他们对各章的意见。'}
        </span>
        <span className={styles.nextFacts}>
          {adoption ? <b>已选 {adoption.done}/{adoption.total}</b> : null}
          <span>预计阅读约 {readingMinutes(detail, chapters, source)} 分钟</span>
        </span>
      </p>
    </section>
  );
}

/** The contents on the left: every chapter, changed ones marked with whether they are chosen yet. */
function Toc({ chapters, adoption, failed, progress, onJump, onNext }: {
  chapters: readonly ReaderChapter[]; adoption: Adoption | null; failed: boolean; progress: number; onJump: (title: string) => void;
  /** Null when no chapter is flagged: there is nowhere to jump (#1004). */
  onNext: (() => void) | null;
}) {
  return (
    <nav className={styles.toc} aria-label="报告目录">
      {onNext ? (
        <button type="button" className={styles.nextChange} onClick={onNext}>
          <ArrowDownToLine size={15} aria-hidden="true" />跳到下一处{failed ? '意见' : '改动'}
        </button>
      ) : null}
      <div className={styles.progress} aria-label={`已读 ${Math.round(progress * 100)}%`}>
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
      <ol>
        {chapters.map(chapter => {
          const flagged = Boolean(chapter.section?.changed || chapter.issues.length > 0);
          const waiting = Boolean(adoption?.unconfirmed.includes(chapter.title));
          const chosen = Boolean(adoption?.state[chapter.title]?.use) && !waiting;
          return (
            <li key={chapter.title} data-flagged={flagged}>
              <button type="button" onClick={() => onJump(chapter.title)}>
                <span className={styles.tocTitle}>{chapter.title}</span>
                {flagged && adoption ? (
                  <span className={cn(styles.tocState, chosen && styles.tocChosen)}>
                    {chosen ? <Check size={12} aria-hidden="true" /> : <Circle size={10} aria-hidden="true" />}{chosen ? '已选' : waiting ? '待确认' : '未选'}
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

export function StaleSwitch({ value, onChange }: { value: Stale; onChange: (value: Stale) => void }) {
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
