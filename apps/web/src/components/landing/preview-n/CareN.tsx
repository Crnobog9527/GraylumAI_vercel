/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { CtaK } from '@/components/landing/preview-k/CtaK';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { L_CARE } from '@/lib/landing/landing-copy-l';
import { cn } from '@/lib/utils';
import styles from './n.module.css';

/**
 * Region 5 as cells (direction E): one cell per worry, its title short and bold, what the coach does behind it one
 * size down; writing in your own voice first and largest (the key cell). An item whose capability is off is left
 * out. The last cell holds the button, so the comparison that follows is never two regions from one.
 */
export function CareN({ flags }: { flags: LandingFlags }) {
  const items = visibleItems(flags, L_CARE.items);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="care-title" className={styles.section} data-zone="care" data-region="不用操心的事">
      <div className={styles.wrap}>
        <div className={styles.head}><h2 id="care-title" className={styles.h2}>{L_CARE.title}</h2></div>
        <ul className={cn(styles.grid, styles.careGrid)}>
          {items.map((item, index) => (
            <li key={item.worry} className={cn(styles.cell, styles.careCell)} data-cell="" data-region="省心的事"
              data-key={index === 0 ? '' : undefined}>
              <b>{item.worry}</b>
              <span>{item.does}</span>
            </li>
          ))}
          <li className={cn(styles.cell, styles.careCell, styles.ctaCell)} data-cell=""><CtaK /></li>
        </ul>
      </div>
    </section>
  );
}
