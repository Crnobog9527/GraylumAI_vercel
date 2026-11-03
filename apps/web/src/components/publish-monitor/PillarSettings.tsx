'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/trpc/client';
import { errorCode } from './labels';

/**
 * PUBLISH-MONITOR block D (Owner 2026-11-03): a brand's content pillars as a simple setting, like editing tags elsewhere: add,
 * rename, delete, move up / down, save. No confirmation screen for coach suggestions. A rename keeps the posts' tags; a deleted
 * pillar's posts go back to "未分类". The next review and title tagging use the saved list.
 */
export const PILLARS_MAX = 6;
export type PillarRow = { key: string | null; name: string };
type DraftRow = PillarRow & { uid: number };
type Brand = { businessId: string; businessName: string | null; pillars: Array<{ key: string; name: string }>; source: 'extracted' | 'user' | null };

const SAVE_ERRORS: Record<string, string> = {
  PUBLISH_MONITOR_PILLAR_NAME_INVALID: '名称要 1–40 个字。',
  PUBLISH_MONITOR_PILLAR_NAME_DUPLICATE: '两个内容方向不能同名。',
  PUBLISH_MONITOR_PILLAR_KEY_INVALID: '这个品牌的内容方向刚在别处改过，已重新读取，请再改一次。',
  PUBLISH_MONITOR_PILLARS_CHANGED: '这个品牌的内容方向刚在别处改过，已重新读取，请再改一次。',
  PUBLISH_MONITOR_BUSINESS_NOT_FOUND: '找不到这个品牌，可能已删除或归档。',
};
const muted = { color: 'var(--text-secondary)' };

/** What a save would change, in words: names only, never keys. */
export function draftProblem(rows: PillarRow[]): string | null {
  const names = rows.map(r => r.name.trim());
  if (names.some(n => n.length === 0 || Array.from(n).length > 40)) return '名称要 1–40 个字。';
  // The comparison title tagging uses: names it cannot tell apart are one name.
  if (new Set(names.map(n => n.normalize('NFKC').toLowerCase().replace(/\s+/g, ''))).size !== names.length) return '两个内容方向不能同名。';
  return null;
}

export function PillarSettings() {
  const pillars = trpc.publishMonitor.review.pillars.useQuery(undefined, { retry: false });
  // A user without the review (or while it is off) gets FORBIDDEN: the setting is simply not shown, like the review list's gate.
  if (pillars.error || pillars.data?.length === 0) return null;
  return (
    <section className="space-y-3 rounded-lg border p-4" style={{ borderColor: 'var(--border-primary)' }} aria-labelledby="pm-pillars">
      <div className="space-y-1">
        <h3 id="pm-pillars" className="text-sm font-semibold">内容方向</h3>
        <p className="text-xs" style={muted}>复盘按这些方向给作品归类、比较成绩。最多 {PILLARS_MAX} 个；改名不影响已归类的作品，
          删除后这个方向下的作品会回到“未分类”。名称用标题里真会出现的词（例如“读书笔记”），至少 2 个字，复盘才能按标题自动归类。</p>
      </div>
      {pillars.isPending ? <PillarSkeleton />
        : (pillars.data as Brand[]).map(b => <BrandPillars key={b.businessId} brand={b} />)}
    </section>
  );
}

function PillarSkeleton() {
  return (
    <div aria-busy="true" data-testid="pillar-skeleton" className="space-y-2">
      {['w-48', 'w-full', 'w-full'].map((w, i) => (
        <div key={i} className={`h-8 ${w} animate-pulse rounded`} style={{ background: 'var(--border-primary)' }} />))}
    </div>
  );
}

