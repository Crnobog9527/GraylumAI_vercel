/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Page-side test entry, bundled by browser-harness.ts with the feature flag on. Exposes the real
// production entry points plus a main-thread responsiveness probe.
import { extractDocxInBrowser } from '../docx/client';
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
  runWorker(workerSource: string, timeoutMs: number) {
    return measured(() => runSandboxedWorker({ workerSource, input: new ArrayBuffer(8), timeoutMs }));
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
  frameCount: () => document.querySelectorAll('iframe').length,
};

(window as unknown as { sandboxTest: typeof api }).sandboxTest = api;
