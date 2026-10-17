/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';

/**
 * The single ArrayBuffer the recognition Worker receives (LIB-2d): the runtime and model bytes, the
 * dictionary and up to OCR_LIMITS.maxImages page images, so models are loaded once per batch.
 * Layout: u32 part count, u32 length of each part, then the parts back to back (little-endian).
 */

export const OCR_PARTS = ['wasm', 'det', 'rec', 'dict'] as const;
export type OcrModelParts = Record<(typeof OCR_PARTS)[number], Uint8Array>;
export type OcrInput = OcrModelParts & { images: Uint8Array[] };

export function packOcrInput(input: OcrInput): ArrayBuffer {
  const parts = [...OCR_PARTS.map((name) => input[name]), ...input.images];
  const header = 4 * (parts.length + 1);
  const buffer = new ArrayBuffer(header + parts.reduce((sum, part) => sum + part.byteLength, 0));
  const view = new DataView(buffer);
  view.setUint32(0, parts.length, true);
  let offset = header;
  parts.forEach((part, i) => {
    view.setUint32(4 * (i + 1), part.byteLength, true);
    new Uint8Array(buffer, offset, part.byteLength).set(part);
    offset += part.byteLength;
  });
  return buffer;
}

export function unpackOcrInput(bytes: Uint8Array, maxImages: number): OcrInput {
  const fail = () => { throw new SandboxError('SANDBOX_PROTOCOL'); };
  if (bytes.byteLength < 4) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count < OCR_PARTS.length + 1 || count > OCR_PARTS.length + maxImages || 4 * (count + 1) > bytes.byteLength) fail();
  let offset = 4 * (count + 1);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const length = view.getUint32(4 * (i + 1), true);
    if (length === 0 || offset + length > bytes.byteLength) fail();
    parts.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== bytes.byteLength) fail();
  const [wasm, det, rec, dict, ...images] = parts;
  return { wasm: wasm!, det: det!, rec: rec!, dict: dict!, images };
}
