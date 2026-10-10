/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

export const MAX_BYTES = 10_000_000;
export const BUCKET = 'library-documents';
export const formats = {
  txt: 'text/plain', md: 'text/markdown', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
} as const;
export type Format = keyof typeof formats;
export const beginInput = z.object({
  requestId: z.string().uuid(), filename: z.string().min(1).max(255),
  contentType: z.enum(['text/plain', 'text/markdown', 'image/jpeg', 'image/png', 'image/webp']),
  bytes: z.number().int().min(1).max(MAX_BYTES), purpose: z.enum(['authored', 'reference']),
}).strict();
export function formatFor(filename: string, mime: string): Format {
  const extension = filename.split('.').at(-1)?.toLowerCase();
  const format = extension === 'jpg' ? 'jpeg' : extension;
  if (!format || !(format in formats) || formats[format as Format] !== mime
    || Buffer.byteLength(filename) > 1024 || /[\x00-\x1f\x7f/\\]/.test(filename)) throw new Error('LIBRARY_TYPE');
  return format as Format;
}
export function verifyHeader(format: Format, bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  const valid = format === 'png' ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : format === 'jpeg' ? b[0] === 255 && b[1] === 216 && b[2] === 255
      : format === 'webp' ? b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
        : !b.includes(0);
  if (!valid) throw new Error('LIBRARY_TYPE');
}
export type Segment = { title: string; body: string };
export function textSegments(bytes: Uint8Array): Segment[] {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('LIBRARY_TEXT_LIMIT');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('LIBRARY_ENCODING'); }
  if (text.includes('\0')) throw new Error('LIBRARY_TYPE');
  const segments: Segment[] = [];
  let title = '';
  let body = '';
  let size = 0;
  const flush = () => { if (body) segments.push({ title, body }); body = ''; size = 0; };
  // Keep original line endings and whitespace; never execute or render markup.
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (Buffer.byteLength(line) > 65_536) throw new Error('LIBRARY_LINE_LIMIT');
    if (/^#{1,6}\s/.test(line)) {
      flush();
      title = [...line.trim()].slice(0, 128).join('');
    } else if (!line.trim()) flush();
    for (const char of line) {
      const width = Buffer.byteLength(char);
      if (size + width > 8192) flush();
      body += char; size += width;
    }
  }
  flush();
  if (segments.length > 10_000) throw new Error('LIBRARY_TEXT_LIMIT');
  return segments;
}
export function canonicalPath(path: string) {
  return /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/(original|text)$/.test(path)
    && path.split('/').slice(0, 2).every(value => z.string().uuid().safeParse(value).success);
}
