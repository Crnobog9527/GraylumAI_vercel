'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/trpc/client';
import { accountIndex, type Brand } from './brands';
import { ConnectForm } from './ConnectForm';
import {
  CONNECTION_STATUS, SOURCE_LABEL, dataErrorMessage, errorCode, formatTime, platformName,
} from './labels';

/** One row of `publishMonitor.connections` (foundation.ts connectionSchema). */
export type Connection = { id: string; businessId: string; accountProjectId: string | null; role: 'own' | 'benchmark';
  source: 'postforme' | 'tikhub' | 'manual'; platform: string; displayHint: string | null; status: string;
  consentRead: boolean; consentAutoTrack: boolean; consentPublish: boolean; lastSuccessAt: string | null; postCount: number };
/** Refresh state from `publishMonitor.data` (data.ts dataSchema). */
export type RefreshState = { id: string; refreshError: string | null; delayed: boolean; manualRefreshAt: string | null;
  refreshState: string | null };

/**
 * Brand accounts that cannot be connected again. Only a live connection blocks: one that needs re-authorizing is
 * connected again through the same form (the server updates it in place), and a manual-only account is upgraded in
 * place by the first real connection (publish_monitor_connect_confirm, publish_monitor_tikhub_connect).
 */
export function blockingProjectIds(own: Connection[]): Set<string> {
  return new Set(own.flatMap(c => (c.accountProjectId && c.status === 'connected' && c.source !== 'manual'
    ? [c.accountProjectId] : [])));
}

/**
 * PUBLISH-MONITOR PR-7: the user's connected accounts with their state, refresh and disconnect, a form to connect
 * another brand account, and (Gold) the benchmark accounts. Every check is repeated on the server; the buttons are
 * only entry points.
 */
export function ConnectionsPanel({ brands, connections, refresh, gold, onChanged }: { brands: Brand[];
  connections: Connection[]; refresh: Map<string, RefreshState>; gold: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false), [preselect, setPreselect] = useState('');
  const own = connections.filter(c => c.role === 'own');
  const benchmarks = connections.filter(c => c.role === 'benchmark');
  const accounts = accountIndex(brands);
  const connected = blockingProjectIds(own);
  return (
    <section className="space-y-4" aria-labelledby="pm-accounts">
      <div className="flex items-center justify-between gap-2">
        <h2 id="pm-accounts" className="text-base font-semibold">我的账号</h2>
        <Button variant="outline" onClick={() => { setPreselect(''); setAdding(value => !value); }}>{adding ? '收起' : '连接账号'}</Button>
      </div>
      {adding && <ConnectForm key={preselect} brands={brands} connected={connected} initialProjectId={preselect}
        onConnected={() => { setAdding(false); onChanged(); }} onAccountAdded={onChanged} />}
      {own.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          还没有连接账号。海外 9 个平台授权后读取你自己作品的数据；小红书、抖音贴主页链接读取公开数据；其他平台可以用表格导入。</p>
      ) : (
        <ul className="divide-y rounded-lg border" style={{ borderColor: 'var(--border-primary)' }}>
          {own.map(c => {
            const account = c.accountProjectId ? accounts.get(c.accountProjectId) : undefined;
            return <ConnectionRow key={c.id} connection={c} refresh={refresh.get(c.id)} onChanged={onChanged}
              onReauthorize={projectId => { setPreselect(projectId); setAdding(true); }}
              title={`${account?.businessName ?? '品牌'} · ${platformName(c.platform)} · ${account?.label ?? c.displayHint ?? ''}`} />;
          })}
        </ul>
      )}
      {gold && <Benchmarks brands={brands} benchmarks={benchmarks} onChanged={onChanged} />}
    </section>
  );
}

function stateLine(c: Connection, refresh: RefreshState | undefined): string {
  if (c.status !== 'connected') return CONNECTION_STATUS[c.status] ?? c.status;
  if (refresh?.refreshError) return '数据更新失败，会自动重试';
  if (refresh?.delayed) return c.lastSuccessAt ? '数据更新延迟' : '首次更新中';
  if (c.source === 'postforme' && c.lastSuccessAt && c.postCount === 0) return '还没读到作品，如果你已经发过，请重新授权';
  return `最后更新于 ${formatTime(c.lastSuccessAt)}`;
}

