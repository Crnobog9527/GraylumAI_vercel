/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  checkLibraryFile, libraryErrorCode, libraryErrorMessage, PDF_MIME, WORD_MIME, type LibraryPurpose, type UploadContentType,
} from '@/lib/library-documents/format';
import {
  putSignedUpload, runLibraryUpload, settleFailedAttempt, UploadFailure, type UploadApi, type UploadAttempt,
} from '@/lib/library-documents/upload-flow';
import {
  prepareWord, runWordUpload, type PreparedWord, type WordUploadApi,
} from '@/lib/library-documents/word-upload-flow';
import {
  pdfScanSummary, preparePdf, runPdfUpload, type PdfUploadApi, type PreparedPdf,
} from '@/lib/library-documents/pdf-upload-flow';
import { extractDocxInBrowser } from '@/lib/library-sandbox/docx/client';
import { extractPdfInBrowser } from '@/lib/library-sandbox/pdf/client';
import { SandboxError, sandboxErrorMessage } from '@/lib/library-sandbox/errors';

export type UploadItem = {
  key: string; filename: string; purpose: LibraryPurpose;
  status: 'waiting' | 'extract' | 'begin' | 'transfer' | 'complete' | 'failed' | 'removing' | 'rejected' | 'done';
  progress: number; message?: string;
  file?: File; contentType?: UploadContentType; attempt?: UploadAttempt;
  /** Browser-extracted payload (Word or PDF, by contentType), kept so a retry does not re-extract. */
  prepared?: PreparedWord | PreparedPdf;
};

/** A failed item that still owes the server something (a release, or a re-check of an unknown result). */
export function holdsServerRow(item: UploadItem): boolean {
  return item.status === 'failed' && !!(item.attempt?.releaseFirst || item.attempt?.documentId);
}

type Extracted<P> = { ok: true; prepared: P } | { ok: false; message: string };
async function extractWord(file: File): Promise<Extracted<PreparedWord>> {
  try {
    return prepareWord(await extractDocxInBrowser(file));
  } catch (error) {
    return { ok: false, message: sandboxErrorMessage(error instanceof SandboxError ? error.code : 'WORKER_FAILED') };
  }
}
async function extractPdf(file: File): Promise<Extracted<PreparedPdf>> {
  try {
    return preparePdf(await extractPdfInBrowser(file));
  } catch (error) {
    return { ok: false, message: sandboxErrorMessage(error instanceof SandboxError ? error.code : 'WORKER_FAILED', 'pdf') };
  }
}

