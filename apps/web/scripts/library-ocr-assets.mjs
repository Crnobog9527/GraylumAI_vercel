/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB-2d: verifies the committed PaddlePaddle models (assets/library-ocr/README.md) and the pinned onnxruntime-web
// wasm by SHA-256, extracts the recognition dictionary from the official inference.yml, and returns the bytes the
// sandbox loads from Graylum's own origin. Any mismatch fails the build.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Served name -> [source file, SHA-256]. */
export const OCR_ASSETS = {
  'det.onnx': ['assets/library-ocr/PP-OCRv6_tiny_det.onnx', '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8'],
  'rec.onnx': ['assets/library-ocr/PP-OCRv6_tiny_rec.onnx', '9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6'],
  'ort.wasm': [require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'), '3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2'],
};
const REC_CONFIG = ['assets/library-ocr/PP-OCRv6_tiny_rec.inference.yml',
  '66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1'];
export const OCR_DICTIONARY_SIZE = 6904;

async function verified(webRoot, [file, sha]) {
  const bytes = await readFile(path.isAbsolute(file) ? file : path.join(webRoot, file));
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha) throw new Error(`library OCR asset ${file}: sha256 ${got} does not match ${sha}`);
  return bytes;
}

/** The `character_dict` list of the official inference.yml, one character per line (plain or single-quoted YAML scalars). */
export function dictionaryFromConfig(text) {
  const lines = text.split('\n');
  const start = lines.indexOf('  character_dict:');
  if (start < 0) throw new Error('library OCR: character_dict not found');
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  - ')) break;
    let value = line.slice(4);
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1).replace(/''/g, "'");
    else if (value.startsWith('"')) throw new Error('library OCR: double-quoted dictionary entry is not supported');
    if ([...value].length !== 1) throw new Error(`library OCR: dictionary entry ${entries.length} is not one character`);
    entries.push(value);
  }
  if (entries.length !== OCR_DICTIONARY_SIZE || new Set(entries).size !== entries.length) {
    throw new Error(`library OCR: dictionary has ${entries.length} entries, expected ${OCR_DICTIONARY_SIZE} distinct`);
  }
  return entries.join('\n');
}

/** `{ servedName: Buffer }` for public/library-sandbox/ocr/. */
export async function libraryOcrAssets(webRoot) {
  const files = {};
  for (const [name, source] of Object.entries(OCR_ASSETS)) files[name] = await verified(webRoot, source);
  files['dict.txt'] = Buffer.from(dictionaryFromConfig((await verified(webRoot, REC_CONFIG)).toString('utf8')));
  return files;
}
