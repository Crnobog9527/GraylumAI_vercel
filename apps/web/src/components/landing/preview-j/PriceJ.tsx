/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { formatUsd } from '@/components/paywall/paywallPlans';
import { PRICE_COMPARE, type CompareRow } from '@/lib/landing/landing-copy';
import { J_PRICE } from '@/lib/landing/landing-copy-j';
import { J_PRICE_TOTAL } from '@/lib/landing/landing-copy-j-price';
import styles from './price-j.module.css';
import page from './j.module.css';

export const PRICING_PAGE = '/landing/pricing';

/**
 * Price (Owner 2026-10-15, round five): only the comparison. What the usual ways cost, each figure with its source
 * beside it, dropping in one row after another as the table scrolls in; then their total, which is struck through as
 * "Graylum AI：$29/月起" rises next to it, with the way to the full pricing page. No founder offer, plan cards or
 * "先聊后买" on this page any more (Owner's decision). The Pro price comes from the server catalog.
 */
export function PriceJ({ proMonthly, rows, sample = false }: { proMonthly: number | null; rows: readonly CompareRow[]; sample?: boolean }) {
  if (rows.length === 0) return null;
  const allRows = J_PRICE_TOTAL.rows.every(id => rows.some(row => row.sourceId === id));
  return (
    <section id="pricing" aria-labelledby="pricing-title" className={page.section} data-zone="price">
      <div className={page.wrap}>
        <h2 id="pricing-title" className={page.display}>{J_PRICE.title}</h2>
        <div className={styles.compareCost}>
          <h3>{J_PRICE.compareTitle}</h3>
          <ul>
            {rows.map((row, index) => (
              <li key={row.sourceId} data-row="" style={{ '--i': index } as CSSProperties}>
                <span>{row.label}</span>
                <b>{row.price}</b>
                <small>{J_PRICE.sourceLabel}：{PRICE_COMPARE.sources[row.sourceId]}</small>
              </li>
            ))}
          </ul>
          <div className={styles.versus} data-row="">
            {allRows ? <p className={styles.total}><span>{J_PRICE_TOTAL.label}</span><b>{J_PRICE_TOTAL.text}</b></p> : null}
            {proMonthly !== null ? (
              <div className={styles.own}>
                <p><b>{J_PRICE.ownPrice(formatUsd(proMonthly))}</b>{sample ? <span className={styles.sampleTag}>本机示例数据</span> : null}</p>
                <Link href={PRICING_PAGE} className={page.pill}>{J_PRICE.more}<ArrowRight size={18} aria-hidden="true" /></Link>
              </div>
            ) : null}
          </div>
          <p className={styles.checked}>{J_PRICE.checked}</p>
        </div>
      </div>
    </section>
  );
}
