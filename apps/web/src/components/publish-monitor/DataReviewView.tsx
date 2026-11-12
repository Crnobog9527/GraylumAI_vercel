'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as Tabs from '@radix-ui/react-tabs';
import { Sparkles } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { accountIndex, brandsFromLibrary } from './brands';
import { ConnectionsPanel, type Connection, type RefreshState } from './ConnectionsPanel';
import styles from './data-review.module.css';
import { dataErrorMessage, errorCode } from './labels';
import { ManualImport } from './ManualImport';
import { PostsPanel, type Post } from './PostsPanel';
import { ReviewPanel } from './ReviewPanel';
import { StateBlock } from './StateBlock';
import { warmTrendPlot } from './TrendChart';
import { TREND_FRESH_MS, TrendCharts, TrendSkeleton } from './TrendCharts';

const TABS = [['trend', '数据趋势'], ['posts', '作品数据'], ['accounts', '账号'], ['review', '每周复盘'], ['import', '表格导入']] as const;
type TabId = typeof TABS[number][0];
/**
 * The tab named in the address (`?tab=accounts`), for links from other pages such as one-click publishing's "去连接账号".
 * The page takes it from the router's search params, not from `window.location`: on an in-app navigation the page is drawn
 * before the browser's address changes, so `window.location` still held the page the user came from and the link opened
 * 数据趋势 until a reload (validation of #1882, 2026-11-12).
 */
export function tabFromSearch(search: string): TabId {
  const named = new URLSearchParams(search).get('tab');
  return TABS.find(([id]) => id === named)?.[0] ?? 'trend';
}
/**
 * How long after the page's first reads the trend read is sent. tRPC puts reads made at the same moment into one
 * request, and that request answers only when its slowest read is done; a few milliseconds later the trend read
 * travels on its own, at the same time as the first reads, without holding them up.
 */
const TREND_HEAD_START_MS = 20;

/**
 * PUBLISH-MONITOR PR-7: "数据复盘" — connected accounts, the user's own post data, table import and weekly reviews.
 * Access follows the server: the admin switch (off → "还没有开放"), the plan's data window (free → upgrade note,
 * Pro 30 days, Gold 90 days plus benchmarks and the automatic review). Nothing here decides access by itself.
 * The page follows the library page's layout (head, underlined tabs, one scrolling body) and owns its scrolling.
 */
