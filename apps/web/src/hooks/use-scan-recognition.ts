/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { isLibraryScanRecognitionEnabled } from '@/lib/library-sandbox/feature-flag';
import { recognizePdfPagesInBrowser } from '@/lib/library-sandbox/ocr/scan';
import { recognizeImagesInBrowser } from '@/lib/library-sandbox/ocr/client';
import { OCR_LIMITS } from '@/lib/library-sandbox/limits';
import { extractDocxInBrowser } from '@/lib/library-sandbox/docx/client';
import type { DocxImage } from '@/lib/library-sandbox/docx/document-text';
import { isSignedStorageUrl } from '@/lib/library-documents/signed-url';
import { oneTabAtATime, runScanRecognition, type ScanApi, type ScanProgress } from '@/lib/library-documents/scan-recognition';

/**
 * LIB-2d: while the library page is open, recognises waiting scanned PDF pages and Word images in the browser and saves their text
 * (LIB_DOCS_PLAN §4.4: "充值后继续" / continue later = the next time the library opens). Off unless both the build
 * flag and the server switch are on (the server returns nothing to do otherwise). `start` re-runs after an upload.
 */
/** Image types the recognition engine reads (others, such as EMF or GIF, are marked failed). */
const RECOGNIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** An image the engine accepts: a supported type and a size it can read (empty or over the limit fails alone). */
const readableImage = (image: DocxImage | undefined): image is DocxImage =>
  !!image && RECOGNIZABLE.has(image.contentType) && image.bytes.byteLength > 0 && image.bytes.byteLength <= OCR_LIMITS.maxImageBytes;

export type ScanListeners = { onDocumentChanged(): void; onSaved(documentId: string, contentVersion: number): void };
const SCAN_CHANNEL = 'graylum-library-scan-recognition';
const NO_LISTENERS: ScanListeners = { onDocumentChanged: () => undefined, onSaved: () => undefined };
export type ScanRecognition = ReturnType<typeof useScanRecognition>;

/**
 * Mounted by the library page itself, so waiting pages resume on every library visit even before 我的文档 is
 * opened; the documents pane registers `listen` to refresh its list while it is shown.
 */
export function useScanRecognition() {
  const utils = trpc.useUtils();
  const download = trpc.library.download.useMutation();
  // The page promises automatic recognition only when the server switch is on too (fail closed until known).
  const enabled = trpc.library.recognitionEnabled.useQuery(undefined, { staleTime: 60_000 });
  const save = trpc.library.saveRecognizedPage.useMutation();
  const fail = trpc.library.failRecognizedPage.useMutation();
  const [progress, setProgress] = useState<Record<string, ScanProgress>>({});
  const running = useRef<AbortController | null>(null);
  const again = useRef(false);
  const listeners = useRef<ScanListeners>(NO_LISTENERS);
  const finished = useRef<() => void>(() => undefined);
  const progressRef = useRef<Record<string, ScanProgress>>({});
  progressRef.current = progress;
  const latest = useRef({ download, save, fail });
  latest.current = { download, save, fail };
  const listen = useCallback((next: ScanListeners) => {
    listeners.current = next;
    return () => { if (listeners.current === next) listeners.current = NO_LISTENERS; };
  }, []);

  const start = useCallback(() => {
    if (!isLibraryScanRecognitionEnabled()) return;
    if (running.current) { again.current = true; return; }
    const controller = new AbortController();
    running.current = controller;
    // One Word extraction per document per run, reused across its batches of images.
    const words = new Map<string, Promise<DocxImage[]>>();
    const api: ScanApi = {
      pending: () => utils.library.recognitionPending.fetch(undefined, { staleTime: 0 }),
      async original(documentId) {
        const { url } = await latest.current.download.mutateAsync({ documentId });
        if (!isSignedStorageUrl(url)) throw new Error('LIBRARY_STORAGE_UNAVAILABLE');
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('LIBRARY_STORAGE_UNAVAILABLE');
        return response.blob();
      },
      async recognize(document, file, positions, signal) {
        if (document.format === 'pdf') return recognizePdfPagesInBrowser(file, positions, { signal });
        // Word: extract the images again in the Word sandbox (same file, same order as at upload), then recognise.
        let extraction = words.get(document.documentId);
        if (!extraction) {
          extraction = extractDocxInBrowser(file, { signal }).then((result) => result.images);
          words.set(document.documentId, extraction);
        }
        const images = await extraction;
        const picked = positions.map((position) => images[position - 1]);
        const readable = picked.filter(readableImage);
        const pages = readable.length
          ? await recognizeImagesInBrowser(readable.map((image) => new Blob([image.bytes], { type: image.contentType })), { signal })
          : [];
        let next = 0;
        return positions.map((position, i) => {
          const image = picked[i];
          if (!readableImage(image)) return { page: position, ok: false as const, code: 'IMAGE_INVALID' as const };
          return { page: position, ...pages[next++]! };
        });
      },
      save: async (input) => {
        const saved = await latest.current.save.mutateAsync(input);
        listeners.current.onSaved(input.documentId, saved.contentVersion);
        return saved;
      },
      fail: (input) => latest.current.fail.mutateAsync(input),
    };
    void oneTabAtATime(() => runScanRecognition(api, controller.signal, (documentId, value) => {
      setProgress((current) => ({ ...current, [documentId]: value }));
      if (value.state !== 'running' || value.done > 0) listeners.current.onDocumentChanged();
    }), controller.signal).then(() => {
      // A tab that waited for another tab's lock may have had nothing left to do; its list is refreshed once anyway.
      if (!controller.signal.aborted) { listeners.current.onDocumentChanged(); finished.current(); }
    }).catch(() => {
      // An unexpected failure leaves no document running, so the page stops warning before leaving.
      setProgress((current) => Object.fromEntries(Object.entries(current)
        .map(([id, value]) => [id, value.state === 'running' ? { ...value, state: 'stopped' as const } : value])));
    }).finally(() => {
      if (running.current === controller) running.current = null;
      if (again.current && !controller.signal.aborted) { again.current = false; start(); }
    });
  }, [utils]);

  useEffect(() => {
    start();
    return () => { running.current?.abort(); running.current = null; };
  }, [start]);

  // Tabs of one browser take turns (see oneTabAtATime); a tab that finished tells the others, so a tab that waited
  // or stopped earlier refreshes its list and drops its stale "will retry" lines.
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const peers = new BroadcastChannel(SCAN_CHANNEL);
    channel.current = peers;
    // Only the documents the finished tab completed lose their notice; a paused or stopped one stays as it is.
    peers.onmessage = (event: MessageEvent<unknown>) => {
      const done = new Set(Array.isArray(event.data) ? event.data.filter((id): id is string => typeof id === 'string') : []);
      setProgress((current) => Object.fromEntries(Object.entries(current).filter(([id, value]) => value.state === 'running' || !done.has(id))));
      listeners.current.onDocumentChanged();
    };
    return () => { peers.close(); channel.current = null; };
  }, []);
  finished.current = () => channel.current?.postMessage(
    Object.entries(progressRef.current).filter(([, value]) => value.state === 'done').map(([id]) => id));

  const busy = Object.values(progress).some((p) => p.state === 'running');
  // Leaving while a page is being recognised loses that page's work (it is redone next time), so warn first.
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  return { progress, start, listen, busy, serverEnabled: enabled.data === true };
}
