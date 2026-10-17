/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Bundled by scripts/build-library-sandbox.mjs into public/library-sandbox/pdf-render-worker.js. Runs only inside the
// sandbox Worker (no WebAssembly, no network); never imported by application pages.
import '../worker/harden';
import { pdfGuard } from './harden-pdf';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { serveOnce } from '../worker/serve';
import { renderPdfPages } from './render-pdf';
import { unpackRenderInput } from './render-pack';

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler };

serveOnce(async (input) => {
  const { pdf, pages } = unpackRenderInput(input);
  const rendered = await renderPdfPages(pdf, pages, pdfGuard);
  return { value: { pages: rendered }, transfer: rendered.flatMap((page) => (page.ok ? [page.jpeg] : [])) };
});
