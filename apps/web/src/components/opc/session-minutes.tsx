/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { trpc } from '@/trpc/client';
import { runTurn } from '@/lib/turn-stream';
import { chatMinutesRequestId, minutesFileName, minutesNotice, type MinutesItem } from '@/lib/session-minutes';

/*
 * CONTENT-CONVERSATION-2 (Owner 2026-11-14): "整理纪要" of a free conversation and "整理本选题" of a topic window. Only when the
 * user presses the button (Owner 2026-10-03 item 45: never every turn). One turn of kind minutes (POST /api/turn); its request
 * id is kept in this browser first, so a second press or a reload resumes the same request and is never charged twice. The
 * minutes are listed by opc.sessionMinutes; the first version copies and exports them (Owner: "存到我的文档" after launch).
 */
const requestKey = (sessionId: string) => 'opc-minutes-request:' + sessionId;
const readKey = (sessionId: string) => { try { return localStorage.getItem(requestKey(sessionId)); } catch { return null; } };
const writeKey = (sessionId: string, value: string | null) => {
  try {
    if (value) localStorage.setItem(requestKey(sessionId), value);
    else localStorage.removeItem(requestKey(sessionId));
  } catch { /* storage off: no resume */ }
};

export type SessionMinutes = ReturnType<typeof useSessionMinutes>;

export function useSessionMinutes(sessionId: string, onSettled?: () => void) {
  const utils = trpc.useUtils();
  const [running, setRunning] = useState(false), [live, setLive] = useState(''), [notice, setNotice] = useState('');
  const [held, setHeld] = useState(false), [fromChat, setFromChat] = useState(false);
  // Requests the chat asked for that this page already started (or found started): one each, whatever re-renders.
  const asked = useRef(new Set<string>());
  const list = trpc.opc.sessionMinutes.useQuery({ sessionId }, { refetchInterval: query =>
    (query.state.data as MinutesItem[] | undefined)?.some(item => item.state !== 'closed') ? 4000 : false });
  useEffect(() => { setHeld(Boolean(readKey(sessionId))); }, [sessionId]);
  const started = useRef(false);
  const start = useCallback(async (chosen?: string) => {
    if (started.current) return;
    started.current = true;
    const requestId = chosen ?? readKey(sessionId) ?? crypto.randomUUID();
    writeKey(sessionId, requestId);
    setRunning(true); setLive(''); setNotice(''); setHeld(false); setFromChat(Boolean(chosen));
    try {
      const outcome = await runTurn({ kind: 'minutes', sessionId, requestId }, event => {
        if (event.type === 'text') setLive(text => text + event.delta);
      });
      // A definite answer ends the request; a dropped stream keeps it, so the next press resumes the same one.
      if (outcome.state === 'lost') { setHeld(true); setNotice(minutesNotice('LOST')); }
      else {
        writeKey(sessionId, null);
        const code = outcome.state === 'refused' ? outcome.code : outcome.last.type === 'error' ? outcome.last.code : null;
        if (code && code !== 'TURN_REQUEST_REPLAYED') setNotice(minutesNotice(code));
      }
    } finally {
      started.current = false;
      setRunning(false); setLive('');
      await utils.opc.sessionMinutes.invalidate({ sessionId });
      onSettled?.();
    }
  }, [sessionId, utils, onSettled]);
  const items = useMemo(() => (list.data ?? []) as MinutesItem[], [list.data]);
  /** CONTENT-CONVERSATION-2 PR3b: the reply of `turnId` asked for the minutes (request_minutes). Started once, with a request id
   *  derived from that turn, so a reload or another tab finds it started (turn_open replays it) and nothing is charged twice. True
   *  when this call started it. */
  const startFromChat = useCallback((turnId: number) => {
    const id = chatMinutesRequestId(turnId);
    if (!list.isSuccess || asked.current.has(id) || items.some(item => item.requestId === id)) return false;
    asked.current.add(id);
    void start(id);
    return true;
  }, [list.isSuccess, items, start]);
  return { items, running: running || items.some(item => item.state !== 'closed'), live, notice, held, fromChat, start, startFromChat,
    error: list.error, retry: () => list.refetch() };
}

