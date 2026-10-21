/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp, FileText, Pause, Play, RotateCcw } from 'lucide-react';
import { MentorMarkdown } from '@/app/(zh-hans)/app/positioning/[draftId]/MentorMarkdown';
import result from '@/components/opc/positioning-result.module.css';
import { J_SAMPLES } from '@/lib/landing/landing-copy-j-samples';
import { loadSampleReport, SAMPLE_CHAPTERS, type SampleData } from '@/lib/landing/sample-reports';
import { splitReport } from '@/lib/landing/sample-reports/report-markdown';
import styles from './samples-j.module.css';
import page from './j.module.css';

/** How long each key chapter stays the newest while the overview plays (five chapters: about fifteen seconds). */
export const OVERVIEW_STEP_MS = 3000;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * The four sample reports, in three layers (Owner 2026-10-15, round seven): "10 秒看懂", one card that says who this is,
 * what they post for whom, how it earns and this week's first step (the student's leads with the coach's warning);
 * "15 秒看清概览", the five chapters that matter most, lit one after another with one conclusion each (pause it or
 * pick one); and the whole report, with a chapter list that jumps within it. The caller shows this block only in a
 * local preview or behind the flag. Server HTML and reduced motion show every layer finished.
 * Its own module since 2026-10-16 (Owner): after "AI 教练怎么接手你的运营", on that module's backdrop.
 */
export function SamplesSectionJ() {
  return (
    <section aria-label={J_SAMPLES.title} className={page.section} data-zone="takeover" data-region="样例报告">
      <div className={page.wrap}><SamplesJ /></div>
    </section>
  );
}

export function SamplesJ() {
  const [active, setActive] = useState(0);
  // A report the visitor picked plays its overview at once; the first one waits until it scrolls into view.
  const [picked, setPicked] = useState(false);
  const report = J_SAMPLES.reports[active];
  const data = SAMPLE_CHAPTERS[report.slug];
  return (
    <div className={styles.samples}>
      <div className={styles.head}>
        <h2 className={page.display}>{J_SAMPLES.title}</h2>
        <p>{J_SAMPLES.lede}</p>
      </div>
      <div role="tablist" aria-label="样例报告" className={styles.tabs}>
        {J_SAMPLES.reports.map((item, index) => (
          <button key={item.slug} type="button" role="tab" aria-selected={index === active} onClick={() => { setActive(index); setPicked(true); }}>
            <b>{item.who}</b><span>{item.platform}</span>{item.truth ? <em>{J_SAMPLES.truthTag}</em> : null}
          </button>
        ))}
      </div>
      <article key={report.slug} role="tabpanel" aria-label={`${report.who} · ${report.platform}`} className={styles.report}>
        <header className={styles.cover}>
          <FileText size={22} aria-hidden="true" />
          <div>
            <p className={styles.coverLabel}>{J_SAMPLES.coverLabel}{report.truth ? <em>{J_SAMPLES.truthTag}</em> : null}</p>
            <h4>{report.who} · {report.platform}</h4>
            <p className={styles.size}>{J_SAMPLES.size} · {J_SAMPLES.generated(data.generatedAt)}</p>
          </div>
        </header>
        <Glance data={data} />
        <Overview data={data} start={picked} />
        <FullReport slug={report.slug} />
      </article>
    </div>
  );
}

/** "10 秒看懂": who, what for whom, how it earns, this week's first step; the coach's warning first where there is one. */
export function Glance({ data }: { data: SampleData }) {
  const { glance } = J_SAMPLES;
  const rows: [string, string, boolean][] = [
    [glance.who, data.summary.who, false],
    ...(data.summary.truth ? [[glance.truth, data.summary.truth, true] as [string, string, boolean]] : []),
    [glance.what, data.summary.what, false],
    [glance.money, data.summary.money, false],
    [glance.first, data.summary.first, false],
  ];
  return (
    <section className={styles.glance} aria-label={glance.title}>
      <p className={styles.layerTitle}>{glance.title}</p>
      <dl>
        {rows.map(([label, text, truth]) => (
          <div key={label} data-truth={truth || undefined}><dt>{label}</dt><dd>{text}</dd></div>
        ))}
      </dl>
    </section>
  );
}

