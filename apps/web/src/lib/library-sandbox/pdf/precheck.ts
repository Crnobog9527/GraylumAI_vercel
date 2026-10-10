/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';

/**
 * Byte-level check before pdf.js sees the file: the header must appear in the first 1,024 bytes
 * (as PDF readers allow). Encryption is decided by pdf.js from the real trailer (see extract-pdf.ts),
 * not by searching the bytes: an ordinary PDF may mention `/Encrypt 12 0 R` in its text.
 */

const HEADER = '%PDF-';
const ENCRYPT = /\/Encrypt(?:\s|%[^\r\n]*[\r\n])*(?:\d+\s+\d+\s+R\b|<<)/;

export function precheckPdf(input: Uint8Array): void {
  const head = new TextDecoder('latin1').decode(input.subarray(0, 1024));
  if (!head.includes(HEADER)) throw new SandboxError('PDF_INVALID');
}

/**
 * Only used to word a failure: when pdf.js cannot open a file that looks like it carries an
 * encryption dictionary, the user is told about encryption rather than damage.
 */
export function mentionsEncryption(input: Uint8Array): boolean {
  return ENCRYPT.test(new TextDecoder('latin1').decode(input));
}
