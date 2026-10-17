/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { beginInput, MAX_BYTES, type Segment } from './content';

export const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const wordBeginInput = beginInput.extend({ contentType: z.literal(WORD_MIME) });
export const wordHeadings = z.array(z.object({
  offset: z.number().int().min(0).max(MAX_BYTES), level: z.number().int().min(1).max(9),
  text: z.string().min(1).max(512),
}).strict()).max(10_000);
/** LIB-2d: UTF-16 offsets of the document's images in the extracted text, in order (LIB-2b `DocxImage.offset`). */
export const wordImages = z.array(z.object({ offset: z.number().int().min(0).max(MAX_BYTES) }).strict()).max(500);
export const wordCompleteInput = z.object({ documentId: z.string().uuid(), headings: wordHeadings, images: wordImages.optional() }).strict();

/** Segments plus, for each image, how many segments come before it (0280): its recognised text goes right there.
 * Each image offset is also a segment boundary, so text before and after an inline image never share a segment. */
export function wordSegmentsWithImages(bytes: Uint8Array, headings: z.infer<typeof wordHeadings>, images: z.infer<typeof wordImages>) {
  const parsed = wordImages.safeParse(images);
  if (!parsed.success) throw new Error('LIBRARY_INVALID');
  // A Word file that is only images has no text: every image sits before the (absent) first segment.
  if (!bytes.length) {
    if (!parsed.data.length || headings.length || parsed.data.some((image) => image.offset !== 0)) throw new Error('LIBRARY_INVALID');
    return { segments: [], anchors: parsed.data.map(() => ({ anchor: 0 })) };
  }
  const anchors: Array<{ anchor: number }> = [];
  const segments = wordSegments(bytes, headings, parsed.data.map((image) => image.offset), (count) => anchors.push({ anchor: count }));
  return { segments, anchors };
}

export function wordFilename(filename: string) {
  if (!/\.docx$/i.test(filename) || Buffer.byteLength(filename) > 1024
    || /[\x00-\x1f\x7f/\\]/.test(filename)) throw new Error('LIBRARY_TYPE');
}

/** Offsets are UTF-16 indices into exactly the browser's extracted text. Never parse Word or markup. */
export function wordSegments(bytes: Uint8Array, rawHeadings: z.infer<typeof wordHeadings>, breaks: number[] = [],
  onBreak: (segmentsBefore: number) => void = () => undefined): Segment[] {
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
      || h.text !== h.text.replace(/\s+/g, ' ').trim() || !h.text || !h.text.isWellFormed()
      || h.offset > 0 && text[h.offset - 1] !== '\n') throw new Error('LIBRARY_HEADINGS');
    // LIB-2b collapses whitespace in labels, but leaves the original tabs/line breaks in text.
    // Escape labels: user text never supplies executable regular expressions.
    const escaped = h.text.split(' ').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const match = new RegExp(`^\\s*${escaped}(?=[^\\S\\r\\n]*(?:\\r?\\n|$))`)
      .exec(text.slice(h.offset, h.offset + 65_537));
    if (!match || match[0].length > 65_536) throw new Error('LIBRARY_HEADINGS');
    end = h.offset + match[0].length;
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
  // Headings change the title; breaks (LIB-2d image offsets, in order) only end the current segment.
  let previous = -1;
  for (const at of breaks) {
    if (!Number.isInteger(at) || at < previous || at > text.length) throw new Error('LIBRARY_INVALID');
    previous = at;
  }
  const events = [...parsed.data.map((h) => ({ at: h.offset, heading: h })),
    ...breaks.map((at) => ({ at, heading: null }))].sort((a, b) => a.at - b.at || (a.heading ? 1 : -1));
  let offset = 0;
  let title = '';
  for (const event of events) {
    append(text.slice(offset, event.at), title);
    offset = event.at;
    if (event.heading) title = event.heading.text;
    else onBreak(segments.length);
  }
  append(text.slice(offset), title);
  return segments;
}
