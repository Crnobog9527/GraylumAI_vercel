/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDay } from './founderAdminView';

export interface LivestreamItem { id: string; heldOn: string; topic: string; replayUrl: string | null }

export type CommunityEntry = { url: string | null; note: string | null; updatedAt?: string } | null;

function EntryFields({ current, pending, onSave }: {
  current: CommunityEntry; pending: boolean; onSave: (value: { url: string; note: string }) => void;
}) {
  const [url, setUrl] = useState(current?.url ?? '');
  const [note, setNote] = useState(current?.note ?? '');
  return <>
    <div className="space-y-1"><Label htmlFor="founder-entry-url">入口链接（https://）</Label>
      <Input id="founder-entry-url" value={url} onChange={event => setUrl(event.target.value)} maxLength={2048} /></div>
    <div className="space-y-1"><Label htmlFor="founder-entry-note">说明文字（例如微信群怎么加）</Label>
      <Input id="founder-entry-note" value={note} onChange={event => setNote(event.target.value)} maxLength={500} /></div>
    <Button type="button" disabled={pending} onClick={() => onSave({ url, note })} data-testid="founder-entry-save">保存入口</Button>
  </>;
}

/** Shows the saved entry in the fields; a failed read shows an error and retry instead of an empty form. */
export function FounderCommunityEntryForm({ pending, current, failed, onRetry, onSave }: {
  pending: boolean; current: CommunityEntry | undefined; failed: boolean; onRetry: () => void;
  onSave: (value: { url: string; note: string }) => void;
}) {
  return <Card data-testid="founder-community-entry">
    <CardHeader>
      <CardTitle>社群入口</CardTitle>
      <CardDescription>只给有效和宽限期的创始会员看。两项都留空再保存会清除入口。</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {current === undefined && failed ? <div role="alert" className="space-y-2" data-testid="founder-entry-error">
        <p>暂时无法读取当前的社群入口，请重试后再修改，避免覆盖已保存的内容。</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>重新读取</Button>
      </div> : current === undefined ? <p>读取中…</p>
        : <EntryFields key={`${current?.url ?? ''}|${current?.note ?? ''}|${current?.updatedAt ?? ''}`}
          current={current} pending={pending} onSave={onSave} />}
    </CardContent>
  </Card>;
}

export function FounderLivestreamPanel({ items, failed, onRetry, pending, onRecord }: {
  items: LivestreamItem[] | undefined; failed?: boolean; onRetry?: () => void; pending: boolean;
  onRecord: (value: { heldOn: string; topic: string; replayUrl: string }) => void;
}) {
  const [heldOn, setHeldOn] = useState('');
  const [topic, setTopic] = useState('');
  const [replayUrl, setReplayUrl] = useState('');
  return <Card data-testid="founder-livestreams">
    <CardHeader>
      <CardTitle>社群直播记录</CardTitle>
      <CardDescription>每月一次的社群内部直播。每场结束后记一条（日期、主题、可选回放链接），不要写会员个人信息。</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1"><Label htmlFor="founder-live-date">日期</Label>
          <Input id="founder-live-date" type="date" value={heldOn} onChange={event => setHeldOn(event.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="founder-live-topic">主题</Label>
          <Input id="founder-live-topic" value={topic} onChange={event => setTopic(event.target.value)} maxLength={120} /></div>
        <div className="space-y-1"><Label htmlFor="founder-live-replay">回放链接（可选）</Label>
          <Input id="founder-live-replay" value={replayUrl} onChange={event => setReplayUrl(event.target.value)} maxLength={2048} /></div>
      </div>
      <Button type="button" disabled={pending || failed || !heldOn || !topic.trim()} data-testid="founder-live-save"
        onClick={() => { onRecord({ heldOn, topic, replayUrl }); setTopic(''); setReplayUrl(''); }}>记录这一场</Button>
      {failed && !items ? <div role="alert" className="space-y-2" data-testid="founder-live-error">
        <p>暂时无法读取已有的直播记录，请重试后再录入，避免重复。</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>重新读取</Button>
      </div> : !items ? <p>读取中…</p> : items.length === 0 ? <p data-testid="founder-live-empty">还没有直播记录。</p>
        : <ul className="space-y-1 text-sm">{items.map(item => <li key={item.id}>
          {formatDay(item.heldOn) ?? item.heldOn}：{item.topic}{item.replayUrl ? `（回放 ${item.replayUrl}）` : ''}
        </li>)}</ul>}
    </CardContent>
  </Card>;
}
