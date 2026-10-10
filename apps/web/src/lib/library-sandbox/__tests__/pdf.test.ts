/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB-2c unit tests: the pure parts of PDF extraction (text assembly, image coverage, byte checks,
// reply validation), the build-time pdf.js patches and the feature flag. pdf.js itself is exercised
// in real Chromium by pdf.browser.test.ts and pdf-quality.browser.test.ts.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFJS_PATCHES, PDFJS_WORKER_BUILD, patchPdfjsWorker } from '../../../../scripts/library-sandbox-pdfjs.mjs';
import { sandboxErrorMessage } from '../errors';
import { isLibraryPdfExtractionEnabled } from '../feature-flag';
import { normalizeCjkRadicals } from '../pdf/cjk-radicals';
import { extractPdfInBrowser } from '../pdf/client';
import { imageCoverage, type CoverageOps } from '../pdf/image-coverage';
import { hasTextLayer, pageText } from '../pdf/page-text';
import { mentionsEncryption, precheckPdf } from '../pdf/precheck';
import { validatePdfExtraction } from '../pdf/result';
import { normalizePdfText, pageInReadingOrder, pdfCharacterAccuracy } from './pdf-quality/metrics';

afterEach(() => {
  vi.unstubAllEnvs();
});

const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));

describe('feature flag and input checks', () => {
  it('is off unless the build sets it to exactly "true"', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION', '');
    expect(isLibraryPdfExtractionEnabled()).toBe(false);
    await expect(extractPdfInBrowser(new Blob(['%PDF-']))).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION', '1');
    expect(isLibraryPdfExtractionEnabled()).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION', 'true');
    expect(isLibraryPdfExtractionEnabled()).toBe(true);
  });

  it('is independent of the Word flag', () => {
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION', 'true');
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION', '');
    expect(isLibraryPdfExtractionEnabled()).toBe(false);
  });

  it('checks size before loading anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION', 'true');
    await expect(extractPdfInBrowser(new Blob([]))).rejects.toMatchObject({ code: 'INPUT_EMPTY' });
    await expect(extractPdfInBrowser(new Blob([new Uint8Array(10_000_001)]))).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
  });

  it('words PDF errors for users without leaking codes', () => {
    expect(sandboxErrorMessage('PDF_ENCRYPTED', 'pdf')).toBe('不支持加密或带密码的 PDF，请去掉密码后再上传。');
    expect(sandboxErrorMessage('FEATURE_DISABLED', 'pdf')).toContain('PDF');
    expect(sandboxErrorMessage('PDF_INVALID', 'pdf')).toContain('PDF');
    expect(sandboxErrorMessage('SANDBOX_TIMEOUT', 'pdf')).toBe(sandboxErrorMessage('SANDBOX_TIMEOUT'));
    expect(sandboxErrorMessage('ZIP_INVALID')).toContain('Word');
  });
});

describe('pdf.js build patches', () => {
  it('apply exactly once to the pinned pdf.js worker build', () => {
    const source = readFileSync(PDFJS_WORKER_BUILD, 'utf8');
    const patched = patchPdfjsWorker(source);
    for (const patch of PDFJS_PATCHES) {
      expect(patched.split(patch.replacement).length - 1, patch.name).toBe((patch as { count?: number }).count ?? 1);
      if (!patch.replacement.includes(patch.target)) expect(patched.includes(patch.target), patch.name).toBe(false);
    }
    expect(patched).toContain('graylum: decoded stream limit');
    expect(patched).toContain('"graylum:skipped-image"');
    expect(patched.startsWith('function __graylumCountObjects(count)')).toBe(true);
  });

  it('refuse to build when pdf.js no longer matches', () => {
    expect(() => patchPdfjsWorker('nothing to patch')).toThrow(/matched 0 times/);
    const source = readFileSync(PDFJS_WORKER_BUILD, 'utf8');
    expect(() => patchPdfjsWorker(source + PDFJS_PATCHES[0].target)).toThrow(/matched 2 times, expected 1/);
  });

  it('fail closed: without the sandbox guard every decoded stream is refused', () => {
    const body = PDFJS_PATCHES[0].replacement;
    const ensureBuffer = new Function('requested', `${body.slice(body.indexOf('{') + 1)}`) as (requested: number) => unknown;
    expect(() => ensureBuffer.call({ buffer: new Uint8Array(0), minBufferLength: 512 }, 1)).toThrow(/decoded stream limit/);
  });
});

