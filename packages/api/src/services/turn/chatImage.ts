/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { CHAT_MAX_IMAGES, IMAGE_MAX_DATA_URL_BYTES, IMAGE_MAX_EDGE, measureImage, type ImageQuote } from './provider/imageInput';

/*
 * PUBLISH-MONITOR B2 (Owner 2026-11-03: a back-office screenshot is read by the model itself, as in any mainstream agent): a free chat
 * message may carry up to CHAT_MAX_IMAGES JPEGs, each within LIB-2d's limits (614,400 bytes, 2048 px a side). They go to the model
 * with that message only and are billed as its prompt tokens. Owner 10-27 "截图不长期保留": an image is never written anywhere: not to
 * Storage, not to session_messages (the conversation keeps imageMark(n) and the text), not to turn_call_raw (only the response body is
 * stored), not to a log. Nothing here logs, and no error carries the bytes.
 */
export type ChatImage = ImageQuote & { url: string };

/** What the model sees before the text, and the conversation keeps instead of the images: "[截图] " for one, "[截图×3] " for three. */
export const imageMark = (count: number) => count === 1 ? '[截图] ' : `[截图×${count}] `;

/** The data URLs as checked JPEGs within LIB-2d's limits, or null (too many, or any one of another type, size or shape). */
export function chatImages(urls: readonly string[]): ChatImage[] | null {
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > CHAT_MAX_IMAGES) return null;
  const images: ChatImage[] = [];
  for (const url of urls) {
    if (typeof url !== 'string' || Buffer.byteLength(url) > IMAGE_MAX_DATA_URL_BYTES) return null;
    try {
      const measured = measureImage({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] },
        { maxDataUrlBytes: IMAGE_MAX_DATA_URL_BYTES, maxEdge: IMAGE_MAX_EDGE });
      if (!measured) return null;
      images.push({ ...measured, url });
    } catch { return null; }
  }
  return images;
}

/** The current user message (the last one the SDK passes in) with the images after its text, as Chat Completions input_image parts. */
export function withImages<T>(incoming: T[], urls: readonly string[]): T[] {
  const last = incoming.length - 1;
  return incoming.map((item, index) => {
    const message = item as { type?: string; role?: string; content?: unknown };
    if (index !== last || message.role !== 'user' || typeof message.content !== 'string') return item;
    return { ...message, content: [{ type: 'input_text', text: message.content },
      ...urls.map(url => ({ type: 'input_image', image: url }))] } as T;
  });
}
