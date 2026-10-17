/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Header-only synthetic JPEG: SOI, one frame header, a scan header, filler, EOI. No pixels are decoded. */
export function syntheticJpeg(width: number, height: number, options: { marker?: number; precision?: number;
  components?: number; extraFrame?: boolean; scanFirst?: boolean; dropEoi?: boolean } = {}): Buffer {
  const components = options.components ?? 3;
  const frame = [0xff, options.marker ?? 0xc0, 0, 8 + 3 * components, options.precision ?? 8,
    height >> 8, height & 0xff, width >> 8, width & 0xff, components, ...Array(3 * components).fill(1)];
  const scan = [0xff, 0xda, 0, 8, 1, 1, 0, 0x3f, 0, 0];
  const head = options.scanFirst ? [...scan, ...frame] : [...frame, ...(options.extraFrame ? frame : []), ...scan];
  return Buffer.from([0xff, 0xd8, ...head, 0x12, 0x34, 0x56, ...(options.dropEoi ? [] : [0xff, 0xd9])]);
}
