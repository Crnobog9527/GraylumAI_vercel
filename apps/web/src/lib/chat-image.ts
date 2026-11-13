/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/*
 * PUBLISH-MONITOR B2: screenshots for one free chat message, each made a JPEG in the browser within LIB-2d's limits (the server checks
 * them again, chatImage.ts): at most 2048 px a side, the short side at least 64 px, at most 4:1, and a data URL of at most 819,223
 * bytes (a 614,400-byte JPEG). A taller screenshot is padded with white to 4:1 rather than refused. The data URLs live only in the
 * page until they are sent; the server then keeps them with the message as chat photos (Owner 2026-11-13).
 */
export const CHAT_IMAGE_MAX_EDGE = 2048;
export const CHAT_IMAGE_MIN_EDGE = 64;
export const CHAT_IMAGE_MAX_ASPECT = 4;
export const CHAT_IMAGE_MAX_DATA_URL_BYTES = 819_223;
/** As the server's CHAT_MAX_IMAGES: four images and the longest message stay under the 4.5 MB request body. */
export const CHAT_MAX_IMAGES = 4;
const QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5];
/** Each step down after the qualities run out (a very detailed screenshot). */
const SHRINK = 0.8;

export type ChatImage = { id: string; name: string; url: string };

/**
 * Where the picture is drawn and how large the JPEG is: the picture scaled to fit `maxEdge` (never enlarged), then the canvas widened
 * with white to keep within 4:1 and at least 64 px on its short side.
 */
export function chatImageLayout(width: number, height: number, maxEdge = CHAT_IMAGE_MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const drawWidth = Math.max(1, Math.round(width * scale)), drawHeight = Math.max(1, Math.round(height * scale));
  const long = Math.max(drawWidth, drawHeight, CHAT_IMAGE_MIN_EDGE);
  const short = Math.max(CHAT_IMAGE_MIN_EDGE, Math.ceil(long / CHAT_IMAGE_MAX_ASPECT));
  const canvasWidth = drawWidth >= drawHeight ? long : Math.max(drawWidth, short);
  const canvasHeight = drawWidth >= drawHeight ? Math.max(drawHeight, short) : long;
  return { canvasWidth, canvasHeight, drawWidth, drawHeight,
    x: Math.floor((canvasWidth - drawWidth) / 2), y: Math.floor((canvasHeight - drawHeight) / 2) };
}

/** A picked, dropped or pasted image (PNG, JPEG, WebP and the rest the browser reads) as one JPEG data URL within the limits; throws a
 * sentence the page can show. */
export async function chatImageFromFile(file: File): Promise<ChatImage> {
  if (!file.type.startsWith('image/')) throw new Error('只能附图片（截图、PNG、JPG、WebP 等）。');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error(`图片「${file.name || '截图'}」读不了，请换一张再试。`); }
  try {
    let edge = Math.min(Math.max(bitmap.width, bitmap.height), CHAT_IMAGE_MAX_EDGE);
    for (let attempt = 0; attempt < 6; attempt++) {
      const layout = chatImageLayout(bitmap.width, bitmap.height, edge);
      const canvas = document.createElement('canvas');
      canvas.width = layout.canvasWidth; canvas.height = layout.canvasHeight;
      const context = canvas.getContext('2d');
      if (!context) break;
      // A JPEG has no transparency: transparent screenshots and the padding get a white background, not black.
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, layout.x, layout.y, layout.drawWidth, layout.drawHeight);
      for (const quality of QUALITIES) {
        const url = canvas.toDataURL('image/jpeg', quality);
        if (url.startsWith('data:image/jpeg;base64,') && new Blob([url]).size <= CHAT_IMAGE_MAX_DATA_URL_BYTES)
          return { id: crypto.randomUUID(), name: file.name || '截图', url };
      }
      edge = Math.floor(Math.max(layout.drawWidth, layout.drawHeight) * SHRINK);
    }
  } finally { bitmap.close(); }
  throw new Error(`图片「${file.name || '截图'}」压缩后仍然太大，请裁掉无关部分再试。`);
}

/** The image files among dropped, pasted or picked files. */
export const imageFiles = (files: Iterable<File> | ArrayLike<File> | null | undefined) =>
  Array.from(files ?? []).filter(file => file.type.startsWith('image/'));
