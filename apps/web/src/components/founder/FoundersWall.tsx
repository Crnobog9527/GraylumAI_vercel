/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { SiteShell } from '@/components/public-site/SiteShell';
import styles from '@/components/public-site/article.module.css';
import { FounderBadgeView } from './FounderBadge';
import { PLATFORMS } from './founderMemberView';

export interface WallEntry {
  displayName: string;
  socialAccounts: { platform: string; handle: string; url: string }[];
  productName: string | null;
  productUrl: string | null;
  intro: string | null;
}

/** The wall opens once enough members have agreed to be shown (Owner decision F6: 5 or more). */
export const MIN_WALL_ENTRIES = 5;

const REL = 'nofollow ugc noopener noreferrer';
const platformLabel = (value: string) => PLATFORMS.find(item => item.value === value)?.label ?? value;

export function FounderCard({ entry }: { entry: WallEntry }) {
  return <li className={styles.card} data-testid="founders-wall-card">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className={styles.cardTitle}>{entry.displayName}</h2>
      <FounderBadgeView state="active" />
    </div>
    {entry.intro && <p className={styles.text}>{entry.intro}</p>}
    {entry.socialAccounts.length > 0 && <ul className={styles.meta}>
      {entry.socialAccounts.map(item => <li key={item.url}>
        <span>{platformLabel(item.platform)}：</span>
        <a href={item.url} target="_blank" rel={REL} className={styles.textLink}>{item.handle}</a>
      </li>)}
    </ul>}
    {entry.productName && <p className={styles.meta}>
      <span>产品：</span>
      {entry.productUrl
        ? <a href={entry.productUrl} target="_blank" rel={REL} className={styles.textLink}>{entry.productName}</a>
        : <span>{entry.productName}</span>}
    </p>}
  </li>;
}

/** Public, read-only wall. Entries come from the server already limited to approved, consented, in-force members. */
export function FoundersWall({ entries, supportEmail }: { entries: WallEntry[]; supportEmail?: string | null }) {
  const open = entries.length >= MIN_WALL_ENTRIES;
  return <SiteShell locale="zh-Hans" supportEmail={supportEmail}>
    <div className={styles.article} data-wide="">
      <h1 className={styles.title}>创始会员墙</h1>
      <p className={styles.lead}>
        最早一批支持 Graylum 的创始会员。下面的内容都是会员本人同意公开、并经过我们审核的。
      </p>
      {open
        ? <ul className={styles.cards} data-columns="2" data-zone="voice" data-testid="founders-wall-list">
          {entries.map(entry => <FounderCard key={`${entry.displayName}-${entry.socialAccounts[0]?.url ?? entry.productUrl ?? ''}`} entry={entry} />)}
        </ul>
        : <p className={styles.card} data-testid="founders-wall-soon">创始会员墙即将开放，敬请期待。</p>}
      <p className={styles.foot}>
        想成为创始会员？<Link href="/pricing" className={styles.textLink}>查看会员方案</Link>
      </p>
    </div>
  </SiteShell>;
}
