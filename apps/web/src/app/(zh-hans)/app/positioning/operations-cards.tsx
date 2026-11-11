/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import styles from './start-work.module.css';

/**
 * The two "运营" cards of the start page: 发布排期 and 数据复盘. They follow the same switch as the two items of the
 * left rail (rail-view.tsx, `dataReview`): open, each is a link to its page; closed, each is unavailable and says
 * "待接入". Before this the cards always said "待接入", also when the rail beside them already opened both pages.
 */
export function OperationsCards({ open }: { open: boolean }) {
  const schedule = <>
    <span className={`${styles.moduleVisual} ${styles.artSchedule}`}><span className={styles.calendarArt}>WEEK
      <span className={styles.week}>{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</span></span><b>有序<br />发生</b></span>
    <strong>发布排期</strong><small>{open ? '安排内容节奏' : '待接入，安排内容节奏'}</small></>;
  const review = <>
    <span className={`${styles.moduleVisual} ${styles.artReview}`}><span className={styles.bars}><i /><i /><i /><i /></span>
      <b>回看，<br />再向前。</b></span>
    <strong>数据复盘</strong><small>{open ? '从实际表现出发' : '待接入，从实际表现出发'}</small></>;
  if (!open) return <><button disabled aria-label="发布排期，待接入">{schedule}</button><button disabled aria-label="数据复盘，待接入">{review}</button></>;
  return <><Link prefetch={false} href="/app/publish-schedule">{schedule}</Link><Link prefetch={false} href="/app/publish-monitor">{review}</Link></>;
}
