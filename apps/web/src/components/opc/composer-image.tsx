'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { chatImageFromFile, type ChatImage } from '@/lib/chat-image';

/**
 * PUBLISH-MONITOR B2: one screenshot for the next free chat message (shown in the composer's attachment slot). The model reads it with
 * that message only; the conversation keeps "[截图]" and the text, never the image.
 */
export function ComposerImage({ image, onChange, disabled = false }: {
  image: ChatImage | null; onChange: (image: ChatImage | null) => void; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(''), [reading, setReading] = useState(false);
  async function pick(file: File | undefined) {
    if (!file) return;
    setError(''); setReading(true);
    try { onChange(await chatImageFromFile(file)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '这张图片读不了，请换一张截图再试。'); }
    finally { setReading(false); if (input.current) input.current.value = ''; }
  }
  return <div className="flex flex-wrap items-center gap-2 px-1 pb-1 text-sm text-[var(--text-secondary)]">
    {image
      ? <span className="inline-flex max-w-full items-center gap-2 rounded-md border border-[var(--border-primary)] px-2 py-1">
        <img src={image.url} alt="已附截图" className="h-10 w-10 rounded object-cover"/>
        <span className="truncate">已附截图，只随这条消息发给模型，不会保存</span>
        <button type="button" aria-label="移除截图" disabled={disabled} onClick={() => onChange(null)}
          className="rounded p-1 hover:bg-[var(--bg-secondary)]"><X size={14}/></button>
      </span>
      : <button type="button" disabled={disabled || reading} onClick={() => input.current?.click()}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-[var(--bg-secondary)] disabled:opacity-50">
        <ImagePlus size={16}/>{reading ? '正在处理截图…' : '附一张截图'}
      </button>}
    <input ref={input} type="file" accept="image/*" aria-label="选择截图" hidden onChange={event => void pick(event.target.files?.[0])}/>
    {error && <span role="alert" className="text-[var(--text-primary)]">{error}</span>}
  </div>;
}
