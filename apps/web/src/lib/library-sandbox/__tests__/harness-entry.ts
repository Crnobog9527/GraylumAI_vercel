/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Page-side test entry, bundled by browser-harness.ts with the feature flag on. Exposes the real
// production entry points plus a main-thread responsiveness probe.
import { extractDocxInBrowser } from '../docx/client';
import { extractPdfInBrowser } from '../pdf/client';
import { recognizeImagesInBrowser } from '../ocr/client';
import { recognizePdfPagesInBrowser } from '../ocr/scan';
import { renderPdfPagesInBrowser } from '../pdf/render-client';
import { SandboxError } from '../errors';
import { runSandboxedWorker } from '../sandbox-host';

export type Outcome<T> = { ok: true; value: T; maxGapMs: number; elapsedMs: number }
  | { ok: false; code: string; maxGapMs: number; elapsedMs: number };

/** Runs `task` while a 10 ms timer records the longest gap between ticks on the page's main thread. */
async function measured<T>(task: () => Promise<T>): Promise<Outcome<T>> {
  const started = performance.now();
  let last = started;
  let maxGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  }, 10);
  try {
    const value = await task();
    return { ok: true, value, maxGapMs, elapsedMs: performance.now() - started };
  } catch (error) {
    const code = error instanceof SandboxError ? error.code : `UNEXPECTED:${String(error)}`;
    return { ok: false, code, maxGapMs, elapsedMs: performance.now() - started };
  } finally {
    clearInterval(timer);
  }
}

function base64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const api = {
  async extractSample(name: string, options: { timeoutMs?: number; abortAfterMs?: number } = {}) {
    const blob = await (await fetch(`/sample/${encodeURIComponent(name)}`)).blob();
    const controller = new AbortController();
    if (options.abortAfterMs !== undefined) setTimeout(() => controller.abort(), options.abortAfterMs);
    return measured(async () => {
      const result = await extractDocxInBrowser(blob, { timeoutMs: options.timeoutMs, signal: controller.signal });
      const images = result.images.map(({ contentType, bytes, offset }) =>
        ({ contentType, offset, byteLength: bytes.byteLength, base64: base64(bytes) }));
      return { ...result, images };
    });
  },
  async extractPdfSample(name: string, options: { timeoutMs?: number; abortAfterMs?: number } = {}) {
    const blob = await (await fetch(`/sample/${encodeURIComponent(name)}`)).blob();
    const controller = new AbortController();
    if (options.abortAfterMs !== undefined) setTimeout(() => controller.abort(), options.abortAfterMs);
    return measured(() => extractPdfInBrowser(blob, { timeoutMs: options.timeoutMs, signal: controller.signal }));
  },
  runWorker(workerSource: string, timeoutMs: number, allowWasm = false) {
    return measured(() => runSandboxedWorker({ workerSource, input: new ArrayBuffer(8), timeoutMs, allowWasm }));
  },
  /** LIB-2d: recognises samples; `flip` turns a sample upside down first, `garbage` sends random bytes. */
  async recognizeSamples(names: string[], options: { flip?: string[] } = {}) {
    const blobs = await Promise.all(names.map(async (name) => {
      if (name === 'garbage') return new Blob([crypto.getRandomValues(new Uint8Array(4096))]);
      const blob = await (await fetch(`/sample/${encodeURIComponent(name)}`)).blob();
      if (!options.flip?.includes(name)) return blob;
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.translate(bitmap.width, bitmap.height);
      ctx.rotate(Math.PI);
      ctx.drawImage(bitmap, 0, 0);
      return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    }));
    return measured(() => recognizeImagesInBrowser(blobs));
  },
  /** Cancels while the relay hash is still being computed (before any frame exists). */
  runCancelledEarly() {
    const controller = new AbortController();
    return measured(async () => {
      const run = runSandboxedWorker({ workerSource: 'for (;;) {}', input: new ArrayBuffer(8), timeoutMs: 30_000, signal: controller.signal });
      controller.abort();
      return run;
    });
  },
  runRelay(relayScript: string, timeoutMs: number) {
    return measured(() => runSandboxedWorker({ workerSource: '', input: new ArrayBuffer(0), timeoutMs, relayScript }));
  },
  /** LIB-2d: renders PDF sample pages; returns sizes only (the images stay in the page). */
  async renderSample(name: string, pages: number[]) {
    const blob = await (await fetch(`/sample/${encodeURIComponent(name)}`)).blob();
    return measured(async () => Promise.all((await renderPdfPagesInBrowser(blob, pages)).map(async (page) => {
      if (!page.ok) return page;
      const bitmap = await createImageBitmap(page.image);
      return { ok: true, page: page.page, bytes: page.image.size, width: bitmap.width, height: bitmap.height };
    })));
  },
  async recognizePdfSample(name: string, pages: number[]) {
    const blob = await (await fetch(`/sample/${encodeURIComponent(name)}`)).blob();
    return measured(() => recognizePdfPagesInBrowser(blob, pages));
  },
  frameCount: () => document.querySelectorAll('iframe').length,
};

(window as unknown as { sandboxTest: typeof api }).sandboxTest = api;
