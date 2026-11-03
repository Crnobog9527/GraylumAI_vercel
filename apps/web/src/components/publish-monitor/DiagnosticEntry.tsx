'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/trpc/client';
import {
  buildDiagnostic, PROBLEM_TEXT, rateLabel, RATE_FIELDS, showRate, type DiagnosticForm, type FormProblem, type RateKey,
} from './diagnosticForm';
import { dataErrorMessage, errorCode, formatDay, platformName } from './labels';

/**
 * PUBLISH-MONITOR RC (Owner 2026-10-27 item 7): the single-post diagnosis, entered by hand. The user picks one of their own recent
 * posts, types what the platform's back office shows for it, adds the opening lines, checks what will be saved and confirms. The coach
 * reads the confirmed numbers in the next review; a blank field is absent, never zero.
 */
type Candidate = { postId: string; platform: string; title: string | null; postedAt: string | null; businessName: string;
  diagnosedOn: string | null };
type Saved = { id: string; platform: string; title: string | null; rates: Record<string, number>; openingText: string | null;
  videoSeconds: number | null; dropSecond: number | null; capturedOn: string };
const EMPTY: DiagnosticForm = { postId: '', rates: {}, videoSeconds: '', dropSecond: '', openingText: '' };
const field = 'w-full rounded-md border bg-transparent px-2 py-1 text-sm';

export function DiagnosticEntry() {
  const utils = trpc.useUtils();
  const candidates = trpc.publishMonitor.diagnostics.candidates.useQuery(undefined, { retry: false });
  const saved = trpc.publishMonitor.diagnostics.list.useQuery(undefined, { retry: false });
  const save = trpc.publishMonitor.diagnostics.save.useMutation();
  const remove = trpc.publishMonitor.diagnostics.remove.useMutation();
  const [form, setForm] = useState<DiagnosticForm>(EMPTY);
  const [problems, setProblems] = useState<FormProblem[]>([]);
  const [checked, setChecked] = useState<ReturnType<typeof buildDiagnostic> | null>(null);
  const [message, setMessage] = useState('');
  const posts = (candidates.data ?? []) as Candidate[];
  const chosen = posts.find(p => p.postId === form.postId);

  const edit = (patch: Partial<DiagnosticForm>) => { setForm(f => ({ ...f, ...patch })); setChecked(null); setMessage(''); };
  function review() {
    const built = buildDiagnostic(form);
    setProblems(built.ok ? [] : built.problems); setChecked(built.ok ? built : null);
  }
  async function confirm() {
    if (!checked?.ok) return;
    setMessage('');
    try {
      await save.mutateAsync(checked.input);
      setForm(EMPTY); setChecked(null); setMessage('已保存。下一次复盘会用到这些数据。');
      void utils.publishMonitor.diagnostics.invalidate();
    } catch (cause) { setMessage(dataErrorMessage(errorCode(cause))); }
  }
  async function discard(id: string) {
    try { await remove.mutateAsync({ id }); void utils.publishMonitor.diagnostics.invalidate(); }
    catch (cause) { setMessage(dataErrorMessage(errorCode(cause))); }
  }

  if (candidates.isPending || saved.isPending) return <p className="text-sm">正在读取…</p>;
  if (candidates.error) return <p role="alert" className="text-sm">{dataErrorMessage(errorCode(candidates.error))}</p>;
  return (
    <section className="space-y-4" aria-labelledby="pm-diagnostic">
      <h2 id="pm-diagnostic" className="text-base font-semibold">单条作品诊断</h2>
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        挑一条最近发的作品，把平台后台里看到的数据填上（比如抖音的 2 秒跳出率、完播率），再写下视频开头的几句话。每次复盘只需要最值得看的 2–3 条。
        没有的数据留空，不要填 0。</p>
      {posts.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          最近 45 天还没有你自己账号发的作品。先在“账号”里连接账号，或在“表格导入”里导入作品。</p>
      ) : (
        <div className="space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--border-primary)' }}>
          <label className="block text-sm">作品
            <select className={field} value={form.postId} onChange={e => edit({ postId: e.target.value })} aria-label="选择作品">
              <option value="">请选择</option>
              {posts.map(p => <option key={p.postId} value={p.postId}>
                {p.businessName} · {platformName(p.platform)} · {p.title || '（没有标题）'}{p.diagnosedOn ? '（已有诊断）' : ''}</option>)}
            </select></label>
          <div className="grid gap-2 sm:grid-cols-2">
            {RATE_FIELDS.map(f => (
              <label key={f.key} className="block text-xs">{f.label}（{f.unit}）
                <input className={field} inputMode="decimal" value={form.rates[f.key] ?? ''} aria-label={f.label}
                  onChange={e => edit({ rates: { ...form.rates, [f.key as RateKey]: e.target.value } })} /></label>))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs">视频时长（秒）
              <input className={field} inputMode="numeric" value={form.videoSeconds} aria-label="视频时长"
                onChange={e => edit({ videoSeconds: e.target.value })} /></label>
            <label className="block text-xs">观众大量流失的那一秒（后台曲线掉下去的位置，选填）
              <input className={field} inputMode="numeric" value={form.dropSecond} aria-label="流失的那一秒"
                onChange={e => edit({ dropSecond: e.target.value })} /></label>
          </div>
          <label className="block text-xs">视频开头的几句话（选填，最多 2000 字）
            <textarea className={field} rows={3} value={form.openingText} aria-label="开头文案" onChange={e => edit({ openingText: e.target.value })} /></label>
          {problems.length > 0 && <ul role="alert" className="text-sm" style={{ color: 'var(--color-error)' }}>
            {problems.map(p => <li key={p}>{PROBLEM_TEXT[p]}</li>)}</ul>}
          {checked?.ok ? (
            <div className="space-y-2 text-sm" aria-label="请核对">
              <p>请核对，确认后保存{chosen ? `（${chosen.title || '这条作品'}）` : ''}：</p>
              <ul className="list-disc pl-5">
                {Object.entries(checked.input.rates).map(([key, value]) => <li key={key}>{rateLabel(key)}：{showRate(key as RateKey, value)}</li>)}
                {checked.input.videoSeconds !== null && <li>视频时长：{checked.input.videoSeconds} 秒</li>}
                {checked.input.dropSecond !== null && <li>流失的那一秒：第 {checked.input.dropSecond} 秒</li>}
                {checked.input.openingText && <li>开头：{checked.input.openingText}</li>}
              </ul>
              <div className="flex gap-2">
                <Button size="sm" disabled={save.isPending} onClick={confirm}>确认保存</Button>
                <Button size="sm" variant="outline" onClick={() => setChecked(null)}>返回修改</Button>
              </div>
            </div>
          ) : <Button size="sm" onClick={review}>核对</Button>}
        </div>
      )}
      {message && <p role="status" className="text-sm">{message}</p>}
      {(saved.data as Saved[] | undefined)?.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">已保存的诊断</h3>
          <ul className="space-y-2 text-sm">
            {(saved.data as Saved[]).map(d => (
              <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-2"
                style={{ borderColor: 'var(--border-primary)' }}>
                <span>{formatDay(d.capturedOn)} · {platformName(d.platform)} · {d.title || '（没有标题）'}：
                  {Object.entries(d.rates).map(([key, value]) => `${rateLabel(key)} ${showRate(key as RateKey, value)}`).join('，')}</span>
                <Button size="sm" variant="outline" disabled={remove.isPending} onClick={() => discard(d.id)}>删除</Button>
              </li>))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
