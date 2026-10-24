'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useMemo } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/trpc/client';
import { accountIndex, brandsFromLibrary } from './brands';
import { ConnectionsPanel, type Connection, type RefreshState } from './ConnectionsPanel';
import { dataErrorMessage, errorCode } from './labels';
import { ManualImport } from './ManualImport';
import { PostsPanel, type Post } from './PostsPanel';
import { ReviewPanel } from './ReviewPanel';

/**
 * PUBLISH-MONITOR PR-7: "数据复盘" — connected accounts, the user's own post data, table import and weekly reviews.
 * Access follows the server: the admin switch (off → "还没有开放"), the plan's data window (free → upgrade note,
 * Pro 30 days, Gold 90 days plus benchmarks and the automatic review). Nothing here decides access by itself.
 */
export function DataReviewView() {
  const utils = trpc.useUtils();
  const connections = trpc.publishMonitor.connections.useQuery(undefined, { retry: false });
  const data = trpc.publishMonitor.data.useQuery({}, { retry: false });
  const library = trpc.opc.library.useQuery({ search: '', from: null, to: null }, { retry: false });
  const brands = useMemo(() => brandsFromLibrary(library.data), [library.data]);
  const refresh = useMemo(() => new Map<string, RefreshState>((data.data?.connections ?? []).map(c => [c.id, c])),
    [data.data]);

  const blocked = errorCode(connections.error) ?? errorCode(data.error);
  // The account list comes from the library query, so adding a brand account refreshes it too.
  const changed = () => {
    void utils.publishMonitor.connections.invalidate(); void utils.publishMonitor.data.invalidate();
    void utils.opc.library.invalidate();
  };

  if (connections.isPending || data.isPending) return <Shell><p className="text-sm">正在读取…</p></Shell>;
  if (blocked === 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED') return <Shell><Upgrade /></Shell>;
  if (blocked || !connections.data || !data.data) {
    return (
      <Shell>
        <p role="alert" className="text-sm">{dataErrorMessage(blocked)}</p>
        {blocked !== 'PUBLISH_MONITOR_DISABLED' && <Button variant="outline" onClick={changed}>重试</Button>}
      </Shell>
    );
  }
  const windowDays = data.data.windowDays;
  const gold = windowDays >= 90;
  const accounts = accountIndex(brands);
  const accountOfConnection = new Map((connections.data as Connection[])
    .flatMap(c => (c.accountProjectId && accounts.get(c.accountProjectId) ? [[c.id, accounts.get(c.accountProjectId)!] as const] : [])));
  return (
    <Shell>
      {library.error && <p role="alert" className="text-sm">读不到你的品牌账号列表，连接和导入暂时不能选账号。</p>}
      <Tabs defaultValue="posts">
        <TabsList>
          <TabsTrigger value="posts">作品数据</TabsTrigger>
          <TabsTrigger value="accounts">账号</TabsTrigger>
          <TabsTrigger value="review">每周复盘</TabsTrigger>
          <TabsTrigger value="import">表格导入</TabsTrigger>
        </TabsList>
        <TabsContent value="posts" className="pt-4">
          <PostsPanel windowDays={windowDays} posts={data.data.posts as Post[]} connections={data.data.connections}
            accountOf={id => accountOfConnection.get(id)} onLinked={changed} />
        </TabsContent>
        <TabsContent value="accounts" className="pt-4">
          <ConnectionsPanel brands={brands} connections={connections.data as Connection[]} refresh={refresh} gold={gold}
            onChanged={changed} />
        </TabsContent>
        <TabsContent value="review" className="pt-4"><ReviewPanel gold={gold} /></TabsContent>
        <TabsContent value="import" className="pt-4"><ManualImport brands={brands} onImported={changed} /></TabsContent>
      </Tabs>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">数据复盘</h1>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          连接你自己的社媒账号，看作品数据，让 AI 告诉你哪些内容有效、下周怎么调整。</p>
      </header>
      {children}
    </main>
  );
}

function Upgrade() {
  return (
    <div className="space-y-2 rounded-lg border p-4 text-sm" style={{ borderColor: 'var(--border-primary)' }}>
      <p>{dataErrorMessage('PUBLISH_MONITOR_ENTITLEMENT_REQUIRED')}</p>
      <Link className="underline" href="/app/profile?tab=subscription">查看会员</Link>
    </div>
  );
}
