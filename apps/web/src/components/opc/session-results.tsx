/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/trpc/client';
import { PublishResultLink } from '@/app/(zh-hans)/app/publish-monitor/publish/publish-entry';
import {
  RESULT_TYPES, RESULT_TYPE_LABEL, groupResults, resultErrorText, saveProblem, saveRequestId,
  type ResultType, type SessionResultItem,
} from '@/lib/session-results';

/*
 * CONTENT-CONVERSATION-DRIVEN P2-B-lite: the free conversation's results folder. Every save is the user's click
 * (the AI never writes here); editing adds a version; deleting removes one result, never the reply.
 */
/** Under a completed reply: confirm type, title and the exact text before saving. */
export function SaveReplyButton({ sessionId, executionId, turnId, reply, savedItems, onOpenResults }: {
  sessionId: string; reply: string; savedItems: readonly SessionResultItem[]; onOpenResults?(): void;
} & ({ executionId: string; turnId?: undefined } | { turnId: number; executionId?: undefined })) {
  const utils = trpc.useUtils();
  const save = trpc.opc.sessionResultSave.useMutation(), saveTurn = trpc.opc.sessionResultSaveTurn.useMutation();
  const [open, setOpen] = useState(false), [type, setType] = useState<ResultType>('body');
  const [title, setTitle] = useState(''), [text, setText] = useState(reply), [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  async function confirm() {
    const source = turnId ?? executionId!;
    const problem = saveProblem(reply, text, savedItems, source);
    if (problem) { setError(problem); return; }
    setError(''); setSaved('');
    try {
      const fields = { sessionId, requestId: await saveRequestId(String(source), type, text), resultType: type,
        title: title.trim() || null, excerpt: text === reply ? null : text };
      const result = turnId !== undefined ? await saveTurn.mutateAsync({ ...fields, turnId })
        : await save.mutateAsync({ ...fields, executionId: executionId! });
      setOpen(false);
      setSaved(savedNotice(type, title.trim() || (result as Partial<SessionResultItem> | undefined)?.title || ''));
    } catch (cause) { setError(resultErrorText(cause)); }
    finally { await utils.opc.sessionResults.invalidate({ sessionId }); }
  }
  const reopen = () => { setText(reply); setError(''); if (savedItems[0]) setType(savedItems[0].resultType); setOpen(true); };
  if (!open) return <div className="mt-2 space-y-1"><Button variant="outline" size="sm" onClick={reopen}>
    {savedItems.length ? '再存一段到成果夹' : '保存到成果夹'}</Button>
    {saved && <p role="status" className="text-xs text-[var(--text-secondary)]">{saved}
      {onOpenResults && <Button size="sm" variant="link" onClick={onOpenResults}>查看成果夹</Button>}</p>}</div>;
  return <SaveReplyForm type={type} title={title} text={text} error={error} pending={save.isPending || saveTurn.isPending}
    onType={setType} onTitle={setTitle} onText={setText} onConfirm={() => void confirm()} onCancel={() => setOpen(false)}/>;
}

/** Saving closes the form, so say what was saved and where it lives. */
export function savedNotice(type: ResultType, title: string) {
  return `已保存到成果夹：${RESULT_TYPE_LABEL[type]}${title ? `「${title}」` : ''}。可在右侧「本对话成果夹」查看。`;
}

export function SaveReplyForm(props: {
  type: ResultType; title: string; text: string; error: string; pending: boolean;
  onType(value: ResultType): void; onTitle(value: string): void; onText(value: string): void; onConfirm(): void; onCancel(): void;
}) {
  return <section aria-label="保存到成果夹" className="mt-3 space-y-2 rounded-xl border border-[var(--border-primary)] p-3 text-sm">
    <label className="block">成果类型
      <select aria-label="成果类型" className="ml-2 rounded border px-2 py-1" value={props.type}
        onChange={event => props.onType(event.target.value as ResultType)}>
        {RESULT_TYPES.map(type => <option key={type} value={type}>{RESULT_TYPE_LABEL[type]}</option>)}
      </select>
    </label>
    <label className="block">标题（可不填）
      <input aria-label="成果标题" maxLength={80} className="mt-1 w-full rounded border px-2 py-1" value={props.title}
        onChange={event => props.onTitle(event.target.value)}/>
    </label>
    <label className="block">要保存的内容（可删掉不需要的部分，只保留回复里的原文）
      <textarea aria-label="要保存的内容" rows={6} className="mt-1 w-full rounded border px-2 py-1" value={props.text}
        onChange={event => props.onText(event.target.value)}/>
    </label>
    {props.error && <p role="alert" className="text-[var(--text-danger,#b42318)]">{props.error}</p>}
    <div className="flex gap-2">
      <Button size="sm" disabled={props.pending} onClick={props.onConfirm}>{props.pending ? '保存中…' : '确认保存'}</Button>
      <Button size="sm" variant="ghost" disabled={props.pending} onClick={props.onCancel}>取消</Button>
    </div>
  </section>;
}

/** The right panel: results grouped by type, each editable, deletable and with its older versions. */
export function SessionResultsPanel({ sessionId, items }: { sessionId: string; items: SessionResultItem[] }) {
  return <section aria-label="本对话成果夹" className="space-y-4 p-4 text-sm">
    <header><h2 className="font-medium">本对话成果夹</h2>
      <p className="text-xs text-[var(--text-tertiary)]">只放你确认保存的内容；修改会保留旧版本。</p></header>
    {groupResults(items).map(group => <section key={group.type} aria-label={group.label} className="space-y-2">
      <h3 className="text-xs font-medium text-[var(--text-secondary)]">{group.label}</h3>
      {group.items.map(item => <ResultCard key={item.familyId} sessionId={sessionId} item={item}/>)}
    </section>)}
  </section>;
}

function ResultCard({ sessionId, item }: { sessionId: string; item: SessionResultItem }) {
  const utils = trpc.useUtils();
  const edit = trpc.opc.sessionResultEdit.useMutation(), remove = trpc.opc.sessionResultDelete.useMutation();
  const [mode, setMode] = useState<'view' | 'edit' | 'history' | 'delete'>('view');
  // baseVersion: the version this edit started from. A newer version saved elsewhere must never be silently superseded.
  const [draft, setDraft] = useState({ title: item.title, body: item.body, requestId: '', baseVersion: item.version });
  const [error, setError] = useState('');
  const history = trpc.opc.sessionResultVersions.useQuery({ familyId: item.familyId }, { enabled: mode === 'history' });
  const refresh = () => utils.opc.sessionResults.invalidate({ sessionId });
  async function saveEdit() {
    // The server refuses these outright; say how to fix the draft instead of a vague pending state.
    if (!draft.body.trim()) { setError('内容不能为空。'); return; }
    if (draft.body.length > 20000) { setError('内容最多 20000 字，请缩短后再保存。'); return; }
    // One request id per edit attempt: a retry after an unclear failure never adds a second version.
    const requestId = draft.requestId || crypto.randomUUID();
    setDraft(current => ({ ...current, requestId }));
    try {
      await edit.mutateAsync({ familyId: item.familyId, requestId, expectedVersion: draft.baseVersion,
        title: draft.title.trim() || null, body: draft.body });
      setMode('view'); setError(''); setDraft(current => ({ ...current, requestId: '' }));
    } catch (cause) { setError(resultErrorText(cause)); } finally { await refresh(); }
  }
  async function confirmDelete() {
    try { await remove.mutateAsync({ familyId: item.familyId }); setError(''); }
    catch (cause) { setError(resultErrorText(cause)); } finally { await refresh(); }
  }
  return <ResultCardView item={item} mode={mode} draft={draft} error={error} pending={edit.isPending || remove.isPending}
    versions={history.data as SessionResultItem[] | undefined}
    historyError={Boolean(history.error)} onRetryHistory={() => void history.refetch()}
    onMode={next => { setMode(next); setError(''); if (next === 'edit') {
      setDraft({ title: item.title, body: item.body, requestId: '', baseVersion: item.version });
    } }}
    onDraft={value => setDraft(current => ({ ...current, ...value, requestId: '' }))}
    onSave={() => void saveEdit()} onDelete={() => void confirmDelete()} publish={<PublishResultLink familyId={item.familyId} sessionId={sessionId}/>}/>;
}

export function ResultCardView({ item, mode, draft, error, pending, versions, historyError, onRetryHistory, onMode, onDraft,
  onSave, onDelete, publish }: {
  item: SessionResultItem; mode: 'view' | 'edit' | 'history' | 'delete'; draft: { title: string; body: string };
  error: string; pending: boolean; versions?: SessionResultItem[]; historyError?: boolean; onRetryHistory?(): void;
  onMode(mode: 'view' | 'edit' | 'history' | 'delete'): void; onDraft(value: { title?: string; body?: string }): void;
  onSave(): void; onDelete(): void; publish?: ReactNode;
}) {
  return <article aria-label={item.title} className="space-y-2 rounded-lg border border-[var(--border-primary)] p-3">
    <header className="flex items-baseline justify-between gap-2">
      <strong className="truncate">{item.title}</strong>
      <span className="shrink-0 text-xs text-[var(--text-tertiary)]">第 {item.version} 版</span>
    </header>
    {!item.sourceAvailable && <p className="text-xs text-[var(--text-tertiary)]">生成它的回复已不可用，这里的内容仍保留。</p>}
    {mode === 'edit' ? <>
      <input aria-label="修改标题" maxLength={80} className="w-full rounded border px-2 py-1" value={draft.title}
        onChange={event => onDraft({ title: event.target.value })}/>
      <textarea aria-label="修改内容" rows={8} maxLength={20000} className="w-full rounded border px-2 py-1" value={draft.body}
        onChange={event => onDraft({ body: event.target.value })}/>
    </> : <p className="max-h-48 overflow-auto whitespace-pre-wrap">{item.body}</p>}
    {mode === 'history' && <ol aria-label="历史版本" className="space-y-2 border-t pt-2">
      {(versions ?? []).map(version => <li key={version.id}><span className="text-xs text-[var(--text-tertiary)]">第 {version.version} 版</span>
        <p className="max-h-32 overflow-auto whitespace-pre-wrap">{version.body}</p></li>)}
      {!versions && !historyError && <li className="text-xs">正在读取历史版本…</li>}
      {!versions && historyError && <li className="text-xs" role="alert">历史版本暂时读不出来。
        <Button size="sm" variant="ghost" onClick={onRetryHistory}>重试</Button></li>}
    </ol>}
    {mode === 'delete' && <p role="alert">删除后这一项的所有版本都会消失，生成它的回复仍保留在对话里。</p>}
    {error && <p role="alert" className="text-[var(--text-danger,#b42318)]">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {mode === 'edit' && <><Button size="sm" disabled={pending} onClick={onSave}>保存修改</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => onMode('view')}>取消</Button></>}
      {mode === 'delete' && <><Button size="sm" variant="destructive" disabled={pending} onClick={onDelete}>确认删除</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => onMode('view')}>取消</Button></>}
      {(mode === 'view' || mode === 'history') && <>
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(item.body)}>复制</Button>
        <Button size="sm" variant="outline" onClick={() => onMode('edit')}>编辑</Button>
        {publish}
        {item.versions > 1 && <Button size="sm" variant="ghost" onClick={() => onMode(mode === 'history' ? 'view' : 'history')}>
          {mode === 'history' ? '收起历史版本' : `历史版本（${item.versions}）`}</Button>}
        <Button size="sm" variant="ghost" onClick={() => onMode('delete')}>删除</Button>
      </>}
    </div>
  </article>;
}
