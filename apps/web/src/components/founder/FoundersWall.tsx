/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { SiteShell } from '@/components/public-site/SiteShell';
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
  return <li className="rounded-2xl border border-[#262626] bg-[#111] p-5" data-testid="founders-wall-card">
    <h2 className="text-lg font-semibold text-white">{entry.displayName}</h2>
    {entry.intro && <p className="mt-2 text-sm leading-6 text-[#C8C8C8]">{entry.intro}</p>}
    {entry.socialAccounts.length > 0 && <ul className="mt-3 space-y-1 text-sm">
      {entry.socialAccounts.map(item => <li key={item.url}>
        <span className="text-[#8A8A8A]">{platformLabel(item.platform)}：</span>
        <a href={item.url} target="_blank" rel={REL} className="text-[#FFD700] hover:underline">{item.handle}</a>
      </li>)}
    </ul>}
    {entry.productName && <p className="mt-3 text-sm">
      <span className="text-[#8A8A8A]">产品：</span>
      {entry.productUrl
        ? <a href={entry.productUrl} target="_blank" rel={REL} className="text-[#FFD700] hover:underline">{entry.productName}</a>
        : <span className="text-[#C8C8C8]">{entry.productName}</span>}
    </p>}
  </li>;
}

/** Public, read-only wall. Entries come from the server already limited to approved, consented, in-force members. */
export function FoundersWall({ entries, supportEmail }: { entries: WallEntry[]; supportEmail?: string | null }) {
  const open = entries.length >= MIN_WALL_ENTRIES;
  return <SiteShell locale="zh-Hans" supportEmail={supportEmail}>
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6 md:py-14">
      <h1 className="text-3xl font-bold leading-tight sm:text-4xl">创始会员墙</h1>
      <p className="mt-4 text-lg leading-8 text-[#E6E6E6]">
        最早一批支持 Graylum 的创始会员。下面的内容都是会员本人同意公开、并经过我们审核的。
      </p>
      {open
        ? <ul className="mt-10 grid gap-4 sm:grid-cols-2" data-testid="founders-wall-list">
          {entries.map(entry => <FounderCard key={`${entry.displayName}-${entry.socialAccounts[0]?.url ?? entry.productUrl ?? ''}`} entry={entry} />)}
        </ul>
        : <p className="mt-10 text-base text-[#C8C8C8]" data-testid="founders-wall-soon">创始会员墙即将开放，敬请期待。</p>}
      <p className="mt-12 text-sm text-[#8A8A8A]">
        想成为创始会员？<Link href="/pricing" className="text-[#FFD700] hover:underline">查看会员方案</Link>
      </p>
    </main>
  </SiteShell>;
}
