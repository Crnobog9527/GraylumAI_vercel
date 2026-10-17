/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Straightens a slightly rotated scan before recognition (LIB-2d evaluation: without it both engines drop
 * whole paragraphs at 1.5°). Projection profile: on an ink mask, the angle within ±6° (step 0.1°) whose row
 * histogram has the sharpest edges is the text angle. Worker-only (OffscreenCanvas).
 */

const RANGE = 6;
const STEP = 0.1;
const SAMPLE_SIDE = 800;
const BLOCK = 16;
/** A pixel is ink when darker than 75% of its block mean (robust to uneven lighting). */
const INK = 0.75;

/** Ink pixel coordinates, centred, from a grey image. */
function inkPoints(grey: Float32Array, w: number, h: number): Float32Array {
  const points: number[] = [];
  for (let by = 0; by < h; by += BLOCK) {
    for (let bx = 0; bx < w; bx += BLOCK) {
      let sum = 0, n = 0;
      for (let y = by; y < Math.min(h, by + BLOCK); y++) for (let x = bx; x < Math.min(w, bx + BLOCK); x++) { sum += grey[y * w + x]!; n++; }
      const threshold = (sum / n) * INK;
      for (let y = by; y < Math.min(h, by + BLOCK); y++) {
        for (let x = bx; x < Math.min(w, bx + BLOCK); x++) if (grey[y * w + x]! < threshold) points.push(x - w / 2, y - h / 2);
      }
    }
  }
  return Float32Array.from(points);
}

/** The skew angle in degrees (rotate by it to straighten). Pure, for tests. */
export function skewAngle(grey: Float32Array, w: number, h: number): number {
  const ink = inkPoints(grey, w, h);
  const bins = new Float64Array(h * 2);
  let best = 0, bestScore = -1;
  const steps = Math.round((2 * RANGE) / STEP);
  for (let k = 0; k <= steps; k++) {
    const angle = -RANGE + k * STEP;
    const r = (angle * Math.PI) / 180, sin = Math.sin(r), cos = Math.cos(r);
    bins.fill(0);
    for (let i = 0; i < ink.length; i += 2) {
      const y = Math.round(ink[i]! * sin + ink[i + 1]! * cos + h);
      if (y >= 0 && y < bins.length) bins[y]!++;
    }
    let score = 0;
    for (let y = 1; y < bins.length; y++) { const d = bins[y]! - bins[y - 1]!; score += d * d; }
    if (score > bestScore) { bestScore = score; best = angle; }
  }
  return Math.round(best * 10) / 10;
}

type Drawable = ImageBitmap | OffscreenCanvas;

export function deskew(image: Drawable): { canvas: OffscreenCanvas; angle: number } {
  const scale = Math.min(1, SAMPLE_SIDE / Math.max(image.width, image.height));
  const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
  const sample = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
  sample.drawImage(image, 0, 0, w, h);
  const px = sample.getImageData(0, 0, w, h).data;
  const grey = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) grey[i] = px[i * 4]! * 0.299 + px[i * 4 + 1]! * 0.587 + px[i * 4 + 2]! * 0.114;
  const angle = skewAngle(grey, w, h);
  const out = new OffscreenCanvas(image.width, image.height);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, image.width, image.height);
  ctx.translate(image.width / 2, image.height / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.translate(-image.width / 2, -image.height / 2);
  ctx.drawImage(image, 0, 0);
  return { canvas: out, angle };
}

/** The same canvas turned upside down. */
export function rotate180(image: OffscreenCanvas): OffscreenCanvas {
  const out = new OffscreenCanvas(image.width, image.height);
  const ctx = out.getContext('2d')!;
  ctx.translate(image.width, image.height);
  ctx.rotate(Math.PI);
  ctx.drawImage(image, 0, 0);
  return out;
}
