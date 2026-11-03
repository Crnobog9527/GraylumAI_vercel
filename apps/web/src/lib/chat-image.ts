/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/*
 * PUBLISH-MONITOR B2: a screenshot for one free chat message, made a JPEG in the browser within LIB-2d's limits (the server checks them
 * again, chatImage.ts): at most 2048 px a side and a data URL of at most 819,223 bytes (a 614,400-byte JPEG). The data URL lives only in
 * the page until it is sent; nothing stores it.
 */
export const CHAT_IMAGE_MAX_EDGE = 2048;
export const CHAT_IMAGE_MAX_DATA_URL_BYTES = 819_223;
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5];
/** Each step down after the qualities run out (a very detailed screenshot). */
const SHRINK = 0.8;

export type ChatImage = { name: string; url: string };

/** The size that fits `maxEdge` on both sides, keeping the aspect (never enlarged). */
export function fitEdge(width: number, height: number, maxEdge = CHAT_IMAGE_MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A picked image file as one JPEG data URL within the limits; throws a sentence the page can show. */
export async function chatImageFromFile(file: File): Promise<ChatImage> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件（截图、JPG 或 PNG）。');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('这张图片读不了，请换一张截图再试。'); }
  try {
    let edge = Math.max(bitmap.width, bitmap.height);
    for (let attempt = 0; attempt < 6; attempt++) {
      const size = fitEdge(bitmap.width, bitmap.height, Math.min(edge, CHAT_IMAGE_MAX_EDGE));
      const canvas = document.createElement('canvas');
      canvas.width = size.width; canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) break;
      // A JPEG has no transparency: transparent screenshots get a white background, not black.
      context.fillStyle = '#fff'; context.fillRect(0, 0, size.width, size.height);
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      for (const quality of QUALITIES) {
        const url = canvas.toDataURL('image/jpeg', quality);
        if (url.startsWith('data:image/jpeg;base64,') && new Blob([url]).size <= CHAT_IMAGE_MAX_DATA_URL_BYTES) return { name: file.name, url };
      }
      edge = Math.floor(Math.max(size.width, size.height) * SHRINK);
    }
  } finally { bitmap.close(); }
  throw new Error('这张截图压缩后仍然太大，请裁掉无关部分再试。');
}
