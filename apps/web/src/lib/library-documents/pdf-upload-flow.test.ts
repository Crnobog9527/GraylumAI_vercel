/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { PdfPage } from '@/lib/library-sandbox/pdf/types';
import { PDF_MIME } from './format';
import type { UploadAttempt, UploadFailure } from './upload-flow';
import { pdfScanSummary, preparePdf, runPdfUpload, type PdfUploadApi, type PreparedPdf } from './pdf-upload-flow';

const page: PdfPage = { status: 'text', imageCoverage: 0 };
const scanned = (n: number): PdfPage => ({ status: 'scanned', imageCoverage: 0.9 + (n % 2) / 100 });
const blank: PdfPage = { status: 'blank', imageCoverage: 0.12 };
const file = new Blob(['%PDF-1.7']);
const link = (name: string) => ({ signedUrl: 'https://s/' + name + '?token=t' });
const prepared: PreparedPdf = {
  text: new Blob(['第一页\f\f第三页']), pageCount: 3, pages: [page, scanned(2), page],
};
function setup(overrides: Partial<PdfUploadApi> = {}) {
  const api: PdfUploadApi = {
    begin: vi.fn(async () => ({ documentId: 'doc-1', status: 'uploading', upload: link('original') })),
    beginText: vi.fn(async () => ({ documentId: 'doc-1', status: 'uploading', upload: link('text') })),
    complete: vi.fn(async () => ({ status: 'ready' })),
    abandon: vi.fn(async () => ({ status: 'deleting' })),
    put: vi.fn(async (_url, _file, _type, progress) => { progress(1); }),
    ...overrides,
  };
  let n = 0;
  const run = (attempt: UploadAttempt = { requestId: 'req-0', resume: 'begin' }) => runPdfUpload(api, {
    file, filename: '报告.pdf', purpose: 'reference', prepared, attempt, newId: () => 'req-' + ++n, onStage: () => {},
  });
  return { api, run };
}
const fail = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as UploadFailure; }
  throw new Error('expected failure');
};
const definite = (code: string) => Object.assign(new Error(code), { data: { code: 'BAD_REQUEST' } });

describe('preparePdf (LIB-2c result → #800 payload)', () => {
  it('keeps the extracted text byte for byte, page separators and empty slots included', async () => {
    const result = preparePdf({ text: '甲\f\f乙', pageCount: 3, pages: [page, scanned(2), page] });
    if (!result.ok) throw new Error('expected ok');
    expect(new Uint8Array(await result.prepared.text.arrayBuffer())).toEqual(new TextEncoder().encode('甲\f\f乙'));
    expect(result.prepared.text.type).toBe('text/plain');
    expect(result.prepared.pageCount).toBe(3);
    expect(result.prepared.pages).toEqual([page, scanned(2), page]);
  });
  it('accepts a fully scanned PDF with empty text', async () => {
    const result = preparePdf({ text: '', pageCount: 1, pages: [scanned(1)] });
    if (!result.ok) throw new Error('expected ok');
    expect(result.prepared.text.size).toBe(0);
  });
  it('rejects a PDF with only blank pages', () => {
    expect(preparePdf({ text: '\f', pageCount: 2, pages: [blank, blank] }))
      .toMatchObject({ ok: false, message: expect.stringContaining('没有可以读取的文字') });
  });
  it('sends only the fields the server accepts for each page', () => {
    const extra = { status: 'text', imageCoverage: 0, offset: 3 } as PdfPage;
    const result = preparePdf({ text: 'a', pageCount: 1, pages: [extra] });
    expect(result.ok && result.prepared.pages).toEqual([{ status: 'text', imageCoverage: 0 }]);
  });
});

describe('pdfScanSummary (same rule as the server publish)', () => {
  it('says nothing when no page is scanned', () => {
    expect(pdfScanSummary([page, blank])).toBeUndefined();
  });
  it('marks up to 50 scanned pages as waiting for recognition; text and blank pages do not count', () => {
    const pages = [page, blank, ...Array.from({ length: 50 }, (_, i) => scanned(i))];
    expect(pdfScanSummary(pages)).toBe('共 52 页，其中 50 页是扫描页，待识别');
  });
  it('reports scanned pages past the 50th as over the per-file limit', () => {
    const pages = [page, ...Array.from({ length: 51 }, (_, i) => scanned(i))];
    expect(pdfScanSummary(pages)).toBe('共 52 页，其中 51 页是扫描页：前 50 页待识别，其余 1 页超出单个文件的识别上限（50 页）');
  });
});

describe('runPdfUpload (#800 two-stage contract)', () => {
  it('sends the original as PDF, then the text, then completes with pageCount and pages', async () => {
    const { api, run } = setup();
    await expect(run()).resolves.toEqual({ documentId: 'doc-1' });
    expect(api.begin).toHaveBeenCalledWith({
      requestId: 'req-0', filename: '报告.pdf', contentType: PDF_MIME, bytes: file.size, purpose: 'reference',
    });
    const puts = vi.mocked(api.put).mock.calls;
    expect(puts[0].slice(0, 3)).toEqual(['https://s/original?token=t', file, PDF_MIME]);
    expect(puts[1].slice(0, 3)).toEqual(['https://s/text?token=t', prepared.text, 'text/plain']);
    expect(api.complete).toHaveBeenCalledWith({ documentId: 'doc-1', pageCount: 3, pages: prepared.pages });
    expect(vi.mocked(api.beginText).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(api.put).mock.invocationCallOrder[0]);
  });
  it('keeps the same row after an unknown completion, and finishes on retry without a new begin', async () => {
    const complete = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue({ status: 'ready' });
    const { api, run } = setup({ complete });
    const failure = await fail(run());
    expect(failure.retry).toEqual({ requestId: 'req-0', documentId: 'doc-1', resume: 'complete' });
    await expect(run(failure.retry)).resolves.toEqual({ documentId: 'doc-1' });
    expect(api.begin).toHaveBeenCalledTimes(1);
    expect(api.abandon).not.toHaveBeenCalled();
  });
  it('releases the row when the server rejects the pages, and the retry starts over', async () => {
    const { api, run } = setup({ complete: vi.fn().mockRejectedValue(definite('LIBRARY_PAGES')) });
    const failure = await fail(run());
    expect(api.abandon).toHaveBeenCalledWith({ documentId: 'doc-1' });
    expect(failure.retry).toMatchObject({ resume: 'begin' });
    expect(failure.retry.requestId).not.toBe('req-0');
  });
  it('releases the row when the original fails to upload', async () => {
    const { api, run } = setup({ put: vi.fn().mockRejectedValue(new Error('UPLOAD_NETWORK')) });
    const failure = await fail(run());
    expect(api.beginText).not.toHaveBeenCalled();
    expect(api.abandon).toHaveBeenCalledWith({ documentId: 'doc-1' });
    expect(failure.retry.resume).toBe('begin');
  });
  it('treats a repeat begin that is already ready as done', async () => {
    const { api, run } = setup({ begin: vi.fn(async () => ({ documentId: 'doc-1', status: 'ready', upload: null })) });
    await expect(run()).resolves.toEqual({ documentId: 'doc-1' });
    expect(api.put).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
  });
});
