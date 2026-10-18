/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { ArrowRight } from 'lucide-react';
import k from '@/components/landing/preview-k/k.module.css';
import { visibleItems, type LandingFlags } from '@/lib/landing/landing-flags';
import { L_CARE } from '@/lib/landing/landing-copy-l';
import styles from './l.module.css';

/**
 * Region 5 (Owner 2026-10-17): an easy list. Each item: what you no longer worry about, and what the coach does behind
 * it; writing in your own voice first. No fixed weekdays. An item whose capability is off is left out.
 */
export function CareL({ flags }: { flags: LandingFlags }) {
  const items = visibleItems(flags, L_CARE.items);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="care-title" className={k.section} data-zone="work" data-region="不用操心的事">
      <div className={k.wrap}>
        <h2 id="care-title" className={k.minor}>{L_CARE.title}</h2>
        <ul className={styles.care}>
          {items.map(item => (
            <li key={item.worry}>
              <b>{item.worry}</b>
              <ArrowRight size={18} aria-hidden="true" />
              <span>{item.does}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
