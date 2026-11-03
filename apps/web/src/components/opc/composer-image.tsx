'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { CHAT_MAX_IMAGES, chatImageFromFile, imageFiles, type ChatImage } from '@/lib/chat-image';

/**
 * PUBLISH-MONITOR B2 (Owner 11-03: "和主流 Agent 一样"): screenshots for the next free chat message, added from the composer's "+" menu,
 * dropped on the conversation or pasted into the box. The model reads them with that message only; the conversation keeps "[截图]" and
 * the text, never an image.
 */
export type ChatImages = {
  images: ChatImage[]; busy: boolean; error: string;
  add: (files: Iterable<File> | ArrayLike<File> | null | undefined) => Promise<void>;
  remove: (id: string) => void; set: (images: ChatImage[]) => void;
};

export function useChatImages(): ChatImages {
  const [images, setImages] = useState<ChatImage[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const current = useRef(images); current.current = images;
  const add = useCallback(async (files: Iterable<File> | ArrayLike<File> | null | undefined) => {
    const picked = imageFiles(files);
    if (!picked.length) return;
    setError('');
    const room = CHAT_MAX_IMAGES - current.current.length;
    if (picked.length > room) setError(`一条消息最多附 ${CHAT_MAX_IMAGES} 张图片，多出的没有加入。`);
    if (room <= 0) return;
    setBusy(true);
    try {
      for (const file of picked.slice(0, room)) {
        try {
          const image = await chatImageFromFile(file);
          setImages(old => old.length < CHAT_MAX_IMAGES ? [...old, image] : old);
        } catch (cause) { setError(cause instanceof Error ? cause.message : '这张图片读不了，请换一张再试。'); }
      }
    } finally { setBusy(false); }
  }, []);
  const remove = useCallback((id: string) => { setImages(old => old.filter(image => image.id !== id)); setError(''); }, []);
  return { images, busy, error, add, remove, set: setImages };
}

/** The thumbnails above the text, each removable, with the processing state and any refusal. */
export function ComposerImages({ state, disabled = false }: { state: ChatImages; disabled?: boolean }) {
  if (!state.images.length && !state.busy && !state.error) return null;
  return <div className="flex flex-wrap items-center gap-2 px-1 pb-1 text-sm text-[var(--text-secondary)]" aria-label="已附图片">
    {state.images.map((image, index) => <span key={image.id} className="relative inline-flex">
      {/* A local data URL preview, never a remote image. */}
      <img src={image.url} alt={`已附图片 ${index + 1}`} className="h-14 w-14 rounded-md border border-[var(--border-primary)] object-cover"/>
      <button type="button" aria-label={`移除图片 ${index + 1}`} disabled={disabled} onClick={() => state.remove(image.id)}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-[var(--border-primary)] bg-[var(--bg-primary)] p-0.5"><X size={12}/></button>
    </span>)}
    {state.busy && <span role="status">正在处理图片…</span>}
    {state.images.length > 0 && !state.busy && <span>图片只随这条消息发给模型，不会保存</span>}
    {state.error && <span role="alert" className="text-[var(--text-primary)]">{state.error}</span>}
  </div>;
}
