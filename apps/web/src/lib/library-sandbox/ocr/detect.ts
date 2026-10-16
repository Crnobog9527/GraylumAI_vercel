/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * PP-OCRv6 text detection pre- and post-processing (LIB-2d). Pure functions over pixel arrays, so they
 * run in the sandbox Worker and in unit tests alike. Parameters follow the configuration measured in
 * the LIB-2d evaluation (docs/launch/evidence/LIB-2D-OCR-EVAL-*.md): input resized to a multiple of 32,
 * ImageNet normalisation, every pixel with a non-zero probability is text, 8-connected regions become
 * axis-aligned boxes padded by 0.4 × height vertically and 0.6 × height horizontally.
 */

export type Box = { x: number; y: number; width: number; height: number };

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;
const MIN_REGION_AREA = 20;
const PAD_VERTICAL = 0.4;
const PAD_HORIZONTAL = 0.6;
const MIN_BOX_SIDE = 5;

export type DetectionSize = {
  /** Resized image inside the model input. */
  width: number;
  height: number;
  /** Model input, padded to multiples of 32. */
  inputWidth: number;
  inputHeight: number;
  /** Resized / original. */
  ratio: number;
};

/** Longest side 960–1920 (75% of the original, in steps of 32); smaller images keep their size. */
export function detectionSize(width: number, height: number): DetectionSize {
  const longest = Math.max(width, height);
  const maxSide = Math.min(1920, Math.max(960, Math.round((longest * 0.75) / 32) * 32));
  const ratio = longest > maxSide ? maxSide / longest : 1;
  const w = Math.round(width * ratio);
  const h = Math.round(height * ratio);
  return { width: w, height: h, inputWidth: Math.ceil(w / 32) * 32, inputHeight: Math.ceil(h / 32) * 32, ratio };
}

/** CHW float tensor from RGBA pixels of the padded input canvas. */
export function detectionTensor(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const size = width * height;
  const tensor = new Float32Array(3 * size);
  for (let i = 0, p = 0; i < size; i++, p += 4) {
    for (let c = 0; c < 3; c++) tensor[c * size + i] = (rgba[p + c]! / 255 - MEAN[c]!) / STD[c]!;
  }
  return tensor;
}

/**
 * Boxes in original-image coordinates from the probability map (inputWidth × inputHeight).
 * A pixel is text when round(p × 255) > 0, as in the evaluated configuration.
 */
export function detectionBoxes(probability: ArrayLike<number>, size: DetectionSize, originalWidth: number,
  originalHeight: number): Box[] {
  const { inputWidth: w, inputHeight: h, ratio } = size;
  const text = (i: number) => Math.round((probability[i] ?? 0) * 255) > 0;
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const boxes: Box[] = [];
  for (let start = 0; start < w * h; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    if (!text(start)) continue;
    let top = 0;
    stack[top++] = start;
    let minX = start % w, maxX = minX, minY = (start - minX) / w, maxY = minY, area = 0;
    while (top > 0) {
      const flat = stack[--top]!;
      area++;
      const x = flat % w, y = (flat - x) / w;
      if (x < minX) minX = x;
      else if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      else if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) continue;
          const next = ny * w + nx;
          if (visited[next]) continue;
          visited[next] = 1;
          if (text(next)) stack[top++] = next;
        }
      }
    }
    if (area < MIN_REGION_AREA) continue;
    const boxHeight = maxY + 1 - minY;
    const padV = Math.round(boxHeight * PAD_VERTICAL), padH = Math.round(boxHeight * PAD_HORIZONTAL);
    const x0 = Math.max(0, Math.round(Math.max(0, minX - padH) / ratio));
    const y0 = Math.max(0, Math.round(Math.max(0, minY - padV) / ratio));
    const x1 = Math.min(originalWidth, Math.round(Math.min(w, maxX + 1 + padH) / ratio));
    const y1 = Math.min(originalHeight, Math.round(Math.min(h, maxY + 1 + padV) / ratio));
    if (x1 - x0 > MIN_BOX_SIDE && y1 - y0 > MIN_BOX_SIDE) boxes.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return boxes;
}
