/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Check, Sparkles } from 'lucide-react';
import type { SceneCard } from '@/components/landing/preview-g/scenes';
import { cn } from '@/lib/utils';
import styles from './scenes-h.module.css';

/** The cards inside a coach reply (options, a summary sheet, a data table, chips, an outline), on frosted glass. */
export function SceneCardH({ card }: { card: SceneCard }) {
  if (card.type === 'options') {
    return (
      <div className={styles.card}>
        <p className={styles.cardTitle}>{card.question}</p>
        <ul className={styles.options}>
          {card.options.map((option, index) => (
            <li key={option} data-recommended={index === card.recommended}>
              <span>{option}</span>
              {index === card.recommended ? <span className={styles.tag}>推荐</span> : null}
            </li>
          ))}
          <li className={styles.optionOther}><span>其他，直接说你的情况</span></li>
        </ul>
        <p className={styles.reason}><Sparkles size={14} aria-hidden="true" />{card.reason}</p>
      </div>
    );
  }
  if (card.type === 'sheet') {
    return (
      <div className={styles.card}>
        <p className={styles.cardTitle}>{card.title}</p>
        <dl className={styles.sheet}>
          {card.rows.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
        {card.action ? <span className={styles.cardAction}><Check size={14} aria-hidden="true" />{card.action}</span> : null}
      </div>
    );
  }
  if (card.type === 'table') {
    return (
      <div className={styles.card}>
        <p className={styles.cardTitle}>{card.title}</p>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead><tr>{card.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody>
              {card.rows.map(row => (
                <tr key={row[0]}>
                  {row.map((cell, index) => (index === 0
                    ? <th key={index} scope="row">{cell}</th>
                    : <td key={index} data-missing={cell === '未取到'}>{cell}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.caption}>{card.caption}</p>
      </div>
    );
  }
  if (card.type === 'chips') {
    return (
      <div className={styles.card}>
        <p className={styles.cardTitle}>{card.title}</p>
        <ul className={styles.chips}>{card.items.map(item => <li key={item}>{item}</li>)}</ul>
      </div>
    );
  }
  return (
    <div className={cn(styles.card, styles.doc)}>
      <p className={styles.cardTitle}>{card.title}</p>
      <ul className={styles.outline}>{card.items.map(item => <li key={item}>{item}</li>)}</ul>
    </div>
  );
}
