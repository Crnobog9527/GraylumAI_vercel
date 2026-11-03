/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { IMAGE_MAX_DATA_URL_BYTES, IMAGE_MAX_EDGE, measureImage, type ImageQuote } from './provider/imageInput';

/*
 * PUBLISH-MONITOR B2 (Owner 2026-11-03: a back-office screenshot is read by the model itself): a free chat message may carry one
 * JPEG, LIB-2d's limits (614,400 bytes, 2048 px a side). It goes to the model with that message only. Owner 10-27 "截图不长期保留":
 * the image is never written anywhere: not to Storage, not to session_messages (the conversation keeps IMAGE_MARK and the text),
 * not to turn_call_raw (only the response body is stored), not to a log. Nothing here logs, and no error carries the bytes.
 */
export const IMAGE_MARK = '[截图] ';

export type ChatImage = ImageQuote & { url: string };

/** The data URL as one checked JPEG within LIB-2d's limits, or null (any other type, size or shape). */
export function chatImage(url: string): ChatImage | null {
  if (typeof url !== 'string' || Buffer.byteLength(url) > IMAGE_MAX_DATA_URL_BYTES) return null;
  try {
    const measured = measureImage({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] },
      { maxDataUrlBytes: IMAGE_MAX_DATA_URL_BYTES, maxEdge: IMAGE_MAX_EDGE });
    return measured ? { ...measured, url } : null;
  } catch { return null; }
}

/** The current user message (the last one the SDK passes in) with the image after its text, as the Chat Completions input_image. */
export function withImage<T>(incoming: T[], url: string): T[] {
  const last = incoming.length - 1;
  return incoming.map((item, index) => {
    const message = item as { type?: string; role?: string; content?: unknown };
    if (index !== last || message.role !== 'user' || typeof message.content !== 'string') return item;
    return { ...message, content: [{ type: 'input_text', text: message.content }, { type: 'input_image', image: url }] } as T;
  });
}
