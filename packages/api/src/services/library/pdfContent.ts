/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { beginInput, MAX_BYTES } from './content';
import { wordSegments } from './wordContent';

export const PDF_MIME = 'application/pdf';
export const pdfBeginInput = beginInput.extend({ contentType: z.literal(PDF_MIME) });
// Matches LIB-2c PdfExtraction.pages. Order and form-feed slots encode page number and UTF-16 positions.
export const pdfPages = z.array(z.object({
  status: z.enum(['text', 'scanned', 'blank']), imageCoverage: z.number().min(0).max(1),
}).strict()).min(1).max(500);
export const pdfCompleteInput = z.object({
  documentId: z.string().uuid(), pageCount: z.number().int().min(1).max(500), pages: pdfPages,
}).strict().refine(v => v.pageCount === v.pages.length, 'LIBRARY_PAGES');
export function pdfFilename(filename: string) {
  if (!/\.pdf$/i.test(filename) || Buffer.byteLength(filename) > 1024
    || /[\x00-\x1f\x7f/\\]/.test(filename)) throw new Error('LIBRARY_TYPE');
}
export function pdfContent(bytes: Uint8Array, rawPages: z.infer<typeof pdfPages>) {
  const parsed = pdfPages.safeParse(rawPages);
  if (!parsed.success) throw new Error('LIBRARY_PAGES');
  if (bytes.length > MAX_BYTES) throw new Error('LIBRARY_TEXT_LIMIT');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('LIBRARY_ENCODING'); }
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f\u2028\u2029]/.test(text)) throw new Error('LIBRARY_TYPE');
  const slots = text.split('\f');
  if (slots.length !== parsed.data.length) throw new Error('LIBRARY_PAGES');
  const segments: { title: string; body: string; page_number: number }[] = [];
  const pages = parsed.data.map((page, index) => {
    const body = slots[index];
    if ((page.status === 'text') !== /\S/u.test(body) || (page.status !== 'text' && body !== '')
      || (page.status === 'text' && page.imageCoverage !== 0)
      || (page.status === 'scanned' && page.imageCoverage < 0.5)) throw new Error('LIBRARY_PAGES');
    if (body) for (const segment of wordSegments(Buffer.from(body), [])) {
      segments.push({ ...segment, title: `第 ${index + 1} 页`, page_number: index + 1 });
      if (segments.length > 10_000) throw new Error('LIBRARY_TEXT_LIMIT');
    }
    return { page_number: index + 1, status: page.status };
  });
  return { segments, pages };
}
