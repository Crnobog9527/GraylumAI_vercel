/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BarChart3, Compass, Lightbulb, PenLine, Send, type LucideIcon } from 'lucide-react';
import { DEMO_LABEL, DEMO_STEPS, demoInformation, demoReducer, summaryDemoState } from '@/components/landing/demo/demo-script';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import result from '@/components/opc/positioning-result.module.css';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { cn } from '@/lib/utils';
import styles from './week-j.module.css';

const noop = () => undefined;
const confirmed = demoReducer(demoReducer(summaryDemoState(), { type: 'settled' }), { type: 'confirm' });
const STAGE_ICONS: readonly LucideIcon[] = [Compass, Lightbulb, PenLine, Send, BarChart3];
/** How long each step stays on screen; one week is about 12 seconds. */
export const WEEK_STEP_MS = [2600, 2600, 2400, 2000, 3000] as const;
const LAST = WEEK_STEP_MS.length - 1;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * The first screen's product window (Owner 2026-10-15, option A): a small workbench window plays one week with the
 * coach — positioning checklist ticked, three topics with the reasons, a draft, publishing, and a week later the
 * review with the trend going up and what to change. The five stage labels around the window light up with the
 * step. It loops while on screen. The server HTML and reduced motion show the last step, still.
 */
export function WeekJ() {
  const [step, setStep] = useState<number>(LAST);
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => setPlaying(entries.some(entry => entry.isIntersecting)));
    observer.observe(node);
    setStep(0);
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onPreference = () => { if (reducedMotion()) { setPlaying(false); setStep(LAST); observer.disconnect(); } };
    media?.addEventListener?.('change', onPreference);
    return () => { observer.disconnect(); media?.removeEventListener?.('change', onPreference); };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setStep(current => (current + 1) % WEEK_STEP_MS.length), WEEK_STEP_MS[step]);
    return () => window.clearTimeout(timer);
  }, [playing, step]);

  return (
    <figure ref={ref} className={styles.stage} aria-label={J_WEEK.label} data-step={step}>
      <ol className={styles.stages} aria-hidden="true">
        {J_WEEK.stages.map((stage, index) => {
          const Icon = STAGE_ICONS[index];
          return <li key={stage} data-on={index === step || undefined} data-done={index < step || undefined}><Icon size={15} strokeWidth={1.9} />{stage}</li>;
        })}
      </ol>
      <div className={styles.window} inert>
        <div className={styles.chrome}>
          <span className={styles.dots}><i /><i /><i /></span>
          <span className={styles.badge}>{DEMO_LABEL}</span>
          <span className={styles.chromeTitle}>{J_WEEK.title}</span>
        </div>
        <div className={styles.body}>
          <Panel at={0} step={step}><Positioning /></Panel>
          <Panel at={1} step={step}><Topics /></Panel>
          <Panel at={2} step={step}><Draft /></Panel>
          <Panel at={3} step={step}><Publish sent={step === 3} /></Panel>
          <Panel at={4} step={step}><Review /></Panel>
        </div>
      </div>
    </figure>
  );
}

function Panel({ at, step, children }: { at: number; step: number; children: ReactNode }) {
  return <div className={styles.panel} data-on={at === step || undefined} aria-hidden={at !== step}>{children}</div>;
}
function User({ text }: { text: string }) {
  return <p className={styles.user}>{text}</p>;
}
function Coach({ text, children }: { text: string; children?: ReactNode }) {
  return <div className={styles.coach}><span>AI 教练</span><p>{text}</p>{children}</div>;
}

function Positioning() {
  return (
    <>
      <User text={J_WEEK.position.user} />
      <Coach text={J_WEEK.position.coach}>
        <div className={cn(result.panel, styles.checklist)}>
          <CaptureChecklist steps={DEMO_STEPS.slice(0, 1)} information={demoInformation(confirmed)} valid={{ you: true }}
            edits={{}} selectedStepId="you" editable={false} manual={false} locked confirmable={() => false}
            confirmation={() => 'none'} saveState={{}} conflicts={{}} resolving={null} onEdit={noop} onComposition={noop}
            onResolve={noop} onReview={noop} onRecoverConfirmation={noop} onKeepConflict={noop} onRetrySave={noop} />
        </div>
      </Coach>
    </>
  );
}
function Topics() {
  return (
    <Coach text={J_WEEK.topics.coach}>
      <ol className={styles.topics}>
        {J_WEEK.topics.items.map(item => <li key={item.title}><b>{item.title}</b><span>{item.why}</span></li>)}
      </ol>
      <p className={styles.why}>{J_WEEK.topics.why}</p>
    </Coach>
  );
}
function Draft() {
  return (
    <>
      <User text={J_WEEK.draft.user} />
      <Coach text={J_WEEK.draft.coach}>
        <div className={styles.doc}>
          <p className={styles.docTitle}>{J_WEEK.draft.title}</p>
          {J_WEEK.draft.lines.map(line => <p key={line}>{line}</p>)}
        </div>
      </Coach>
    </>
  );
}
function Publish({ sent }: { sent: boolean }) {
  return (
    <Coach text={J_WEEK.publish.coach}>
      <div className={styles.publish}>
        <p className={styles.docTitle}>{J_WEEK.publish.title}</p>
        <ul>
          {J_WEEK.publish.platforms.map(platform => (
            <li key={platform.name}><Checkbox checked={platform.on} tabIndex={-1} />{platform.name}</li>
          ))}
        </ul>
        <Button size="sm" className={styles.send} data-sent={sent || undefined} tabIndex={-1}>
          <span className={styles.sendIdle}>{J_WEEK.publish.action}</span>
          <span className={styles.sendDone}>{J_WEEK.publish.done}</span>
        </Button>
      </div>
    </Coach>
  );
}
function Review() {
  return (
    <Coach text={J_WEEK.review.coach}>
      <div className={styles.review}>
        <p className={styles.docTitle}>{J_WEEK.review.title}</p>
        <div className={styles.trend}>
          <span>{J_WEEK.review.trend}</span>
          <svg viewBox="0 0 200 60" preserveAspectRatio="none" aria-hidden="true">
            <path className={styles.trendFill} d="M0 54 C 40 52 60 46 90 40 S 150 18 200 8 L 200 60 L 0 60 Z" />
            <path className={styles.trendLine} d="M0 54 C 40 52 60 46 90 40 S 150 18 200 8" />
          </svg>
        </div>
        <dl>{J_WEEK.review.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </div>
    </Coach>
  );
}
