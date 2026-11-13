'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BookOpen, CalendarDays, ChartNoAxesColumnIncreasing, ChevronRight, Columns3, LayoutGrid, MessageSquareText, Plug, Scale, Search } from 'lucide-react';
import { WorkspaceFrame } from '@/components/opc/workspace-frame';
import { useRailGoldTools } from '@/components/opc/rail-gold-tools';
import { trpc } from '@/trpc/client';
import { READ_RETRY } from '@/trpc/read-retry';
import styles from './tools.module.css';

type Tile = { name: string; note?: string; icon: ReactNode; tint: 'warm' | 'lilac' | 'peach' | 'green' | 'plain' }
  & ({ href: string } | { press: () => void } | { waiting: true });

/**
 * A phone's 功能 page (Owner 2026-11-12, phone plan A): everything the rail's function links lead to on a computer, as
 * one page of large tiles reached from the bottom bar. Nothing here is new: each tile is one of the rail's own entries
 * and behaves as it does there. 发布排期 and 数据复盘 are links once their admin switch is on and wait ("待接入") until
 * then; 多模型对比 and 评审团 show, run or open their paywall exactly as in the rail (useRailGoldTools); 集成 is kept a
 * place for until its page exists. The notes under a name are words the product already uses for it.
 */
export default function ToolsPage() {
  const router = useRouter();
  const open = trpc.publishMonitor.features.useQuery(undefined, { staleTime: 300_000, ...READ_RETRY }).data?.ownData === true;
  const gold = useRailGoldTools({ navigate: href => router.push(href) });
  const tiles: Tile[] = [
    { name: '功能广场', note: '探索工具与方法', icon: <LayoutGrid />, tint: 'warm', href: '/app/workbench/marketplace' },
    { name: '资料库', note: '选题与稿件 · 我的文档 · 我的文风', icon: <BookOpen />, tint: 'lilac', href: '/app/library' },
    { name: '发布排期', icon: <CalendarDays />, tint: 'peach', ...(open ? { href: '/app/publish-schedule' } : { waiting: true }) },
    { name: '数据复盘', note: '数据趋势 · 作品数据 · 每周复盘', icon: <ChartNoAxesColumnIncreasing />, tint: 'green',
      ...(open ? { href: '/app/publish-monitor' } : { waiting: true }) },
    ...(gold.onCompare ? [{ name: '多模型对比', icon: <Columns3 />, tint: 'plain' as const, press: gold.onCompare }] : []),
    ...(gold.onJury ? [{ name: '评审团', icon: <Scale />, tint: 'plain' as const, press: gold.onJury }] : []),
    { name: '集成', icon: <Plug />, tint: 'plain', waiting: true },
  ];
  return (
    <WorkspaceFrame area="tools">
      <main className={styles.page}>
        <h1>功能</h1>
        <Link prefetch={false} href="/app/workbench/search" className={styles.find}><Search size={18} aria-hidden="true" />搜索</Link>
        <ul className={styles.tiles}>
          {tiles.map(tile => {
            const body = <>
              <i data-tint={tile.tint} aria-hidden="true">{tile.icon}</i>
              <b>{tile.name}{'waiting' in tile ? <small>待接入</small> : null}</b>
              {tile.note ? <span>{tile.note}</span> : null}
            </>;
            return (
              <li key={tile.name}>
                {'href' in tile ? <Link prefetch={false} href={tile.href}>{body}</Link>
                  : 'press' in tile ? <button type="button" onClick={tile.press}>{body}</button>
                    : <div aria-disabled="true">{body}</div>}
              </li>
            );
          })}
        </ul>
        <Link prefetch={false} href="/app/profile?tab=tickets" className={styles.row}>
          <i aria-hidden="true"><MessageSquareText /></i>在线反馈<ChevronRight size={18} aria-hidden="true" />
        </Link>
      </main>
      {gold.dialogs}
    </WorkspaceFrame>
  );
}