/**
 * "15 秒看清概览": the five key chapters light up one by one while the block is on screen; the visitor can pause, play
 * on, replay or pick one (which pauses it); a report picked from the tabs plays at once. Reduced motion and the server
 * HTML show all five lit.
 */
function Overview({ data, start }: { data: SampleData; start: boolean }) {
  const { overview, chapters } = J_SAMPLES;
  const picks = overview.picks;
  const ref = useRef<HTMLElement>(null);
  // How many are lit; null before the page knows it may animate (everything shows).
  const [lit, setLit] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [seen, setSeen] = useState(false);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    setLit(0);
    if (start) { setSeen(true); setPlaying(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setSeen(true); setPlaying(true); observer.disconnect(); }
    }, { threshold: 0.25 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [start]);
  useEffect(() => {
    if (!seen || !playing || lit === null) return;
    if (lit >= picks.length) { setPlaying(false); return; }
    const timer = window.setTimeout(() => { setCurrent(lit); setLit(lit + 1); }, lit === 0 ? 300 : OVERVIEW_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [seen, playing, lit, picks.length]);

  const shown = lit ?? picks.length;
  const done = shown >= picks.length;
  const pick = (index: number) => { setPlaying(false); setLit(Math.max(shown, index + 1)); setCurrent(index); };
  const toggle = () => {
    if (done && !playing) { setLit(0); setCurrent(0); setPlaying(true); return; }
    setPlaying(value => !value);
  };
  return (
    <section ref={ref} className={styles.overview} aria-label={overview.title}>
      <div className={styles.overviewHead}>
        <p className={styles.layerTitle}>{overview.title}<span>{overview.lede}</span></p>
        {lit !== null ? (
          <button type="button" className={styles.control} onClick={toggle}>
            {playing ? <Pause size={14} aria-hidden="true" /> : done ? <RotateCcw size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
            {playing ? overview.pause : done ? overview.replay : overview.play}
          </button>
        ) : null}
      </div>
      <ol className={styles.keys}>
        {picks.map((chapter, index) => (
          <li key={chapter} data-lit={index < shown || undefined} data-current={(lit !== null && index === current && index < shown) || undefined}
            style={{ '--i': index } as CSSProperties}>
            <button type="button" onClick={() => pick(index)} aria-pressed={index < shown}>
              <b>{chapters[chapter]}</b>
              <span>{data.chapters[chapter]?.key}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The whole report, opened in place: a chapter list that jumps within it, the text scrolling on its own. */
export function FullReport({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const panelId = useId();
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || text !== null) return;
    let live = true;
    void loadSampleReport(slug).then(markdown => { if (live) setText(markdown); });
    return () => { live = false; };
  }, [open, slug, text]);
  const parts = text ? splitReport(text).chapters : [];
  const jump = (index: number) => {
    const box = body.current;
    const target = box?.querySelector<HTMLElement>(`[data-chapter-index="${index}"]`);
    if (box && target) box.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' });
  };
  return (
    <>
      <button type="button" className={styles.more} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
        {open ? J_SAMPLES.full.close : J_SAMPLES.full.open}
        {open ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
      </button>
      <div id={panelId} className={styles.full} hidden={!open}>
        {text === null ? <p className={styles.loading}>{J_SAMPLES.full.loading}</p> : (
          <>
            <nav className={styles.fullToc} aria-label={J_SAMPLES.full.toc}>
              {J_SAMPLES.chapters.map((title, index) => (
                <button key={title} type="button" onClick={() => jump(index)}>{title}</button>
              ))}
            </nav>
            <div ref={body} className={styles.fullBody} tabIndex={0}>
              {parts.map((chapter, index) => (
                <section key={chapter.heading} data-chapter-index={index}>
                  <h5>{chapter.heading}</h5>
                  <MentorMarkdown className={result.messageBody} text={chapter.markdown} live={false} />
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
