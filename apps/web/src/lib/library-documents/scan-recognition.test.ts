/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { oneTabAtATime, runScanRecognition, SCAN_LOCK, scanProgressText, type PendingDocument, type ScanApi, type ScanProgress } from './scan-recognition';

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
  it('does not count a failure the server did not record, and stops the run with the page still waiting', async () => {
    const calls = api({ recognize: vi.fn(async () => [page(2, ''), page(4)]), fail: vi.fn(async () => { throw new Error('TOO_MANY_REQUESTS'); }) });
    const seen: ScanProgress[] = [];
    await expect(runScanRecognition(calls, new AbortController().signal, (_, p) => seen.push(p))).rejects.toThrow('TOO_MANY_REQUESTS');
    expect(calls.save).not.toHaveBeenCalled();
    expect(seen.at(-1)).toEqual({ done: 0, total: 2, failed: 0, state: 'running' });
  });
  it('does not count a page as failed when another tab already saved its text', async () => {
    const calls = api({ recognize: vi.fn(async () => [page(2, ''), page(4, '')]),
      fail: vi.fn(async ({ position }) => ({ status: position === 2 ? 'complete' : 'failed' })) });
    const seen: ScanProgress[] = [];
    await runScanRecognition(calls, new AbortController().signal, (_, p) => seen.push(p));
    expect(seen.at(-1)).toEqual({ done: 2, total: 2, failed: 1, state: 'done' });
  });
  it('ends only the document that was deleted mid-run and carries on with the rest of the queue', async () => {
    const queue = [doc([2]), { documentId: 'd2', format: 'pdf' as const, contentVersion: 1, positions: [3] }];
    const calls = api({
      pending: vi.fn(async () => queue),
      save: vi.fn(async ({ documentId }) => {
        if (documentId === 'd1') throw new Error('LIBRARY_NOT_FOUND');
        return { saved: true, status: 'complete', contentVersion: 2 };
      }),
    });
    const seen: Array<[string, ScanProgress]> = [];
    expect(await runScanRecognition(calls, new AbortController().signal, (id, p) => seen.push([id, p]))).toBe('done');
    expect(vi.mocked(calls.save).mock.calls.map(([input]) => input.documentId)).toEqual(['d1', 'd2']);
    expect(seen.find(([id, p]) => id === 'd1' && p.state === 'stopped')).toBeTruthy();
  });
  it('waits for the server retry hint and tries a rate-limited save again', async () => {
    vi.useFakeTimers();
    try {
      let limited = true;
      const calls = api({ save: vi.fn(async ({ version }) => {
        if (limited) { limited = false; throw Object.assign(new Error('rate'), { data: { code: 'TOO_MANY_REQUESTS', retryAfter: 7 } }); }
        return { saved: true, status: 'complete', contentVersion: version + 1 };
      }) }, [doc([2])]);
      const run = runScanRecognition(calls, new AbortController().signal, () => undefined);
      await vi.advanceTimersByTimeAsync(7000);
      expect(await run).toBe('done');
      expect(calls.save).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('fetches the waiting list again until it holds no document this run has not tried', async () => {
    const lists = [[doc([2])], [doc([2]), { documentId: 'd21', format: 'pdf' as const, contentVersion: 2, positions: [3] }], [doc([2])]];
    const calls = api({ pending: vi.fn(async () => lists.shift() ?? []) });
    expect(await runScanRecognition(calls, new AbortController().signal, () => undefined)).toBe('done');
    expect(vi.mocked(calls.save).mock.calls.map(([input]) => [input.documentId, input.position])).toEqual([['d1', 2], ['d21', 3]]);
    expect(calls.pending).toHaveBeenCalledTimes(3);
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

describe('one tab at a time', () => {
  it('runs inside the shared lock, so a second tab waits until the first one finishes', async () => {
    let held: Promise<unknown> = Promise.resolve();
    const names: string[] = [];
    const locks = { request: <T>(name: string, _options: { signal?: AbortSignal }, run: () => Promise<T>) => {
      names.push(name);
      const next = held.then(run);
      held = next.catch(() => undefined);
      return next;
    } };
    const order: string[] = [];
    let release!: () => void;
    const first = oneTabAtATime(async () => { order.push('a start'); await new Promise<void>((r) => { release = r; }); order.push('a end'); },
      new AbortController().signal, locks);
    const second = oneTabAtATime(async () => { order.push('b'); }, new AbortController().signal, locks);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a start', 'a end', 'b']);
    expect(names).toEqual([SCAN_LOCK, SCAN_LOCK]);
  });
  it('runs directly in a browser without Web Locks', async () => {
    expect(await oneTabAtATime(async () => 'ran', new AbortController().signal, undefined)).toBe('ran');
  });
});
