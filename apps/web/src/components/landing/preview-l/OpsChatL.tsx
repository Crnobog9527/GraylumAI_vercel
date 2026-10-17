/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import week from '@/components/landing/preview-j/week-j.module.css';
import result from '@/components/opc/positioning-result.module.css';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { L_OPS, type OpsLine } from '@/lib/landing/landing-copy-l';
import { cn } from '@/lib/utils';
import { OpsCardL } from './OpsCardL';
import styles from './l.module.css';

/**
 * One step of region 3's week as a chat window, as wide as the page: the bar (example badge, the account, the step),
 * then the step's messages arriving one after another (all there at once with reduced motion). A message behind a flag
 * shows only with it; one marked `without` shows only while that flag is off. The window is a picture (inert); the
 * step's line above it carries the meaning.
 */
export function OpsChatL({ step, stepName, flags }: {
  step: { lines: readonly OpsLine[] }; stepName: string; flags: LandingFlags;
}) {
  const lines = step.lines.filter(line => allOn(flags, line.needs) && !(line.without && flags[line.without]));
  return (
    <div className={cn(week.window, styles.opsWindow)} inert aria-hidden="true">
      <div className={week.chrome}>
        <span className={week.dots}><i /><i /><i /></span>
        <span className={week.badge}>{DEMO_LABEL}</span>
        <span className={week.chromeTitle}>{L_OPS.title}</span>
        <span className={week.chromeStage}>{stepName}</span>
      </div>
      <div className={styles.opsLog}>
        {lines.map((line, index) => (
          <div key={line.text} className={line.role === 'user' ? week.user : week.coach} style={{ '--m': index } as CSSProperties}>
            {line.role === 'coach' ? <span className={result.agentIdentity}><img src="/graylum-logo.png" alt="" />AI 自媒体陪跑教练</span> : null}
            {line.role === 'coach' ? <p>{line.text}</p> : line.text}
            {line.card ? <OpsCardL card={line.card} /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
