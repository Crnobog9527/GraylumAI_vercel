/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ScannedPageResult } from '@/lib/library-sandbox/ocr/scan';
import { PDF_RENDER_LIMITS } from '@/lib/library-sandbox/limits';

/**
 * LIB-2d: continues recognition of scanned PDF pages and Word images while the library page is open (LIB_DOCS_PLAN §4.4:
 * no queue or scheduler; the page drives it). Pages are rendered and recognised in the user's own browser
 * (Owner 2026-10-17: browser PaddleOCR); only the resulting text is sent to the server, page by page.
 * The database saves each page once, so a refresh or a second tab never duplicates a page.
 */

/** `positions` are PDF page numbers (pdf) or Word image numbers in document order (docx). */
export type PendingDocument = { documentId: string; format: 'pdf' | 'docx'; contentVersion: number; positions: number[] };
export type UnitKind = 'pdf_page' | 'word_image';
export type SaveResult = { saved: boolean; status: string; contentVersion: number; code?: 'LIBRARY_SPACE' | 'LIBRARY_TEXT_LIMIT' };
export type ScanApi = {
  pending(): Promise<PendingDocument[]>;
  original(documentId: string): Promise<Blob>;
  /** One result per position (`page` = the position), from a PDF page render or a Word image, all in the browser. */
  recognize(document: PendingDocument, file: Blob, positions: number[], signal: AbortSignal): Promise<ScannedPageResult[]>;
  save(input: { documentId: string; kind: UnitKind; position: number; version: number; text: string }): Promise<SaveResult>;
  /** `status` is the unit's state afterwards: 'complete' when another tab saved its text first. */
  fail(input: { documentId: string; kind: UnitKind; position: number }): Promise<{ status: string }>;
};
export type ScanProgress = { done: number; total: number; failed: number; state: 'running' | 'done' | 'paused' | 'stopped' };

const errorCode = (error: unknown) => (error as { message?: unknown } | null)?.message;
const MAX_RATE_LIMIT_RETRIES = 5;

/** A rate-limited call waits the server's `retryAfter` (at most two minutes) and is tried again, a few times. */
async function persist<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const data = (error as { data?: { code?: unknown; retryAfter?: unknown } } | null)?.data;
      if (data?.code !== 'TOO_MANY_REQUESTS' || attempt >= MAX_RATE_LIMIT_RETRIES || signal.aborted) throw error;
      const seconds = typeof data.retryAfter === 'number' && data.retryAfter > 0 ? Math.min(data.retryAfter, 120) : 30;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, seconds * 1000);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (signal.aborted) throw error;
    }
  }
}

export const SCAN_LOCK = 'graylum-library-scan-recognition';
type Locks = { request<T>(name: string, options: { signal?: AbortSignal }, run: () => Promise<T>): Promise<T> };

/**
 * Two tabs of the same browser never recognise at the same time (LIB_DOCS_PLAN §10 item 19: each unit processed
 * once): a second tab waits for the first tab's lock and takes over when that tab closes. Browsers without Web
 * Locks run directly; the database still saves each unit once.
 */
export function oneTabAtATime<T>(run: () => Promise<T>, signal: AbortSignal,
  locks: Locks | undefined = (globalThis.navigator as { locks?: Locks } | undefined)?.locks): Promise<T> {
  return locks ? locks.request(SCAN_LOCK, { signal }, run) : run();
}

/**
 * Runs until every waiting page of every waiting document is saved or marked failed, space runs out, or `signal` aborts.
 * The server lists a limited number of documents at a time, so the list is fetched again until it holds no document
 * this run has not tried yet (a document left waiting after a stop is not retried in the same run).
 */