function ConnectionRow({ connection: c, refresh, title, onChanged, onReauthorize }: { connection: Connection;
  refresh: RefreshState | undefined; title: string; onChanged: () => void; onReauthorize: (projectId: string) => void }) {
  const doRefresh = trpc.publishMonitor.refresh.useMutation();
  const disconnect = trpc.publishMonitor.disconnect.useMutation();
  const [confirming, setConfirming] = useState(false);
  const error = doRefresh.error ?? disconnect.error;
  const needsReauth = c.source === 'postforme' && (c.status === 'reauth_required' || c.status === 'quarantined');
  return (
    <li className="space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong>{title}</strong>
        <span style={{ color: 'var(--text-secondary)' }}>{SOURCE_LABEL[c.source]} · {c.postCount} 条作品</span>
      </div>
      <p style={{ color: c.status === 'connected' && !refresh?.refreshError ? 'var(--text-secondary)' : 'var(--color-error)' }}>
        {stateLine(c, refresh)}{c.status === 'connected' && !c.consentAutoTrack ? ' · 没有打开每天自动更新' : ''}</p>
      {doRefresh.data && <p role="status">{doRefresh.data.inserted > 0 ? `读到 ${doRefresh.data.inserted} 条新作品。`
        : doRefresh.data.outcome === 'partial' ? '已读取一部分，剩下的会在下次更新时接着读。' : '已刷新。'}</p>}
      {error && <p role="alert" style={{ color: 'var(--color-error)' }}>{dataErrorMessage(errorCode(error))}</p>}
      <div className="flex flex-wrap gap-2">
        {c.source === 'postforme' && c.status === 'connected' && (
          <Button size="sm" variant="outline" disabled={doRefresh.isPending}
            onClick={() => doRefresh.mutate({ connectionId: c.id }, { onSuccess: onChanged })}>
            {doRefresh.isPending ? '正在刷新…' : '刷新数据'}</Button>
        )}
        {needsReauth && c.accountProjectId && <Button size="sm" onClick={() => onReauthorize(c.accountProjectId!)}>重新授权</Button>}
        {confirming ? <>
          <span className="self-center">断开后不再读取这个账号，已读到的作品数据会一起删除。确定吗？</span>
          <Button size="sm" variant="destructive" disabled={disconnect.isPending}
            onClick={() => disconnect.mutate({ connectionId: c.id }, { onSuccess: onChanged })}>确定断开</Button>
          <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>取消</Button>
        </> : <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>断开并删除</Button>}
      </div>
    </li>
  );
}

function Benchmarks({ brands, benchmarks, onChanged }: { brands: Brand[]; benchmarks: Connection[]; onChanged: () => void }) {
  const [businessId, setBusinessId] = useState(brands[0]?.businessId ?? '');
  const [link, setLink] = useState(''), [hint, setHint] = useState('');
  const add = trpc.publishMonitor.addBenchmark.useMutation();
  const remove = trpc.publishMonitor.disconnect.useMutation();
  const brandName = (id: string) => brands.find(b => b.businessId === id)?.name ?? '品牌';
  return (
    <section className="space-y-2" aria-labelledby="pm-benchmarks">
      <h3 id="pm-benchmarks" className="text-sm font-semibold">对标账号（Gold）</h3>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        读取对标账号的公开数据，每次读取按实际费用扣积分。</p>
      {benchmarks.length > 0 && (
        <ul className="divide-y rounded-lg border text-sm" style={{ borderColor: 'var(--border-primary)' }}>
          {benchmarks.map(b => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
              <span>{brandName(b.businessId)} · {platformName(b.platform)} · {b.displayHint ?? '对标账号'}
                <small className="ml-2" style={{ color: 'var(--text-secondary)' }}>最后更新于 {formatTime(b.lastSuccessAt)}</small></span>
              <Button size="sm" variant="ghost" disabled={remove.isPending}
                onClick={() => remove.mutate({ connectionId: b.id }, { onSuccess: onChanged })}>移除</Button>
            </li>
          ))}
        </ul>
      )}
      {brands.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-[auto_1fr_auto_auto]">
          <select aria-label="对标挂在哪个品牌" className="rounded-md border px-2 py-1.5 text-sm"
            style={{ borderColor: 'var(--border-primary)' }} value={businessId} onChange={e => setBusinessId(e.target.value)}>
            {brands.map(b => <option key={b.businessId} value={b.businessId}>{b.name}</option>)}
          </select>
          <Input aria-label="对标账号主页链接" placeholder="对标账号的主页链接" value={link} maxLength={2048}
            onChange={e => setLink(e.target.value)} />
          <Input aria-label="备注名" placeholder="备注名（可不填）" value={hint} maxLength={64} onChange={e => setHint(e.target.value)} />
          <Button size="sm" disabled={!businessId || !link.trim() || add.isPending}
            onClick={() => add.mutate({ businessId, profileLink: link.trim(), ...(hint.trim() ? { displayHint: hint.trim() } : {}) },
              { onSuccess: () => { setLink(''); setHint(''); onChanged(); } })}>添加</Button>
        </div>
      )}
      {(add.error ?? remove.error) && <p role="alert" className="text-sm" style={{ color: 'var(--color-error)' }}>
        {dataErrorMessage(errorCode(add.error ?? remove.error))}</p>}
    </section>
  );
}

