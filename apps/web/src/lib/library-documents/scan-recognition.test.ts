/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { runScanRecognition, scanProgressText, type PendingDocument, type ScanApi, type ScanProgress } from './scan-recognition';

const doc = (positions: number[], contentVersion = 1): PendingDocument => ({ documentId: 'd1', format: 'pdf', contentVersion, positions });
const page = (n: number, text = `第 ${n} 页文字`) => ({ page: n, ok: true as const, text, confidence: 0.9, angle: 0, flipped: false, ms: 1 });

function api(overrides: Partial<ScanApi> = {}, pending: PendingDocument[] = [doc([2, 4])]) {
  let version = pending[0]?.contentVersion ?? 1;
  const base: ScanApi = {
    pending: vi.fn(async () => pending),
    original: vi.fn(async () => new Blob(['%PDF'])),
    recognize: vi.fn(async (_doc, _file, pages: number[]) => pages.map((n) => page(n))),
    save: vi.fn(async ({ version: v }) => {
      if (v !== version) throw new Error('LIBRARY_VERSION_CHANGED');
      version += 1;
      return { saved: true, status: 'complete', contentVersion: version };
    }),
    fail: vi.fn(async () => ({ status: 'failed' })),
  };
  return { ...base, ...overrides };
}

describe('scan recognition driver', () => {
  it('saves each page once with the version returned by the previous save', async () => {
    const calls = api();
    const seen: ScanProgress[] = [];
    expect(await runScanRecognition(calls, new AbortController().signal, (_, p) => seen.push(p))).toBe('done');
    expect(vi.mocked(calls.save).mock.calls.map(([input]) => [input.position, input.version])).toEqual([[2, 1], [4, 2]]);
    expect(seen.at(-1)).toEqual({ done: 2, total: 2, failed: 0, state: 'done' });
  });
  it('marks unreadable or empty pages failed without saving them', async () => {
    const calls = api({ recognize: vi.fn(async () => [{ page: 2, ok: false as const, code: 'PDF_INVALID' as const }, page(4, '  ')]) });
    await runScanRecognition(calls, new AbortController().signal, () => undefined);
    expect(calls.save).not.toHaveBeenCalled();
    expect(vi.mocked(calls.fail).mock.calls.map(([input]) => input.position)).toEqual([2, 4]);
  });
  it('stops everything when space runs out and reports the pause', async () => {
    const calls = api({ save: vi.fn(async () => ({ saved: false, status: 'paused', contentVersion: 1, code: 'LIBRARY_SPACE' as const })) },
      [doc([2, 4]), { documentId: 'd2', format: 'docx', contentVersion: 1, positions: [1] }]);
    const seen: Array<[string, ScanProgress]> = [];
    expect(await runScanRecognition(calls, new AbortController().signal, (id, p) => seen.push([id, p]))).toBe('paused');
    expect(calls.save).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual(['d1', { done: 0, total: 2, failed: 0, state: 'paused' }]);
  });
  it('takes the new version once when another tab saved in between', async () => {
    let first = true;
    const calls = api({
      pending: vi.fn(async () => [doc([2, 4], first ? 1 : 5)]),
      save: vi.fn(async ({ version }) => {
        if (first) { first = false; throw new Error('LIBRARY_VERSION_CHANGED'); }
        return { saved: true, status: 'complete', contentVersion: version + 1 };
      }),
    });
    await runScanRecognition(calls, new AbortController().signal, () => undefined);
    expect(vi.mocked(calls.save).mock.calls.map(([input]) => [input.position, input.version])).toEqual([[2, 1], [2, 5], [4, 6]]);
  });
  it('leaves pages waiting when the batch cannot run, and stops at once when aborted', async () => {
    const broken = api({ recognize: vi.fn(async () => { throw new Error('SANDBOX_UNAVAILABLE'); }) });
    const seen: ScanProgress[] = [];
    await runScanRecognition(broken, new AbortController().signal, (_, p) => seen.push(p));
    expect(broken.fail).not.toHaveBeenCalled();
    expect(seen.at(-1)?.state).toBe('stopped');
    const controller = new AbortController();
    controller.abort();
    expect(await runScanRecognition(api(), controller.signal, () => undefined)).toBe('aborted');
  });
  it('recognises in batches of at most 8 pages', async () => {
    const calls = api({}, [doc(Array.from({ length: 19 }, (_, i) => i + 1))]);
    await runScanRecognition(calls, new AbortController().signal, () => undefined);
    expect(vi.mocked(calls.recognize).mock.calls.map(([, , pages]) => pages.length)).toEqual([8, 8, 3]);
  });
  it('saves Word images as word_image units and PDF pages as pdf_page units', async () => {
    const calls = api({}, [{ documentId: 'w1', format: 'docx', contentVersion: 1, positions: [1] }]);
    await runScanRecognition(calls, new AbortController().signal, () => undefined);
    expect(vi.mocked(calls.save).mock.calls[0]![0]).toMatchObject({ documentId: 'w1', kind: 'word_image', position: 1 });
    const pdf = api();
    await runScanRecognition(pdf, new AbortController().signal, () => undefined);
    expect(vi.mocked(pdf.save).mock.calls[0]![0]).toMatchObject({ kind: 'pdf_page' });
  });
  it('counts a unit the server marks failed (text limit) as not recognised', async () => {
    const calls = api({ save: vi.fn(async () => ({ saved: false, status: 'failed', contentVersion: 1, code: 'LIBRARY_TEXT_LIMIT' as const })) });
    const seen: ScanProgress[] = [];
    await runScanRecognition(calls, new AbortController().signal, (_, p) => seen.push(p));
    expect(seen.at(-1)).toEqual({ done: 2, total: 2, failed: 2, state: 'done' });
  });
  it('describes progress in one plain line', () => {
    expect(scanProgressText({ done: 3, total: 12, failed: 0, state: 'running' })).toBe('正在识别扫描页 3/12');
    expect(scanProgressText({ done: 12, total: 12, failed: 2, state: 'done' })).toBe('扫描页识别完成，2 页没能识别');
    expect(scanProgressText({ done: 0, total: 2, failed: 0, state: 'paused' })).toContain('空间不够');
    expect(scanProgressText(undefined)).toBeUndefined();
  });
});
