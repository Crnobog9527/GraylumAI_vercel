/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Bundled by scripts/build-library-sandbox.mjs into public/library-sandbox/docx-worker.js.
// Runs only inside the sandbox Worker; never imported by application pages.
import '../worker/harden';
import { serveOnce } from '../worker/serve';
import { extractDocx } from './extract-docx';

serveOnce(async (input) => {
  const value = await extractDocx(input);
  return { value, transfer: value.images.map((image) => image.bytes) };
});