function BrandPillars({ brand }: { brand: Brand }) {
  const utils = trpc.useUtils();
  const saved: PillarRow[] = brand.pillars.map(p => ({ key: p.key, name: p.name }));
  // Each draft row has its own id, so moving or deleting a row never moves another row's typing.
  const [rows, setRows] = useState<DraftRow[]>(() => saved.map((r, uid) => ({ ...r, uid })));
  const [nextUid, setNextUid] = useState(saved.length);
  // When the saved list changes (this save, or another window's that made this one out of date) the draft starts again from it;
  // the save's message stays, so the user knows why.
  const savedText = JSON.stringify(saved);
  const [seen, setSeen] = useState(savedText);
  if (seen !== savedText) {
    setSeen(savedText);
    setRows(saved.map((r, uid) => ({ ...r, uid: nextUid + uid })));
    setNextUid(nextUid + saved.length);
  }
  const plain = rows.map(r => ({ key: r.key, name: r.name }));
  const save = trpc.publishMonitor.review.savePillars.useMutation({ onSuccess: () => utils.publishMonitor.review.pillars.invalidate(),
    // Changed elsewhere meanwhile: read the current list again so the next try starts from it.
    onError: e => {
      if (['PUBLISH_MONITOR_PILLAR_KEY_INVALID', 'PUBLISH_MONITOR_PILLARS_CHANGED'].includes(errorCode(e) ?? '')) {
        void utils.publishMonitor.review.pillars.invalidate();
      }
    } });
  const dirty = JSON.stringify(plain) !== JSON.stringify(saved);
  const problem = draftProblem(rows);
  const removed = saved.filter(s => !rows.some(r => r.key === s.key)).map(s => s.name);
  const set = (i: number, row: DraftRow | null) => setRows(rows.flatMap((r, j) => (j === i ? (row ? [row] : []) : [r])));
  const move = (i: number, to: number) => setRows(rows.map((r, j) => (j === i ? rows[to]! : j === to ? rows[i]! : r)));
  const code = errorCode(save.error);
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-sm font-medium">{brand.businessName ?? '品牌'}
        {brand.source === 'extracted' && <span className="ml-2 text-xs font-normal" style={muted}>（从定位报告整理，还没保存过）</span>}</p>
      {rows.length === 0 && <p className="text-xs" style={muted}>还没有内容方向，复盘时作品都算“未分类”。</p>}
      <ol className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.uid} className="flex min-w-0 flex-wrap items-center gap-2">
            <Input className="h-8 min-w-0 flex-1 basis-40" value={r.name} aria-label={`内容方向 ${i + 1} 名称`}
              onChange={e => set(i, { ...r, name: e.target.value })} />
            <div className="flex gap-1">
              <Button type="button" size="sm" variant="outline" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="上移">↑</Button>
              <Button type="button" size="sm" variant="outline" disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}
                aria-label="下移">↓</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => set(i, null)}>删除</Button>
            </div>
          </li>))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={rows.length >= PILLARS_MAX}
          onClick={() => { setRows([...rows, { key: null, name: '', uid: nextUid }]); setNextUid(nextUid + 1); }}>添加内容方向</Button>
        {dirty && <Button type="button" size="sm" disabled={!!problem || save.isPending}
          onClick={() => save.mutate({ businessId: brand.businessId, pillars: plain.map(r => ({ key: r.key, name: r.name.trim() })),
            base: brand.pillars.map(p => ({ key: p.key, name: p.name })) })}>保存</Button>}
        {dirty && <Button type="button" size="sm" variant="ghost" disabled={save.isPending}
          onClick={() => { setRows(saved.map((r, uid) => ({ ...r, uid }))); save.reset(); }}>
          撤销</Button>}
      </div>
      {dirty && problem && <p className="text-xs" style={{ color: 'var(--color-error)' }}>{problem}</p>}
      {dirty && removed.length > 0 && <p className="text-xs" style={muted}>保存后，“{removed.join('”“')}”下的作品会回到“未分类”。</p>}
      {save.error && <p role="alert" className="text-xs" style={{ color: 'var(--color-error)' }}>
        {(code && SAVE_ERRORS[code]) || '保存失败，请稍后再试。'}</p>}
    </div>
  );
}
