/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import cmaps from 'graylum:pdf-cmaps';

/**
 * pdf.js `BinaryDataFactory` for the network-less sandbox: packed CMaps (needed to read Chinese,
 * Japanese and Korean text that uses predefined encodings) come from the worker bundle itself.
 * Standard font files and WebAssembly decoders are refused, so pdf.js never tries to download them;
 * text extraction does not need either.
 */
export class EmbeddedDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const name = kind === 'cMapUrl' && filename.endsWith('.bcmap') ? filename.slice(0, -'.bcmap'.length) : null;
    const data = name !== null && Object.hasOwn(cmaps, name) ? cmaps[name] : undefined;
    if (data === undefined) throw new Error('not available in the library sandbox');
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
}
