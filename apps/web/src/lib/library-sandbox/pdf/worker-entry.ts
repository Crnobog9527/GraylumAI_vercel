/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Bundled by scripts/build-library-sandbox.mjs into public/library-sandbox/pdf-worker.js.
// Runs only inside the sandbox Worker; never imported by application pages.
import '../worker/harden';
import { pdfGuard } from './harden-pdf';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { serveOnce } from '../worker/serve';
import { extractPdf } from './extract-pdf';

// pdf.js runs its parser in this same Worker ("fake worker") instead of starting a nested one.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler };

serveOnce(async (input) => ({ value: await extractPdf(input, pdfGuard) }));