/** Sequential upload queue (the server allows at most 4 unfinished uploads per user). */
export function useLibraryUploads(onSettled: () => void, onDisabled: () => void) {
  const begin = trpc.library.beginUpload.useMutation();
  const complete = trpc.library.completeUpload.useMutation();
  const abandon = trpc.library.abandonUpload.useMutation();
  const beginWord = trpc.library.beginWordUpload.useMutation();
  const beginWordText = trpc.library.beginWordTextUpload.useMutation();
  const completeWord = trpc.library.completeWordUpload.useMutation();
  const beginPdf = trpc.library.beginPdfUpload.useMutation();
  const beginPdfText = trpc.library.beginPdfTextUpload.useMutation();
  const completePdf = trpc.library.completePdfUpload.useMutation();
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<UploadItem[]>([]);
  const running = useRef(false);
  const update = useCallback((key: string, patch: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  const api = {
    plain: {
      begin: (input) => begin.mutateAsync(input),
      complete: (input) => complete.mutateAsync(input),
      abandon: (input) => abandon.mutateAsync(input),
      put: putSignedUpload,
    } satisfies UploadApi,
    word: {
      begin: (input) => beginWord.mutateAsync({ ...input, contentType: WORD_MIME }),
      beginText: (input) => beginWordText.mutateAsync(input),
      complete: (input) => completeWord.mutateAsync(input),
      abandon: (input) => abandon.mutateAsync(input),
      put: putSignedUpload,
    } satisfies WordUploadApi,
    pdf: {
      begin: (input) => beginPdf.mutateAsync({ ...input, contentType: PDF_MIME }),
      beginText: (input) => beginPdfText.mutateAsync(input),
      complete: (input) => completePdf.mutateAsync(input),
      abandon: (input) => abandon.mutateAsync(input),
      put: putSignedUpload,
    } satisfies PdfUploadApi,
  };
  const apiRef = useRef(api);
  apiRef.current = api;

  /** Resolves with the line to show once done (PDF scanned pages), or null when the file was rejected. */
  const runOne = useCallback(async (item: UploadItem): Promise<{ message?: string } | null> => {
    const onStage = (stage: UploadItem['status'], progress?: number) => update(item.key, { status: stage, progress: progress ?? 0 });
    const common = { file: item.file!, filename: item.filename, purpose: item.purpose, attempt: item.attempt!, newId: () => crypto.randomUUID(), onStage };
    const contentType = item.contentType!;
    if (contentType !== WORD_MIME && contentType !== PDF_MIME) {
      await runLibraryUpload(apiRef.current.plain, { ...common, contentType });
      return {};
    }
    let prepared = item.prepared;
    if (!prepared) {
      onStage('extract');
      const extracted = contentType === PDF_MIME ? await extractPdf(item.file!) : await extractWord(item.file!);
      if (!extracted.ok) {
        update(item.key, { status: 'rejected', message: extracted.message, file: undefined });
        return null;
      }
      prepared = extracted.prepared;
      update(item.key, { prepared });
    }
    if (contentType === PDF_MIME) {
      const pdf = prepared as PreparedPdf;
      await runPdfUpload(apiRef.current.pdf, { ...common, prepared: pdf });
      return { message: pdfScanSummary(pdf.pages) };
    }
    await runWordUpload(apiRef.current.word, { ...common, prepared: prepared as PreparedWord });
    return {};
  }, [update]);

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const item = queue.current.shift()!;
        if (!item.file || !item.contentType || !item.attempt) continue;
        try {
          const result = await runOne(item);
          if (result) update(item.key, { status: 'done', progress: 1, file: undefined, prepared: undefined, message: result.message });
        } catch (error) {
          const cause = error instanceof UploadFailure ? error.cause : error;
          const retry = error instanceof UploadFailure ? error.retry : { requestId: crypto.randomUUID(), resume: 'begin' as const };
          if (libraryErrorCode(cause) === 'LIBRARY_DISABLED') onDisabled();
          update(item.key, { status: 'failed', message: libraryErrorMessage(cause), attempt: retry });
        }
        onSettled();
      }
    } finally {
      running.current = false;
    }
  }, [onDisabled, onSettled, runOne, update]);

  const add = useCallback((files: File[], purpose: LibraryPurpose, freeBytes?: number) => {
    const added: UploadItem[] = files.map((file) => {
      const key = crypto.randomUUID();
      const check = checkLibraryFile(file, freeBytes);
      if (!check.ok) return { key, filename: file.name, purpose, status: 'rejected', progress: 0, message: check.message };
      return {
        key, filename: file.name, purpose, status: 'waiting', progress: 0, file, contentType: check.contentType,
        attempt: { requestId: crypto.randomUUID(), resume: 'begin' },
      };
    });
    setItems((current) => [...added, ...current.filter((item) => item.status !== 'done')]);
    queue.current.push(...added.filter((item) => item.status === 'waiting'));
    void drain();
  }, [drain]);

  const retry = useCallback((key: string) => {
    const item = items.find((entry) => entry.key === key);
    if (!item || item.status !== 'failed' || !item.file) return;
    const next = { ...item, status: 'waiting' as const, progress: 0, message: undefined };
    update(key, next);
    queue.current.push(next);
    void drain();
  }, [drain, items, update]);

  const settle = useCallback((item: UploadItem) => {
    const { plain, word, pdf } = apiRef.current;
    return settleFailedAttempt(plain, item.attempt, (documentId) => {
      if (item.contentType === WORD_MIME) {
        return word.complete({ documentId, headings: (item.prepared as PreparedWord | undefined)?.headings ?? [] });
      }
      if (item.contentType === PDF_MIME) {
        // Pages are always prepared before begin; without them the result cannot be re-checked, so keep the item.
        const prepared = item.prepared as PreparedPdf | undefined;
        if (!prepared) return Promise.reject(new Error('PDF_PAGES_MISSING'));
        return pdf.complete({ documentId, pageCount: prepared.pageCount, pages: prepared.pages });
      }
      return plain.complete({ documentId });
    });
  }, []);

  /**
   * A failed item may still hold a server row (a release owed, a Word/PDF row waiting for its text, or an
   * unknown completion). Removing it settles that first; if that is not confirmed, the item stays.
   */
  const dismiss = useCallback(async (key: string) => {
    const item = items.find((entry) => entry.key === key);
    if (!item || !['failed', 'rejected', 'done'].includes(item.status)) return;
    if (item.status === 'failed') {
      update(key, { status: 'removing', message: undefined });
      try {
        await settle(item);
      } catch {
        update(key, { status: 'failed', message: '暂时无法确认这次上传的结果，请稍后再点「移除」或「重试」。' });
        return;
      }
      onSettled();
    }
    setItems((current) => current.filter((entry) => entry.key !== key));
  }, [items, onSettled, settle, update]);

  // Leaving the page in-app (the tab itself stays mounted) settles what failed items still hold,
  // best effort; anything unconfirmed is left to the server's expiry cleanup.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => {
    for (const item of itemsRef.current) if (holdsServerRow(item)) void settle(item).catch(() => {});
  }, [settle]);

  const busy = items.some((item) => holdsServerRow(item)
    || ['waiting', 'extract', 'begin', 'transfer', 'complete', 'removing'].includes(item.status));
  return { items, add, retry, dismiss, busy };
}
