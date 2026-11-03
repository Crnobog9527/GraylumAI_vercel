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
  /** A message that was not sent gives its images back, ahead of any added while it was being sent (restoredImages). */
  restore: (sent: readonly ChatImage[]) => void;
};

/**
 * The images back in the box after a message was not sent: the sent ones first (they belong to the text that comes back), then those
 * added meanwhile, at most CHAT_MAX_IMAGES; `dropped` counts the newest that no longer fit.
 */
export function restoredImages(sent: readonly ChatImage[], current: readonly ChatImage[]) {
  const merged = [...sent, ...current.filter(image => !sent.some(old => old.id === image.id))];
  return { images: merged.slice(0, CHAT_MAX_IMAGES), dropped: Math.max(merged.length - CHAT_MAX_IMAGES, 0) };
}

/**
 * Prepares the image files among `files` for the message, at most CHAT_MAX_IMAGES in all. `held` counts the images already attached
 * plus those still being prepared by earlier calls, so overlapping adds (a drop while a paste is still being made a JPEG) share the
 * limit; `pending` moves by one per file, up when it is taken and down when it is done, so sending waits until every add has finished.
 */
export async function prepareChatImages(files: Iterable<File> | ArrayLike<File> | null | undefined, deps: {
  held: () => number; pending: (change: 1 | -1) => void; attach: (image: ChatImage) => void; refuse: (message: string) => void;
  make?: (file: File) => Promise<ChatImage>;
}) {
  const picked = imageFiles(files);
  if (!picked.length) return;
  const room = CHAT_MAX_IMAGES - deps.held();
  if (picked.length > room) deps.refuse(`一条消息最多附 ${CHAT_MAX_IMAGES} 张图片，多出的没有加入。`);
  const taken = picked.slice(0, Math.max(room, 0));
  taken.forEach(() => deps.pending(1));
  for (const file of taken) {
    try { deps.attach(await (deps.make ?? chatImageFromFile)(file)); }
    catch (cause) { deps.refuse(cause instanceof Error ? cause.message : '这张图片读不了，请换一张再试。'); }
    finally { deps.pending(-1); }
  }
}

export function useChatImages(): ChatImages {
  const [images, setImages] = useState<ChatImage[]>([]), [pending, setPending] = useState(0), [error, setError] = useState('');
  const current = useRef(images); current.current = images;
  const preparing = useRef(0);
  const add = useCallback(async (files: Iterable<File> | ArrayLike<File> | null | undefined) => {
    setError('');
    await prepareChatImages(files, {
      held: () => current.current.length + preparing.current,
      pending: change => { preparing.current += change; setPending(count => count + change); },
      attach: image => setImages(old => old.length < CHAT_MAX_IMAGES ? [...old, image] : old),
      refuse: setError,
    });
  }, []);
  const remove = useCallback((id: string) => { setImages(old => old.filter(image => image.id !== id)); setError(''); }, []);
  const restore = useCallback((sent: readonly ChatImage[]) => {
    if (!sent.length) return;
    const next = restoredImages(sent, current.current);
    current.current = next.images; setImages(next.images);
    if (next.dropped) setError(`一条消息最多附 ${CHAT_MAX_IMAGES} 张图片：退回的图片已放回，之后新加的有 ${next.dropped} 张放不下，请重新添加。`);
  }, []);
  return { images, busy: pending > 0, error, add, remove, set: setImages, restore };
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