describe('page text', () => {
  const frame = { transform: [1, 0, 0, -1, 0, 842], height: 842 };
  const at = (str: string, y: number, hasEOL = true) => ({ str, hasEOL, transform: [12, 0, 0, 12, 72, y] });

  it('keeps stream order and line ends, trims and drops control characters', () => {
    const text = pageText([{ str: 'Hello', hasEOL: false }, { str: ' ', hasEOL: false }, { str: 'world\f\u0000', hasEOL: true },
      { str: '第二行  ', hasEOL: true }, { str: '', hasEOL: true }, { str: '', hasEOL: true }, { str: '\tend', hasEOL: false }]);
    expect(text).toBe('Hello world\n第二行\n\n\tend');
    expect(text).not.toContain('\f');
  });

  it('moves running headers and footers drawn after the body to the page edges', () => {
    const items = [at('Body one', 700), at('Body two', 680), at('Header', 820), at('Page 1', 20)];
    expect(pageText(items, frame)).toBe('Header\nBody one\nBody two\nPage 1');
    expect(pageText(items)).toBe('Body one\nBody two\nHeader\nPage 1');
  });

  it('uses the rotated page frame to find the edges', () => {
    // A page rotated 90°: user-space x runs top to bottom.
    const rotated = { transform: [0, 1, 1, 0, 0, 0], height: 595 };
    const item = (str: string, x: number) => ({ str, hasEOL: true, transform: [12, 0, 0, 12, x, 300] });
    expect(pageText([item('Body', 300), item('Top', 10)], rotated)).toBe('Top\nBody');
  });

  it('maps CJK radicals a PDF writer used in place of ordinary characters', () => {
    expect(pageText([{ str: '选题⽅法：常⻅问题、⻆度和⻓期', hasEOL: false }])).toBe('选题方法：常见问题、角度和长期');
    expect(normalizeCjkRadicals('⼀⼆⼈⻢⻔')).toBe('一二人马门');
    expect(normalizeCjkRadicals('plain 中文 text')).toBe('plain 中文 text');
  });

  it('only counts visible characters as a text layer', () => {
    expect(hasTextLayer(' \n\t ')).toBe(false);
    expect(hasTextLayer('章')).toBe(true);
  });
});

describe('image coverage', () => {
  const OPS: CoverageOps = { save: 10, restore: 11, transform: 12, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
    paintImageXObject: 85, paintImageMaskXObject: 83, paintInlineImageXObject: 86, paintImageXObjectRepeat: 88 };
  const view = [0, 0, 595, 842];
  const image = ['graylum:skipped-image', 100, 100];

  it('measures images placed by the transformation matrix, clipped to the page', () => {
    expect(imageCoverage([OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore], [[], [595, 0, 0, 842, 0, 0], image, []], view, OPS))
      .toBe(1);
    expect(imageCoverage([OPS.transform, OPS.paintImageXObject], [[595, 0, 0, 421, 0, 0], image], view, OPS)).toBeCloseTo(0.5, 1);
    expect(imageCoverage([OPS.transform, OPS.paintImageXObject], [[5000, 0, 0, 5000, -100, -100], image], view, OPS)).toBe(1);
    expect(imageCoverage([OPS.paintImageXObject], [image], view, OPS)).toBeLessThan(0.01);
  });

  it('restores the matrix after save/restore and form XObjects', () => {
    const fns = [OPS.save, OPS.transform, OPS.restore, OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd, OPS.paintImageXObject];
    const args = [[], [595, 0, 0, 842, 0, 0], [], [[595, 0, 0, 842, 0, 0], [0, 0, 1, 1]], [], image];
    expect(imageCoverage(fns, args, view, OPS)).toBeLessThan(0.01);
    expect(imageCoverage([OPS.paintFormXObjectBegin, OPS.paintImageXObject], [[[595, 0, 0, 842, 0, 0], null], image], view, OPS)).toBe(1);
  });

  it('counts repeated images and overlapping images once', () => {
    const positions = new Float32Array([0, 0, 297.5, 0, 0, 421, 297.5, 421]);
    expect(imageCoverage([OPS.paintImageXObjectRepeat], [['x', 297.5, 421, positions]], view, OPS)).toBe(1);
    const twice = [OPS.transform, OPS.paintImageXObject, OPS.paintImageXObject];
    expect(imageCoverage(twice, [[595, 0, 0, 421, 0, 0], image, image], view, OPS)).toBeCloseTo(0.5, 1);
  });

  it('ignores malformed operands and empty page boxes', () => {
    expect(imageCoverage([OPS.transform, OPS.paintImageXObject], [['a', 1], image], view, OPS)).toBeLessThan(0.01);
    expect(imageCoverage([OPS.paintImageXObject], [image], [0, 0, 0, 0], OPS)).toBe(0);
    expect(imageCoverage([OPS.restore, OPS.paintFormXObjectEnd], [[], []], view, OPS)).toBe(0);
  });
});

