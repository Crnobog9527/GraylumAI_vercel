/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';

/**
 * Byte-level checks before pdf.js sees the file. The header must appear in the first 1,024 bytes
 * (as PDF readers allow). Any encryption dictionary in a trailer or cross-reference stream
 * (`/Encrypt 12 0 R` or an inline `/Encrypt <<`) rejects the file, with or without an open password
 * (LIB_DOCS_PLAN §4.2); pdf.js reporting a password or permissions afterwards is checked as well.
 */

const HEADER = '%PDF-';
const ENCRYPT = /\/Encrypt(?:\s|%[^\r\n]*[\r\n])*(?:\d+\s+\d+\s+R\b|<<)/;

export function precheckPdf(input: Uint8Array): void {
  const head = new TextDecoder('latin1').decode(input.subarray(0, 1024));
  if (!head.includes(HEADER)) throw new SandboxError('PDF_INVALID');
  if (ENCRYPT.test(new TextDecoder('latin1').decode(input))) throw new SandboxError('PDF_ENCRYPTED');
}
