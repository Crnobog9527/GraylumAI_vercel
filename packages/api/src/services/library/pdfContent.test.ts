/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { pdfContent, pdfCompleteInput, pdfFilename } from './pdfContent';
const text = { status: 'text', imageCoverage: 0 } as const;
const scanned = { status: 'scanned', imageCoverage: 0.5 } as const;
const blank = { status: 'blank', imageCoverage: 0 } as const;
const parse = (value: string, pages = [text]) => pdfContent(Buffer.from(value), pages);
describe('LIB-2c PDF extraction contract at the server boundary', () => {
  it('keeps ordered text slots, Unicode and page numbers; empty slots have no fabricated text', () => {
    const result = pdfContent(Buffer.from('第一页😀\n\f\f\f末页'), [text, scanned, blank, text]);
    expect(result.segments).toEqual([
      { title: '第 1 页', body: '第一页😀\n', page_number: 1 }, { title: '第 4 页', body: '末页', page_number: 4 },
    ]);
    expect(result.pages).toEqual(['text', 'scanned', 'blank', 'text'].map((status, i) => ({ status, page_number: i + 1 })));
  });
  it('accepts single scanned/blank pages with an exactly empty text object and 500 scanned slots', () => {
    expect(pdfContent(Buffer.alloc(0), [scanned]).segments).toEqual([]);
    expect(pdfContent(Buffer.alloc(0), [blank]).pages[0].status).toBe('blank');
    expect(pdfContent(Buffer.from('\f'.repeat(499)), Array(500).fill(scanned)).pages).toHaveLength(500);
  });
  it('matches extractor rounding at the image coverage threshold', () => {
    expect(pdfContent(Buffer.alloc(0), [{ ...blank, imageCoverage: 0.5 }]).pages[0].status).toBe('blank');
  });
  it('splits large pages without splitting a Unicode character or crossing a page', () => {
    const body = '😀'.repeat(4000);
    const result = parse(body + '\f末页', [text, text]);
    expect(result.segments.filter(s => s.page_number === 1).map(s => s.body).join('')).toBe(body);
    expect(result.segments.every(s => Buffer.byteLength(s.body) <= 8192 && s.body.isWellFormed())).toBe(true);
    expect(result.segments.at(-1)?.page_number).toBe(2);
  });
  it.each([
    ['x', [scanned]], ['', [text]], [' ', [blank]], ['x\fy', [text]], ['x', [text, blank]],
    ['', [{ ...scanned, imageCoverage: 0.49 }]], ['x', [{ ...text, imageCoverage: 0.1 }]],
    ['x', [{ ...text, imageCoverage: NaN }]], ['x', [{ ...text, url: 'https://untrusted.test' }]],
  ])('rejects inconsistent metadata instead of truncating or reclassifying: %s', (body, pages) => {
    expect(() => pdfContent(Buffer.from(body as string), pages as never)).toThrow('LIBRARY_PAGES');
  });
  it('rejects encoding, controls, bytes, page count and line overflow', () => {
    expect(() => pdfContent(Buffer.from([0xff]), [text])).toThrow('LIBRARY_ENCODING');
    expect(() => parse('x\0')).toThrow('LIBRARY_TYPE');
    expect(() => parse('x'.repeat(10_000_001))).toThrow('LIBRARY_TEXT_LIMIT');
    expect(() => pdfContent(Buffer.from('\f'.repeat(500)), Array(501).fill(blank))).toThrow('LIBRARY_PAGES');
    expect(() => parse('x'.repeat(65_537))).toThrow('LIBRARY_LINE_LIMIT');
    expect(pdfCompleteInput.safeParse({ documentId: '11111111-1111-4111-8111-111111111111', pageCount: 2, pages: [text] }).success).toBe(false);
  });
  it('keeps markup as data and rejects paths in original filenames', () => {
    expect(parse('<script>alert(1)</script>').segments[0].body).toBe('<script>alert(1)</script>');
    expect(() => pdfFilename('../x.pdf')).toThrow('LIBRARY_TYPE');
    expect(() => pdfFilename('x.docx')).toThrow('LIBRARY_TYPE');
    expect(() => pdfFilename('报告.PDF')).not.toThrow();
  });
});