describe('byte checks before pdf.js', () => {
  it('needs the PDF header in the first 1,024 bytes', () => {
    expect(() => precheckPdf(bytes('%PDF-1.7\n'))).not.toThrow();
    expect(() => precheckPdf(bytes(`${' '.repeat(1000)}%PDF-1.4`))).not.toThrow();
    expect(() => precheckPdf(bytes(`${' '.repeat(1020)}%PDF-1.4`))).toThrow(expect.objectContaining({ code: 'PDF_INVALID' }));
    expect(() => precheckPdf(bytes('<html>%PDF-'.slice(0, 6)))).toThrow(expect.objectContaining({ code: 'PDF_INVALID' }));
  });

  it.each([
    'trailer << /Root 1 0 R /Encrypt 9 0 R >>',
    'trailer << /Encrypt<< /Filter /Standard >> >>',
    '<< /Type /XRef /Encrypt\n%comment\n12 0 R >>',
  ])('recognises an encryption dictionary for the error wording only: %s', (trailer) => {
    expect(mentionsEncryption(bytes(`%PDF-1.7\n${trailer}`))).toBe(true);
    expect(() => precheckPdf(bytes(`%PDF-1.7\n${trailer}`))).not.toThrow();
  });

  it('does not mistake the word in text for an encryption dictionary', () => {
    expect(mentionsEncryption(bytes('%PDF-1.7\nBT (How /Encrypt works) Tj ET'))).toBe(false);
  });
});

describe('reply validation', () => {
  const valid = { text: 'one\f\fthree', pageCount: 3, pages: [
    { status: 'text', imageCoverage: 0 }, { status: 'scanned', imageCoverage: 0.92 }, { status: 'text', imageCoverage: 0 }] };

  it('accepts a consistent reply and copies it', () => {
    const result = validatePdfExtraction(valid);
    expect(result).toEqual(valid);
    expect(result.pages[0]).not.toBe(valid.pages[0]);
  });

  it.each([
    ['page count mismatch', { ...valid, pageCount: 2 }],
    ['missing page slot', { ...valid, text: 'one\fthree' }],
    ['text page without text', { ...valid, text: 'one\f\f ' }],
    ['scanned page with text', { ...valid, text: 'one\ftwo\fthree' }],
    ['scanned page under the coverage threshold', { ...valid, pages: [valid.pages[0], { status: 'scanned', imageCoverage: 0.2 }, valid.pages[2]] }],
    ['unknown status', { ...valid, pages: [valid.pages[0], { status: 'ocr', imageCoverage: 1 }, valid.pages[2]] }],
    ['coverage out of range', { ...valid, pages: [valid.pages[0], { status: 'blank', imageCoverage: 2 }, valid.pages[2]] }],
    ['no pages', { text: '', pageCount: 0, pages: [] }],
    ['too many pages', { text: '\f'.repeat(500), pageCount: 501, pages: Array(501).fill({ status: 'blank', imageCoverage: 0 }) }],
    ['not an object', 'text'],
  ])('rejects %s', (_name, value) => {
    expect(() => validatePdfExtraction(value)).toThrow(expect.objectContaining({ code: 'SANDBOX_PROTOCOL' }));
  });
});

describe('quality scoring', () => {
  it('ignores line breaks inside Chinese text but not lost characters', () => {
    expect(normalizePdfText('做账号定位\n之前， 先想 English words\nhere')).toBe('做账号定位之前，先想English words here');
    expect(pdfCharacterAccuracy('做账号\n定位', '做账号定位').accuracy).toBe(1);
    expect(pdfCharacterAccuracy('做账定位', '做账号定位').errors).toBe(1);
  });

  it('requires every reference line in order on the page', () => {
    expect(pageInReadingOrder('Header\nA b\nc\nFooter', ['Header', 'A b c', 'Footer'])).toBe(true);
    expect(pageInReadingOrder('A b c\nHeader\nFooter', ['Header', 'A b c', 'Footer'])).toBe(false);
    expect(pageInReadingOrder('Header\nFooter', ['Header', 'A b c', 'Footer'])).toBe(false);
  });
});
