/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import type { ArtifactSnapshot } from '@repo/api/src/services/artifacts/public';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/api/src/root';
type Status = inferRouterOutputs<AppRouter>['workbench']['generations'][number];
const states: Record<Status['state'], string> = {
  prepared: '已预留积分，尚未发送', dispatched: '已发送，等待结果', responded: '结果已保存，待恢复结算',
  succeeded: '候选已保存', refunded: '未发送，已退还预留', unknown: '结果待核对，请勿重复生成',
};
export function GenerationPanel({ snapshot, stepId, disabled, refresh }: {
  snapshot: ArtifactSnapshot; stepId: string; disabled: boolean; refresh: (projectId: string, roundId: string) => Promise<void>;
}) {
  const api = trpc.useUtils().client.workbench;
  const [instruction, setInstruction] = useState(''), [error, setError] = useState('');
  const [records, setRecords] = useState<Status[]>(snapshot.generations ?? []), [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<{ quoteHash: string; reservedCredits: number } | null>(null);
  const pending = useRef<Parameters<typeof api.generate.mutate>[0] | null>(null);
  const live = useRef(true), lock = useRef(false);
  const scope = { projectId: snapshot.projectId, roundId: snapshot.roundId };
  const expectedSteps = Object.fromEntries(Object.entries(snapshot.steps).map(([k, s]) => [k, { version: s.version, reviewVersion: s.reviewVersion }]));
  const basis = JSON.stringify(expectedSteps);
  useEffect(() => { setQuote(null); }, [instruction, basis]);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
    // A new keyed component is mounted for each project/round/step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (snapshot.generations) setRecords(snapshot.generations); }, [snapshot.generations]);
  async function run(action: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : '操作未完成，请刷新生成记录。'); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  async function reload() {
    const rows = await api.generations.query(scope);
    if (live.current) {
      if (rows.some(r => r.requestId === pending.current?.requestId)) { pending.current = null; setQuote(null); }
      setRecords(rows);
    }
    await refresh(scope.projectId, scope.roundId);
  }
  const unresolved = records.some(r => ['prepared', 'dispatched', 'responded', 'unknown'].includes(r.state));
  return <section className="mt-5 space-y-3 rounded-lg border border-white/10 p-4" aria-label="AI 候选生成">
    <h3 className="font-medium">AI 候选</h3>
    <p className="text-sm text-zinc-400">使用已保存的步骤内容和来源生成。候选需要你采用、编辑并确认；生成不会覆盖输入。</p>
    <label className="block text-sm">本次补充要求（可选）
      <textarea aria-label="AI 补充要求" value={instruction} maxLength={2000} disabled={busy}
        onChange={e => setInstruction(e.target.value)} className="mt-2 block w-full rounded border border-white/10 bg-black/20 p-3" />
    </label>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={disabled || busy || !!pending.current || unresolved || snapshot.state !== 'draft'} onClick={() => void run(async () => {
        const q = await api.generationQuote.mutate({ ...scope, stepId, instruction, expectedSteps });
        if (live.current) setQuote(q);
      })}>查看生成费用</Button>
      {quote && <Button disabled={disabled || busy || !!pending.current || unresolved} onClick={() => void run(async () => {
        // Retain the exact request after uncertain HTTP delivery. Refresh reads
        // server records; it never creates a replacement request automatically.
        pending.current ??= { ...scope, stepId, instruction, expectedSteps, requestId: crypto.randomUUID(), quoteHash: quote.quoteHash, budgetCredits: quote.reservedCredits };
        const result = await api.generate.mutate(pending.current);
        pending.current = null;
        if (live.current) { setQuote(null); setRecords(old => [...old.filter(r => r.requestId !== result.requestId), result]); }
        await reload();
      })}>生成候选（最多 {quote.reservedCredits} 积分）</Button>}
      {pending.current && <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
        const result = await api.generate.mutate(pending.current!);
        pending.current = null;
        if (live.current) { setQuote(null); setRecords(old => [...old.filter(r => r.requestId !== result.requestId), result]); }
        await reload();
      })}>重试同一生成请求</Button>}
      <Button variant="outline" disabled={busy} onClick={() => void run(reload)}>刷新生成记录</Button>
    </div>
    {disabled && <p className="text-sm text-zinc-400">请先保存编辑，再生成候选。</p>}
    {error && <p role="alert" className="text-sm text-amber-300">{error}</p>}
    <ul className="space-y-2 text-sm">{records.filter(r => r.stepId === stepId).map(r => <li key={r.requestId}>
      {states[r.state]} · 预留 {r.reservedCredits} 积分{r.chargedCredits !== null ? ` · 已结算 ${r.chargedCredits} 积分` : ''}
      {r.state === 'prepared' && <Button variant="outline" disabled={busy} className="ml-2" onClick={() => void run(async () => { await api.cancelGeneration.mutate({ ...scope, requestId: r.requestId }); await reload(); })}>取消未发送请求</Button>}
      {r.state === 'responded' && <Button variant="outline" disabled={busy} className="ml-2" onClick={() => void run(async () => { await api.recoverGeneration.mutate({ ...scope, requestId: r.requestId }); await reload(); })}>恢复已保存结果</Button>}
    </li>)}</ul>
  </section>;
}
