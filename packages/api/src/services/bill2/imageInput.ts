/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * LIB-2d: the only image a PAYG call may carry (LIB_DOCS_PLAN 4.4, BILL2 prerequisites 1–2).
 * Exactly one inline JPEG data URL, no remote URL, bounded bytes and edge, and only for
 * IMAGE_PURPOSES. The server reads the JPEG frame header for its size and never decodes pixels.
 * SQL bill2_payg_validate_quote (0286) repeats every rule here; keep the two in step.
 */
import { z } from 'zod';

/** Purposes that may send an image. PUBLISH-MONITOR PR-3c adds its own purpose here and in 0286's SQL list. */
export const IMAGE_PURPOSES: ReadonlySet<string> = new Set(['library_ocr']);
export const JPEG_DATA_URL_PREFIX = 'data:image/jpeg;base64,';
/** Hard ceilings; a stable policy may only lower them. 819_223 bytes = prefix + base64 of a 614,400-byte JPEG. */
export const IMAGE_MAX_DATA_URL_BYTES = 819_223;
export const IMAGE_MAX_EDGE = 2048;
export const IMAGE_TOKEN_OVERHEAD = 2048;
export const IMAGE_MIN_EDGE = 64;
export const IMAGE_MAX_ASPECT = 4;
/** Conservative input-token ceiling for one image of w×h pixels, independent of vendor:
 * twice the number of 14-pixel patches (the smallest common ViT patch, and tile padding at most
 * doubles it) plus a fixed overhead that covers the minimum tile cost of a tiny image. Known schemes (750 px²/token, 512/768 tiles, 28/32 px patches)
 * all stay below it within the allowed shapes (short edge ≥ 64 px, long ≤ 4 × short; tiled schemes
 * reach about 92% of it at worst). A real call that exceeds its frozen upper still trips budget_conflict. */
export function imageTokensUpper(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Math.min(width, height) < IMAGE_MIN_EDGE
    || Math.max(width, height) > IMAGE_MAX_EDGE || Math.max(width, height) > IMAGE_MAX_ASPECT * Math.min(width, height)) {
    throw new Error('BILL2_IMAGE_INVALID');
  }
  return 2 * Math.ceil(width / 14) * Math.ceil(height / 14) + IMAGE_TOKEN_OVERHEAD;
}

const count = z.number().int().positive();
/** Stable policy: the admin-admitted image allowance of one route. */
export const imageInputPolicy = z.object({
  maxDataUrlBytes: count.max(IMAGE_MAX_DATA_URL_BYTES), maxEdge: count.max(IMAGE_MAX_EDGE),
}).strict();
/** Call quote: the measured image of this exact request. */
export const imageQuote = z.object({
  dataUrlBytes: count.max(IMAGE_MAX_DATA_URL_BYTES), width: count.max(IMAGE_MAX_EDGE), height: count.max(IMAGE_MAX_EDGE),
  tokensUpper: count,
}).strict().refine(value => { try { return value.tokensUpper === imageTokensUpper(value.width, value.height); } catch { return false; } },
  { message: 'BILL2_IMAGE_BOUND_CONFLICT' });
export type ImageInputPolicy = z.infer<typeof imageInputPolicy>;
export type ImageQuote = z.infer<typeof imageQuote>;

const SOF = new Set([0xc0, 0xc1, 0xc2]);
/** Width and height from the single baseline/progressive frame header; refuses anything else. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  const fail = () => { throw new Error('BILL2_IMAGE_INVALID'); };
  const n = bytes.length;
  if (n < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[n - 2] !== 0xff || bytes[n - 1] !== 0xd9) fail();
  let i = 2;
  let frame: { width: number; height: number } | null = null;
  while (i < n) {
    if (bytes[i] !== 0xff) fail();
    while (i < n && bytes[i] === 0xff) i++;
    const marker = bytes[i++];
    if (marker === undefined || marker === 0xd8 || marker === 0xd9 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) fail();
    if (i + 2 > n) fail();
    const length = (bytes[i]! << 8) | bytes[i + 1]!;
    if (length < 2 || i + length > n) fail();
    if (marker === 0xda) break; // start of scan: the frame header must already be known
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (!SOF.has(marker) || frame || length < 8 || bytes[i + 2] !== 8) fail();
      const components = bytes[i + 7];
      if (components !== 1 && components !== 3) fail();
      frame = { height: (bytes[i + 3]! << 8) | bytes[i + 4]!, width: (bytes[i + 5]! << 8) | bytes[i + 6]! };
    }
    i += length;
  }
  if (!frame || frame.width < 1 || frame.height < 1) fail();
  return frame!;
}

type Part = Record<string, unknown>;
const imagePart = z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }).strict() }).strict();
/** Every image_url part in the request's messages, so callers can require exactly one. */
export function imageParts(messages: unknown): Part[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap(message => {
    const content = (message as { content?: unknown } | null)?.content;
    return Array.isArray(content) ? content.filter(part => (part as Part | null)?.type === 'image_url') as Part[] : [];
  });
}

/** Measures the one inline JPEG of a parsed request. Returns null when the request has no image part. */
export function measureImage(parsed: { messages?: unknown }, policy: ImageInputPolicy | undefined): ImageQuote | null {
  const parts = imageParts(parsed.messages);
  if (!parts.length) return null;
  if (!policy || parts.length !== 1) throw new Error('BILL2_IMAGE_DENIED');
  const checked = imagePart.safeParse(parts[0]);
  if (!checked.success) throw new Error('BILL2_IMAGE_DENIED');
  const url = checked.data.image_url.url;
  const dataUrlBytes = Buffer.byteLength(url);
  const payload = url.slice(JPEG_DATA_URL_PREFIX.length);
  if (!url.startsWith(JPEG_DATA_URL_PREFIX) || dataUrlBytes > policy.maxDataUrlBytes || !payload
    || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error('BILL2_IMAGE_DENIED');
  const { width, height } = jpegDimensions(Buffer.from(payload, 'base64'));
  if (width > policy.maxEdge || height > policy.maxEdge) throw new Error('BILL2_IMAGE_DENIED');
  return { dataUrlBytes, width, height, tokensUpper: imageTokensUpper(width, height) };
}
