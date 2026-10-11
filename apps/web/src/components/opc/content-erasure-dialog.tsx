'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useContentErasure, type ContentErasureState } from '@/hooks/use-content-erasure';
import { ERASURE_TITLE, buildContentErasureLines, type ContentErasureTarget, type ErasureLine } from '@/lib/content-erasure';

const panelStyle = { background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' };
const ghostStyle = { background: 'transparent', borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' };
const dangerStyle = { background: '#dc2626', color: '#fff' };
const TONE_COLOR: Record<ErasureLine['tone'], string> = { warn: 'var(--color-primary)', info: 'var(--text-secondary)' };
const MESSAGE_COLOR: Record<ContentErasureState['messageTone'], string> = {
  error: '#fca5a5', notice: 'var(--color-primary)', done: 'var(--text-secondary)',
};

type ViewProps = {
  target: ContentErasureTarget;
  name?: string;
  state: ContentErasureState;
  onConfirm: () => void;
  onRetry: () => void;
  onClose: () => void;
};

/** Pure body of the dialog, so each state can be rendered and checked without a server. */
export function ContentErasureBody({ target, name, state, onConfirm, onRetry, onClose }: ViewProps) {
  const lines = state.preview && !state.finished ? buildContentErasureLines(state.preview) : [];
  const canConfirm = Boolean(state.preview) && !state.finished && !state.loading && !state.confirming;
  return <>
    {name && <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{name}</p>}
    {state.loading && !state.preview && <p role="status" className="flex items-center gap-2 text-sm">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true"/>正在核对会删除哪些内容…</p>}
    {state.previewError && <p role="alert" className="text-sm" style={{ color: MESSAGE_COLOR.error }}>{state.previewError}</p>}
    {lines.length > 0 && <ul className="space-y-2 text-sm" aria-label="删除影响">
      {lines.map((line) => <li key={line.text} style={{ color: TONE_COLOR[line.tone] }}>{line.text}</li>)}
    </ul>}
    {state.message && <p role={state.messageTone === 'error' ? 'alert' : 'status'} className="text-sm"
      style={{ color: MESSAGE_COLOR[state.messageTone] }}>{state.message}</p>}
    <DialogFooter className="gap-2">
      {state.finished ? <Button variant="outline" style={ghostStyle} onClick={onClose}>关闭</Button> : <>
        <Button variant="outline" style={ghostStyle} disabled={state.confirming} onClick={onClose}>取消</Button>
        {state.previewError && !state.preview
          ? <Button variant="outline" style={ghostStyle} disabled={state.loading} onClick={onRetry}>重新读取</Button>
          : <Button style={dangerStyle} disabled={!canConfirm} onClick={onConfirm}>
            {state.confirming ? '正在删除…' : ERASURE_TITLE[target.kind]}</Button>}
      </>}
    </DialogFooter>
  </>;
}

/**
 * Single-item permanent deletion (DATA-ERASURE D7). The confirm button sends the hash of the preview
 * the user just read; `onClose(finished)` tells the caller whether the content is gone.
 */
export function ContentErasureDialog({ target, name, relatedIds, onClose }: {
  target: ContentErasureTarget;
  name?: string;
  /** Other deleted ids (e.g. every version of a content family) whose local copies must go too. */
  relatedIds?: string[];
  onClose: (finished: boolean) => void;
}) {
  const erasure = useContentErasure(target, relatedIds);
  const close = () => {
    if (erasure.state.confirming) return;
    onClose(erasure.state.finished);
  };
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" style={panelStyle}>
      <DialogHeader>
        <DialogTitle style={{ color: 'var(--text-primary)' }}>{ERASURE_TITLE[target.kind]}</DialogTitle>
        <DialogDescription style={{ color: 'var(--text-secondary)' }}>
          {erasure.state.finished ? '删除已处理。' : '请先看清删除后会发生什么，确认后不能撤销。'}
        </DialogDescription>
      </DialogHeader>
      <ContentErasureBody target={target} name={name} state={erasure.state}
        onConfirm={() => void erasure.confirm()} onRetry={() => void erasure.retryPreview()} onClose={close}/>
    </DialogContent>
  </Dialog>;
}
