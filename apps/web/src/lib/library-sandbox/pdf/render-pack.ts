/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';
import { PDF_RENDER_LIMITS } from '../limits';

/** Render Worker input (LIB-2d): u32 page count, u32 page numbers (1-based), then the PDF bytes (little-endian). */
export function packRenderInput(pdf: Uint8Array, pages: number[]): ArrayBuffer {
  const header = 4 * (pages.length + 1);
  const buffer = new ArrayBuffer(header + pdf.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, pages.length, true);
  pages.forEach((page, i) => view.setUint32(4 * (i + 1), page, true));
  new Uint8Array(buffer, header).set(pdf);
  return buffer;
}

export function unpackRenderInput(bytes: Uint8Array): { pdf: Uint8Array; pages: number[] } {
  if (bytes.byteLength < 4) throw new SandboxError('SANDBOX_PROTOCOL');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count < 1 || count > PDF_RENDER_LIMITS.maxPages || 4 * (count + 1) >= bytes.byteLength) throw new SandboxError('SANDBOX_PROTOCOL');
  const pages = Array.from({ length: count }, (_, i) => view.getUint32(4 * (i + 1), true));
  return { pdf: bytes.subarray(4 * (count + 1)), pages };
}
