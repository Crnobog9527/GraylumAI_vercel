/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Bundled by scripts/build-library-sandbox.mjs into public/library-sandbox/ocr-worker.js. Runs only inside the
// recognition sandbox Worker (CSP adds 'wasm-unsafe-eval', still no network); never imported by pages.
import '../worker/harden';
import { toSandboxErrorCode } from '../errors';
import { OCR_LIMITS } from '../limits';
import { serveOnce } from '../worker/serve';
import { createOcrEngine } from './engine';
import { unpackOcrInput } from './pack';
import type { OcrBatch, OcrPage } from './types';

serveOnce<OcrBatch>(async (input) => {
  const { images, ...models } = unpackOcrInput(input, OCR_LIMITS.maxImages);
  const engine = await createOcrEngine(models);
  const pages: OcrPage[] = [];
  // Pages are independent: one unreadable image does not fail the others.
  for (const image of images) {
    try {
      pages.push(await engine.recognize(image));
    } catch (error) {
      pages.push({ ok: false, code: toSandboxErrorCode(error, 'WORKER_FAILED') });
    }
  }
  return { value: { pages } };
});
