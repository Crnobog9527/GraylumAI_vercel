/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';

/**
 * Width and height from a JPEG, PNG or WebP header (LIB-2d), read before any decoding so an image that is
 * small on disk but huge in pixels is refused without being expanded. Other formats are not recognised.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const invalid = () => { throw new SandboxError('IMAGE_INVALID'); };
  const u16 = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!;
  const u32 = (i: number) => ((bytes[i]! << 24) >>> 0) + (bytes[i + 1]! << 16) + (bytes[i + 2]! << 8) + bytes[i + 3]!;
  const le16 = (i: number) => bytes[i]! | (bytes[i + 1]! << 8);
  const le24 = (i: number) => bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16);
  const ascii = (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n));
  if (bytes.length < 30) return invalid();
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') return { width: u32(16), height: u32(20) };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8X') return { width: le24(24) + 1, height: le24(27) + 1 };
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    }
    return invalid();
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalid();
  // JPEG: walk the segments to the first frame header (SOF0–SOF15 except DHT, JPG and DAC).
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return invalid();
    const marker = bytes[i + 1]!;
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return invalid();
    if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; }
    const length = u16(i + 2);
    if (length < 2) return invalid();
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: u16(i + 7), height: u16(i + 5) };
    }
    i += 2 + length;
  }
  return invalid();
}
