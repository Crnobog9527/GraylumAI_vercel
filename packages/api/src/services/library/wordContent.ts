/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { beginInput, MAX_BYTES, type Segment } from './content';

export const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const wordBeginInput = beginInput.extend({ contentType: z.literal(WORD_MIME) });
export const wordHeadings = z.array(z.object({
  offset: z.number().int().min(0).max(MAX_BYTES), level: z.number().int().min(1).max(9),
  text: z.string().min(1).max(512),
}).strict()).max(10_000);
export const wordCompleteInput = z.object({ documentId: z.string().uuid(), headings: wordHeadings }).strict();

export function wordFilename(filename: string) {
  if (!/\.docx$/i.test(filename) || Buffer.byteLength(filename) > 1024
    || /[\x00-\x1f\x7f/\\]/.test(filename)) throw new Error('LIBRARY_TYPE');
}

/** Offsets are UTF-16 indices into exactly the browser's extracted text. Never parse Word or markup. */
export function wordSegments(bytes: Uint8Array, rawHeadings: z.infer<typeof wordHeadings>): Segment[] {
  const parsed = wordHeadings.safeParse(rawHeadings);
  if (!parsed.success) throw new Error('LIBRARY_HEADINGS');
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('LIBRARY_TEXT_LIMIT');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('LIBRARY_ENCODING'); }
  if (text.includes('\0')) throw new Error('LIBRARY_TYPE');
  let end = -1;
  for (const h of parsed.data) {
    if (h.offset < end || h.offset >= text.length || Buffer.byteLength(h.text) > 512
      || /[\r\n]/.test(h.text) || !h.text.trim() || !h.text.isWellFormed()
      || text.slice(h.offset, h.offset + h.text.length) !== h.text
      || h.offset > 0 && text[h.offset - 1] !== '\n'
      || !['', '\n', '\r'].includes(text[h.offset + h.text.length] ?? '')) throw new Error('LIBRARY_HEADINGS');
    end = h.offset + h.text.length;
  }
  const segments: Segment[] = [];
  const append = (chunk: string, title: string) => {
    let body = '';
    let size = 0;
    const flush = () => {
      if (body) segments.push({ title, body });
      if (segments.length > 10_000) throw new Error('LIBRARY_TEXT_LIMIT');
      body = ''; size = 0;
    };
    for (const line of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (Buffer.byteLength(line) > 65_536) throw new Error('LIBRARY_LINE_LIMIT');
      if (!line.trim()) flush();
      for (const char of line) {
        const width = Buffer.byteLength(char);
        if (size + width > 8192) flush();
        body += char; size += width;
      }
    }
    flush();
  };
  let offset = 0;
  let title = '';
  for (const h of parsed.data) {
    append(text.slice(offset, h.offset), title);
    offset = h.offset;
    title = h.text;
  }
  append(text.slice(offset), title);
  return segments;
}