export async function runScanRecognition(api: ScanApi, signal: AbortSignal,
  onProgress: (documentId: string, progress: ScanProgress) => void): Promise<'done' | 'paused' | 'aborted'> {
  const tried = new Set<string>();
  for (;;) {
    const documents = (await api.pending()).filter((document) => !tried.has(document.documentId));
    if (!documents.length) return 'done';
    for (const document of documents) {
      tried.add(document.documentId);
      let outcome: Awaited<ReturnType<typeof recognizeDocument>>;
      try {
        outcome = await recognizeDocument(api, document, signal, onProgress);
      } catch (error) {
        // Deleted while it was being recognised: that document ends, the rest of the queue continues.
        if (errorCode(error) !== 'LIBRARY_NOT_FOUND') throw error;
        onProgress(document.documentId, { done: 0, total: document.positions.length, failed: 0, state: 'stopped' });
        continue;
      }
      if (outcome !== 'done') return outcome;
    }
  }
}

async function recognizeDocument(api: ScanApi, document: PendingDocument, signal: AbortSignal,
  onProgress: (documentId: string, progress: ScanProgress) => void): Promise<'done' | 'paused' | 'aborted'> {
  if (signal.aborted) return 'aborted';
  const progress: ScanProgress = { done: 0, total: document.positions.length, failed: 0, state: 'running' };
  const report = () => onProgress(document.documentId, { ...progress });
  report();
  let version = document.contentVersion;
  const kind: UnitKind = document.format === 'pdf' ? 'pdf_page' : 'word_image';
  let file: Blob;
  try {
    file = await api.original(document.documentId);
  } catch {
    progress.state = 'stopped';
    report();
    return 'done';
  }
  for (let start = 0; start < document.positions.length; start += PDF_RENDER_LIMITS.maxPages) {
    if (signal.aborted) return 'aborted';
    let results: ScannedPageResult[];
    try {
      results = await api.recognize(document, file, document.positions.slice(start, start + PDF_RENDER_LIMITS.maxPages), signal);
    } catch {
      if (signal.aborted) return 'aborted';
      // The whole batch could not run (sandbox unavailable, file unreadable): leave the pages waiting for next time.
      progress.state = 'stopped';
      report();
      break;
    }
    for (const result of results) {
      if (signal.aborted) return 'aborted';
      const text = result.ok ? result.text.trim() : '';
      if (!text) {
        // Unreadable page (for example a JPEG 2000 image the sandbox cannot draw) or no text found.
        // A failure that was not recorded is not counted: the error stops the run and the page stays waiting.
        const failed = await persist(() => api.fail({ documentId: document.documentId, kind, position: result.page }), signal);
        if (failed.status === 'failed') progress.failed += 1;
      } else {
        let saved: SaveResult;
        try {
          saved = await persist(() => api.save({ documentId: document.documentId, kind, position: result.page, version, text }), signal);
        } catch (error) {
          if (errorCode(error) !== 'LIBRARY_VERSION_CHANGED') throw error;
          // Another tab saved a page in between: take the current version and save once more.
          const fresh = (await api.pending()).find((item) => item.documentId === document.documentId);
          if (!fresh) { progress.state = 'done'; report(); return 'done'; }
          version = fresh.contentVersion;
          saved = await persist(() => api.save({ documentId: document.documentId, kind, position: result.page, version, text }), signal);
        }
        if (saved.code === 'LIBRARY_SPACE') {
          progress.state = 'paused';
          report();
          return 'paused';
        }
        version = saved.contentVersion;
        // The server could not keep it (the document's text limit): counted as not recognised.
        if (!saved.saved && saved.status === 'failed') progress.failed += 1;
      }
      progress.done += 1;
      report();
    }
  }
  if (progress.state === 'running') {
    progress.state = 'done';
    report();
  }
  return 'done';
}

/** One plain line under the file name; undefined when nothing is happening for this document. */
export function scanProgressText(progress: ScanProgress | undefined): string | undefined {
  if (!progress) return undefined;
  const failed = progress.failed ? `，${progress.failed} 页没能识别` : '';
  if (progress.state === 'running') return `正在识别扫描页 ${progress.done}/${progress.total}${failed}`;
  if (progress.state === 'paused') return '空间不够，已暂停识别扫描页；腾出空间后打开资料库会自动继续';
  if (progress.state === 'stopped') return '扫描页暂时没能识别，下次打开资料库会再试';
  return progress.failed ? `扫描页识别完成${failed}` : '扫描页识别完成';
}
