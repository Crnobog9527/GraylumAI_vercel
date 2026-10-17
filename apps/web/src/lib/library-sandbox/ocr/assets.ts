/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Recognition runtime and models, served from Graylum's own origin by scripts/build-library-sandbox.mjs
 * (sources and licences: apps/web/assets/library-ocr/README.md). The page checks each file's SHA-256
 * before handing it to the sandbox; scripts/library-ocr-assets.mjs checks the same values at build time.
 */
export const OCR_WORKER_PATH = '/library-sandbox/ocr-worker.js';
export const OCR_ASSET_BASE = '/library-sandbox/ocr/';
export const OCR_ASSET_SHA256 = {
  wasm: ['ort.wasm', '3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2'],
  det: ['det.onnx', '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8'],
  rec: ['rec.onnx', '9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6'],
  dict: ['dict.txt', '34d139222b6e8d84830f57476e39f01e76be3baffde3e9df75a079e251140598'],
} as const;
