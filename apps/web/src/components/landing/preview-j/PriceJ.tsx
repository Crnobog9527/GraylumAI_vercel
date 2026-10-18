/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { PRICE_COMPARE, type CompareRow } from '@/lib/landing/landing-copy';
import { J_PRICE } from '@/lib/landing/landing-copy-j';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import { CountUpJ } from './CountUpJ';
import styles from './price-j.module.css';
import page from './j.module.css';

export const PRICING_PAGE = '/landing/pricing';

/** How the comparison plays, in milliseconds: each row after the last, the total's count, the pause, the strike. */
export const PRICE_TIMING = { row: 180, count: 1100, pause: 600, strike: 700 } as const;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** At rest (server HTML, reduced motion) the comparison is finished; with motion it waits, then plays once. */
type Phase = 'rest' | 'wait' | 'count' | 'strike' | 'own';

/** True once the node has been on screen (a page reloaded already scrolled here counts too). */
function useSeen(threshold: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setSeen(true); observer.disconnect(); }
    }, { threshold });
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);
  return [ref, seen] as const;
}

/**
 * Price (Owner 2026-10-15, rounds five to seven): only the comparison. What the usual ways cost, each figure with its
 * source; as the table comes into view each row's figures add up from zero, one row after another. Then their total
 * adds up to its sum, holds a moment, and a line strikes it out; only then does "Graylum AI：$29/月起" rise beside it,
 * with its moving gold edge and one highlight, and the way to the full pricing page. The Pro price comes from the
 * server catalog. The server HTML and reduced motion show the finished comparison.
 * Sample K (Owner 2026-10-17): `after` sits under the button; `calm` drops the panel's shadow, the springy rise and the
 * gold edge's endless travel (the total and its strike stay as they are).
 * Sample L (Owner 2026-10-17): `plainTotal` shows the usual ways' total in full, not struck out; `checked: false` drops
 * the check-date line; `quiet` sets our price in plain ink (no gold sheen) and the full-pricing link as a text link, so
 * it does not compete with the plan cards' buttons.
 */
export function PriceJ({ proMonthly, rows, after, calm = false, plainTotal = false, checked = true, quiet = false }: {
  proMonthly: number | null; rows: readonly CompareRow[]; after?: ReactNode; calm?: boolean; plainTotal?: boolean; checked?: boolean;
  quiet?: boolean;
}) {
  const [tableRef, tableSeen] = useSeen(0.2);
  const [versusRef, versusSeen] = useSeen(0.5);
  const [phase, setPhase] = useState<Phase>('rest');

  useEffect(() => { if (!reducedMotion()) setPhase('wait'); }, []);
  useEffect(() => {
    if (!versusSeen || reducedMotion()) return;
    const { count, pause, strike } = PRICE_TIMING;
    setPhase('count');
    const toStrike = window.setTimeout(() => setPhase('strike'), count + pause);
    const toOwn = window.setTimeout(() => setPhase('own'), count + pause + strike);
    return () => { window.clearTimeout(toStrike); window.clearTimeout(toOwn); };
  }, [versusSeen]);

  if (rows.length === 0) return null;
  const allRows = J_PRICE_TOTAL.rows.every(id => rows.some(row => row.sourceId === id));
  const counting = phase !== 'rest' && phase !== 'wait';
  return (
    <section id="pricing" aria-labelledby="pricing-title" className={page.section} data-zone="price" data-region="价格" data-calm={calm || undefined}>
      <div className={page.wrap}>
        <h2 id="pricing-title" className={`${page.display} ${styles.title}`}>{J_PRICE.title}</h2>
        <div className={styles.compareCost}>
          <h3>{J_PRICE.compareTitle}</h3>
          <div ref={tableRef} data-region="费用对比表">
            <ul data-play={tableSeen || undefined}>
              {rows.map((row, index) => (
                <li key={row.sourceId} style={{ '--i': index } as CSSProperties}>
                  <span>{row.label}</span>
                  <b><CountUpJ text={row.price} play={tableSeen} delay={index * PRICE_TIMING.row} /></b>
                  <small>{J_PRICE.sourceLabel}：{PRICE_COMPARE.sources[row.sourceId]}</small>
                </li>
              ))}
            </ul>
          </div>
          <div ref={versusRef} className={styles.versus} data-phase={phase} data-plain={plainTotal || undefined} data-quiet={quiet || undefined}
            data-region="Graylum 价格">
            {allRows ? (
              <p className={styles.total}>
                <span>{J_PRICE_TOTAL.label}</span>
                <b><CountUpJ text={J_PRICE_TOTAL.text} play={counting} duration={PRICE_TIMING.count} /></b>
              </p>
            ) : null}
            {proMonthly !== null ? (
              <div className={styles.own}>
                <p><b className={styles.price}>{J_PRICE.ownPrice(formatUsd(proMonthly))}</b></p>
                <Link href={PRICING_PAGE} className={quiet ? styles.moreLink : `${page.pill} ${styles.cta}`}>
                  {J_PRICE.more}<ArrowRight size={quiet ? 15 : 18} aria-hidden="true" />
                </Link>
                {after}
              </div>
            ) : null}
          </div>
          {checked ? <p className={styles.checked}>{J_PRICE.checked}</p> : null}
        </div>
      </div>
    </section>
  );
}
