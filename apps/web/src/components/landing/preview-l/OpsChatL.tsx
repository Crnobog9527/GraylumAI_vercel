/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import { Trophy } from 'lucide-react';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import week from '@/components/landing/preview-j/week-j.module.css';
import result from '@/components/opc/positioning-result.module.css';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { L_OPS, type OpsCard, type OpsLine } from '@/lib/landing/landing-copy-l';
import { cn } from '@/lib/utils';
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
            {line.card ? <Card card={line.card} /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function Card({ card }: { card: OpsCard }) {
  if (card.kind === 'topics') {
    return (
      <ol className={week.topics}>
        {card.items.map(item => <li key={item.title}><b>{item.title}</b><span>{item.why}</span></li>)}
      </ol>
    );
  }
  if (card.kind === 'draft') {
    return (
      <div className={week.doc}>
        <p className={week.docTitle}>{card.title}</p>
        {card.lines.map(text => <p key={text}>{text}</p>)}
        <p className={styles.opsNote}>{card.shots}</p>
      </div>
    );
  }
  if (card.kind === 'test') {
    return (
      <div className={styles.opsTest}>
        {card.variants.map(variant => <p key={variant.name}><b>{variant.name}</b>{variant.opening}</p>)}
        <p className={styles.opsNote}>{card.measure}</p>
      </div>
    );
  }
  if (card.kind === 'result') {
    return (
      <div className={styles.opsResult}>
        <table className={week.table}>
          <thead><tr>{card.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
          <tbody>
            {card.rows.map((row, index) => (
              <tr key={row[0]} data-win={index === 0 || undefined}>
                {row.map((cell, at) => (at === 0 ? <th key={at} scope="row">{cell}</th> : <td key={at}>{cell}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.opsWinner}><Trophy size={14} aria-hidden="true" />{card.winner}</p>
      </div>
    );
  }
  return (
    <div className={styles.opsSeries}>
      <ol>{card.items.map(item => <li key={item}>{item}</li>)}</ol>
      <p className={styles.opsNote}>{card.extra}</p>
    </div>
  );
}