/** The button: "整理纪要" in a free conversation, "整理本选题" in a topic window. */
export function MinutesButton({ minutes, label, disabled = false, onStarted }: {
  minutes: SessionMinutes; label: string; disabled?: boolean; onStarted?: () => void;
}) {
  return <Button size="sm" variant="outline" disabled={disabled || minutes.running}
    title={disabled ? '这段对话正在回复，写完再整理' : undefined}
    onClick={() => { onStarted?.(); void minutes.start(); }}>
    {minutes.running ? '正在整理…' : minutes.held ? '继续上次的整理' : label}
  </Button>;
}

function download(item: MinutesItem) {
  const url = URL.createObjectURL(new Blob([item.body ?? ''], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = minutesFileName(item.closedAt ?? item.openedAt);
  document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}

function MinutesCard({ item }: { item: MinutesItem }) {
  const [copied, setCopied] = useState(false);
  return <article className="space-y-2 rounded-xl border border-[var(--border-primary)] p-3">
    <div className="max-h-80 overflow-auto"><MessageMarkdown text={item.body ?? ''}/></div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline"
        onClick={() => void navigator.clipboard.writeText(item.body ?? '').then(() => setCopied(true), () => setCopied(false))}>
        {copied ? '已复制' : '复制'}</Button>
      <Button size="sm" variant="outline" onClick={() => download(item)}>导出 Markdown</Button>
    </div>
  </article>;
}

const when = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The right panel's part: what is being written now, the newest minutes, and the older ones. */
export function SessionMinutesPanel({ minutes, title, children }: { minutes: SessionMinutes; title: string; children?: React.ReactNode }) {
  const done = minutes.items.filter(item => item.available && item.body);
  const [latest, ...older] = done;
  // When a minutes turn starts, the panel comes into view: in a topic window it sits under the editor, out of sight
  // (staging validation of #2009: a press showed no change).
  const box = useRef<HTMLElement>(null);
  useEffect(() => { if (minutes.running) box.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [minutes.running]);
  if (!minutes.running && !done.length && !minutes.notice && !children) return null;
  return <section ref={box} aria-label={title} className="space-y-3 border-b border-[var(--border-primary)] p-4 text-sm">
    <header className="flex items-center justify-between gap-2"><h2 className="font-medium">{title}</h2>{children}</header>
    <p className="text-xs text-[var(--text-tertiary)]">点了才整理，按实际用量扣积分；纪要不会写进对话。可以复制或导出 Markdown。</p>
    {minutes.running && minutes.fromChat && <p role="status" className="text-xs text-[var(--text-secondary)]">
      已按你在聊天里的要求开始整理纪要；这次整理单独按实际用量扣积分。</p>}
    {minutes.notice && <p role="status" className="text-xs text-[var(--text-warning,#b45309)]">{minutes.notice}</p>}
    {minutes.running && <div aria-live="polite" className="rounded-xl border border-dashed border-[var(--border-primary)] p-3">
      {minutes.live ? <MessageMarkdown text={minutes.live} streaming/>
        : <p className="text-xs text-[var(--text-secondary)]">正在整理…</p>}</div>}
    {!minutes.running && latest && <MinutesCard item={latest}/>}
    {older.length > 0 && <details className="space-y-2">
      <summary className="cursor-pointer text-xs text-[var(--text-secondary)]">历史纪要（{older.length}）</summary>
      {older.map(item => <details key={item.turnId} className="ml-2">
        <summary className="cursor-pointer text-xs">{when(item.closedAt ?? item.openedAt)}</summary>
        <MinutesCard item={item}/></details>)}
    </details>}
  </section>;
}
