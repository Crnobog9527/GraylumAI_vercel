/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { FileText } from 'lucide-react';
import k from '@/components/landing/preview-k/k.module.css';
import { OpsChatL } from '@/components/landing/preview-l/OpsChatL';
import { Glance } from '@/components/landing/preview-j/SamplesJ';
import { WeekJ } from '@/components/landing/preview-j/WeekJ';
import samples from '@/components/landing/preview-j/samples-j.module.css';
import { J_PERSONA } from '@/lib/landing/landing-copy-j-persona';
import { J_REPORT } from '@/lib/landing/landing-copy-j-takeover';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { K_PLAN_CARD } from '@/lib/landing/landing-copy-k';
import { L_HERO_FLOW, L_OPS } from '@/lib/landing/landing-copy-l';
import { allOn, visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { useOpsStep, type SceneM } from './stage-context-m';
import styles from './m.module.css';

/** The positioning conversation: the week window's first stage (了解你), as a still picture. */
const ASK_STAGE = 0;

/**
 * Sample M's one continuous element (direction H): a real product window fixed beside the page on a computer, its
 * content following the scroll — the positioning conversation (first screen, voices), the week's conversation at the
 * step region 3 shows, the report of the page's own person (sample reports, worries). Where a region brings its own
 * windows or the plan cards, it steps aside. Only on a wide screen with motion welcome (CSS); phones and reduced motion
 * get each region's own window in place instead, so this is a picture only (inert). Every window inside is the real
 * component, unchanged.
 */
export function StageM({ scene, flags }: { scene: SceneM; flags: LandingFlags }) {
  const { step } = useOpsStep();
  const steps = visibleItems(flags, L_OPS.steps);
  const report = allOn(flags, ['report']);
  // Fall back where a scene's capability is off; 'none' keeps the last picture while the window steps aside.
  const wanted = scene === 'ops' && steps.length === 0 ? 'ask' : scene === 'report' && !report ? (steps.length ? 'ops' : 'ask') : scene;
  const [shown, setShown] = useState<Exclude<SceneM, 'none'>>('ask');
  // Adjusted while rendering (React's pattern for state derived from a changing prop), not in an effect.
  if (wanted !== 'none' && wanted !== shown) setShown(wanted);
  const current = steps[Math.min(step, steps.length - 1)];
  const marks = [
    { id: 'ask', label: J_WEEK.stages[ASK_STAGE] },
    ...(steps.length ? [{ id: 'ops', label: L_HERO_FLOW.coachDoes.items[1].text }] : []),
    ...(report ? [{ id: 'report', label: J_REPORT.title }] : []),
  ];
  return (
    // While it steps aside it drops its region mark too, so the preview's label does not float over the page.
    <div className={styles.stage} data-off={wanted === 'none' || undefined} aria-hidden="true" inert
      data-region={wanted === 'none' ? undefined : '固定产品窗口'}>
      <ol className={styles.stageMarks}>
        {marks.map((mark, index) => (
          <li key={mark.id} data-on={mark.id === shown || undefined}><span>{index + 1}</span>{mark.label}</li>
        ))}
      </ol>
      <div className={styles.stageWindow} key={shown === 'ops' ? `ops-${current?.label}` : shown} data-scene-shown={shown}>
        {shown === 'ops' && current ? <OpsChatL step={current} stepName={current.label} flags={flags} />
          : shown === 'report' ? <ReportShotM /> : <WeekJ still={ASK_STAGE} fromTop />}
      </div>
    </div>
  );
}

/** The page's own person's report as the product shows it: the cover and its 10-second card (as in sample K). */
export function ReportShotM() {
  return (
    <div className={`${k.planCard} ${styles.reportShot}`}>
      <header className={samples.cover}>
        <FileText size={22} aria-hidden="true" />
        <div>
          <p className={samples.coverLabel}>{J_REPORT.title}</p>
          <p className={k.planTitle}>{J_PERSONA.account}</p>
          <p className={samples.size}>{J_REPORT.size}</p>
        </div>
      </header>
      <Glance data={K_PLAN_CARD} />
    </div>
  );
}