export function DataReviewView() {
  const utils = trpc.useUtils();
  const connections = trpc.publishMonitor.connections.useQuery(undefined, { retry: false });
  const data = trpc.publishMonitor.data.useQuery({}, { retry: false });
  const library = trpc.opc.library.useQuery({ search: '', from: null, to: null }, { retry: false });
  const brands = useMemo(() => brandsFromLibrary(library.data), [library.data]);
  const refresh = useMemo(() => new Map<string, RefreshState>((data.data?.connections ?? []).map(c => [c.id, c])),
    [data.data]);
  // The tab the address names. It is followed when the page opens and whenever the address changes (another link to this
  // page while it is open); a click on a tab is the user's own choice and stays until then.
  const named = tabFromSearch(useSearchParams()?.toString() ?? '');
  const [tab, setTab] = useState<TabId>(named);
  useEffect(() => { setTab(named); }, [named]);
  // The page opens on the trend tab, but that tab is only drawn once the first reads are back. Its data and its drawing
  // code are asked for now, not after that (PERF 2026-11-11: the trend read was a second wave, one round trip later).
  // An account without access gets one refused read here; the tab's own read (same key) then finds the answer waiting.
  useEffect(() => {
    warmTrendPlot();
    const timer = setTimeout(() => { void utils.publishMonitor.trend.prefetch(undefined, { retry: false, staleTime: TREND_FRESH_MS }); },
      TREND_HEAD_START_MS);
    return () => clearTimeout(timer);
  }, [utils]);

  const blocked = errorCode(connections.error) ?? errorCode(data.error);
  // The account list comes from the library query, so adding a brand account refreshes it too.
  const changed = () => {
    void utils.publishMonitor.connections.invalidate(); void utils.publishMonitor.data.invalidate();
    void utils.opc.library.invalidate(); void utils.publishMonitor.trend.invalidate();
  };

  if (connections.isPending || data.isPending) return <Shell loading><TrendSkeleton /></Shell>;
  if (blocked === 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED') return <Shell><Upgrade /></Shell>;
  if (blocked || !connections.data || !data.data) {
    const closed = blocked === 'PUBLISH_MONITOR_DISABLED';
    return (
      <Shell>
        <StateBlock tone={closed ? 'plain' : 'error'} title={closed ? '还没有开放' : '暂时读不到'} text={dataErrorMessage(blocked)}>
          {!closed && <button type="button" className={styles.button} onClick={changed}>重试</button>}
        </StateBlock>
      </Shell>
    );
  }
  const windowDays = data.data.windowDays;
  const gold = windowDays >= 90;
  const accounts = accountIndex(brands);
  const accountOfConnection = new Map((connections.data as Connection[])
    .flatMap(c => (c.accountProjectId && accounts.get(c.accountProjectId) ? [[c.id, accounts.get(c.accountProjectId)!] as const] : [])));
  return (
    <Shell meta={`近 ${windowDays} 天数据`}>
      <Tabs.Root className={styles.tabsRoot} value={tab} onValueChange={value => setTab(value as TabId)}>
        {/* Five tabs are wider than a 360px phone: the bar scrolls sideways instead of widening the page. */}
        <Tabs.List className={styles.tabs} aria-label="数据复盘的内容">
          {TABS.map(([id, label]) => <Tabs.Trigger key={id} value={id} className={styles.tab}>{label}</Tabs.Trigger>)}
        </Tabs.List>
        <div className={styles.body}>
          {library.error && <p role="alert" className={styles.lead}>读不到你的品牌账号列表，连接和导入暂时不能选账号。</p>}
          <Tabs.Content value="trend" className={styles.panel}><TrendCharts gold={gold} onOpenTab={setTab} /></Tabs.Content>
          <Tabs.Content value="posts" className={styles.panel}>
            <PostsPanel windowDays={windowDays} posts={data.data.posts as Post[]} connections={data.data.connections}
              accountOf={id => accountOfConnection.get(id)} onLinked={changed} onOpenTab={setTab} />
          </Tabs.Content>
          <Tabs.Content value="accounts" className={styles.panel}>
            <ConnectionsPanel brands={brands} connections={connections.data as Connection[]} refresh={refresh} gold={gold}
              onChanged={changed} onOpenTab={setTab} />
          </Tabs.Content>
          <Tabs.Content value="review" className={styles.panel}><ReviewPanel gold={gold} /></Tabs.Content>
          <Tabs.Content value="import" className={styles.panel}><ManualImport brands={brands} onImported={changed} /></Tabs.Content>
        </div>
      </Tabs.Root>
    </Shell>
  );
}

/**
 * The page frame. Without tabs (not open, upgrade, failure) the children sit in the scrolling body. While the first
 * read runs the tab bar's place is held by five grey bars the size of the labels (the labels themselves are not shown),
 * with a line where the tab's lead text will be, so the page does not jump when the data arrives. A visitor without
 * the plan gets the upgrade notice next and never sees five tabs first (walkthrough 2026-11-11, item 30).
 */
function Shell({ meta, loading = false, children }: { meta?: string; loading?: boolean; children: ReactNode }) {
  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <h1>数据复盘</h1>
        {meta && <span>{meta}</span>}
      </header>
      <p className={styles.intro}>连接你自己的社媒账号，看作品数据，让 AI 告诉你哪些内容有效、下周怎么调整。</p>
      {loading && (
        <div className={styles.tabs} aria-hidden="true">
          {TABS.map(([id, label]) => <span key={id} className={styles.tab}><i className={styles.skTab} data-tab-placeholder>{label}</i></span>)}
        </div>
      )}
      {meta ? children : (
        <div className={styles.body}>
          {loading && <div className={`${styles.sk} ${styles.skLine}`} />}
          {children}
        </div>
      )}
    </main>
  );
}

function Upgrade() {
  return (
    <StateBlock icon={<Sparkles size={20} aria-hidden />} tag="会员功能" title="数据复盘需要会员"
      text={dataErrorMessage('PUBLISH_MONITOR_ENTITLEMENT_REQUIRED')}>
      <Link className={styles.button} href="/app/profile?tab=subscription">查看会员</Link>
    </StateBlock>
  );
}
