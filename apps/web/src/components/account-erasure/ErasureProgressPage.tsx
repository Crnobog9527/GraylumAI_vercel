/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ProgressCredential } from './ProgressCredential';
import { queryErasureProgress, type ErasureProgress } from '@/lib/erasure-progress-client';
import {
  clearErasureHandoff, describeProgressError, formatProgressCredential, parseProgressCredential,
  readErasureHandoff, saveErasureHandoff, type ErasureHandoff,
} from '@/lib/erasure-progress';

const stages: Record<ErasureProgress['stage'], [string, string]> = {
  closed: ['账号已关闭', '账号已不能使用，后续清理尚未完成。'],
  erasing: ['正在清理', '私有内容清理仍在进行。'],
  billing_pending: ['等待账务处理', '账务尚未处理完毕，注销流程还未最终完成。'],
  completed: ['注销流程已完成', '依法保留的最少账务记录及备份、第三方副本仍按各自保留规则处理。'],
};
const dateText = (value: string) => new Date(value).toLocaleString('zh-CN');

export function ErasureProgressPage() {
  const [text, setText] = useState('');
  const [handoff, setHandoff] = useState<ErasureHandoff | null>(null);
  const [progress, setProgress] = useState<ErasureProgress | null>(null);
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    const saved = readErasureHandoff();
    setHandoff(saved);
    if (saved?.credential) setText(formatProgressCredential(saved.credential));
    return () => { generation.current += 1; };
  }, []);
  const edit = (value: string) => {
    generation.current += 1;
    setText(value);
    setProgress(null);
    setError('');
  };
  const query = async () => {
    if (inFlight.current) return;
    const credential = parseProgressCredential(text);
    setProgress(null);
    if (!credential) return setError('请输入完整的查询凭证。凭证遗失后无法找回或重新签发。');
    const version = ++generation.current;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await queryErasureProgress(credential);
      if (generation.current !== version) return;
      setProgress(result);
      const next = { credential, closed: true };
      setHandoff(next);
      if (!saveErasureHandoff(next)) setStorageWarning('浏览器无法保存会话副本，请自行保存凭证。');
    } catch (cause) {
      if (generation.current === version) setError(describeProgressError(cause));
    } finally { inFlight.current = false; setBusy(false); }
  };
  const clear = () => {
    edit('');
    setHandoff(null);
    setStorageWarning(clearErasureHandoff() ? '' : '无法清除浏览器会话副本，请在浏览器中清理此站点的会话数据。');
  };
  return (
    <main className="min-h-screen px-4 py-12" style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <div className="mx-auto max-w-xl space-y-6">
        <header className="space-y-2">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Graylum · 账号与数据</p>
          <h1 className="text-2xl font-semibold">注销进度</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>无需登录，仅凭查询凭证查看阶段和时间。</p>
        </header>
        {handoff && !handoff.credential && <p role="status">{handoff.closed
          ? '账号已关闭，当前无法查询进度。'
          : '未收到注销确认结果，账号可能已关闭，当前无法查询进度。请勿再次申请注销。'}</p>}
        <form className="space-y-4 rounded-2xl border p-5 sentry-block"
          style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)' }}
          onSubmit={event => { event.preventDefault(); void query(); }}>
          <label htmlFor="erasure-credential" className="block text-sm font-medium">粘贴查询凭证</label>
          <textarea id="erasure-credential" value={text} onChange={event => edit(event.target.value)} rows={3}
            autoComplete="off" spellCheck={false} maxLength={256} aria-describedby="credential-help"
            className="w-full rounded-lg border p-3 font-mono text-sm break-all"
            style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)' }} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>{busy ? '查询中…' : '查询进度'}</Button>
            <Button type="button" variant="outline" onClick={clear}>清除本机会话凭证</Button>
          </div>
          <p id="credential-help" className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            会话副本仅便于当前浏览器查询。关闭浏览器后，请使用自行保存的凭证；不提供遗失找回或重新签发。
          </p>
        </form>
        {error && <p role="alert">{error}</p>}
        {storageWarning && <p role="status">{storageWarning}</p>}
        {progress && <section aria-live="polite" className="space-y-3 rounded-2xl border p-5"
          style={{ borderColor: 'var(--border-primary)' }}>
          <h2 className="text-lg font-medium">{stages[progress.stage][0]}</h2>
          <p className="text-sm">{stages[progress.stage][1]}</p>
          {progress.needsReview && <p className="text-sm">需要人工核查，尚不能确认全部处理完毕。</p>}
          <dl className="space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <div><dt>确认注销时间</dt><dd>{dateText(progress.confirmedAt)}</dd></div>
            <div><dt>进度更新时间</dt><dd>{dateText(progress.updatedAt)}</dd></div>
          </dl>
          <p className="text-sm">这是最近一次查询结果。需要更新时，请手动查询。</p>
        </section>}
        {handoff?.credential && <ProgressCredential credential={handoff.credential} />}
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          凭证在待处理期间有效，注销完成后 30 天失效。没有凭证时无法查询，不代表账号未关闭。
          请勿为了找回凭证重新注销或创建账号。
        </p>
        <a href="/" className="inline-block text-sm underline">返回首页</a>
      </div>
    </main>
  );
}
