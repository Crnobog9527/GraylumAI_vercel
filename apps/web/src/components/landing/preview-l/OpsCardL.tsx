/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Check, Square, SquareCheck, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import week from '@/components/landing/preview-j/week-j.module.css';
import type { OpsCard } from '@/lib/landing/landing-copy-l';
import styles from './l.module.css';

/**
 * The example's content inside a coach message of region 3's week: topics, script, the test, the result, the series,
 * publishing and the platforms' data (the last three drawn as sample J's week window draws them).
 */
export function OpsCardL({ card }: { card: OpsCard }) {
  if (card.kind === 'publish') {
    return (
      <div className={week.publish}>
        {/* Plain ticks: inside the work chat every button takes the chat's own button look. */}
        <ul>
          {card.platforms.map(platform => (
            <li key={platform.name} data-on={platform.on || undefined}>
              {platform.on ? <SquareCheck size={16} aria-hidden="true" /> : <Square size={16} aria-hidden="true" />}{platform.name}
            </li>
          ))}
        </ul>
        <Button size="sm" tabIndex={-1}>{card.action}</Button>
      </div>
    );
  }
  if (card.kind === 'fetch') {
    return <ul className={week.fetch}>{card.items.map(text => <li key={text}><Check size={14} aria-hidden="true" />{text}</li>)}</ul>;
  }
  if (card.kind === 'platforms') {
    return (
      <table className={week.table}>
        <thead><tr>{card.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>
          {card.rows.map(row => (
            <tr key={row[0]}>{row.map((cell, at) => (at === 0 ? <th key={at} scope="row">{cell}</th> : <td key={at}>{cell}</td>))}</tr>
          ))}
        </tbody>
      </table>
    );
  }
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
