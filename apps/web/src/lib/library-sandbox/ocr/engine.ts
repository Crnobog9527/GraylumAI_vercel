/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Worker-only: PP-OCRv6 tiny on onnxruntime-web (single-threaded wasm, bytes handed in, no downloads).
import * as ort from 'onnxruntime-web/wasm';
import { SandboxError } from '../errors';
import { OCR_LIMITS } from '../limits';
import { deskew, rotate180 } from './deskew';
import { imageDimensions } from './image-header';
import { detectionBoxes, detectionSize, detectionTensor, type Box } from './detect';
import type { OcrModelParts } from './pack';
import { readingOrder, type Item } from './reading-order';
import { decodeCtc, keepRecognized, RECOGNITION_HEIGHT, recognitionTensor, recognitionWidth, TALL_BOX_RATIO } from './recognize';
import type { OcrPage } from './types';

/** Below this mean confidence a page is retried upside down (LIB-2d step 2: 3/3 inverted scans recovered). */
const ORIENTATION_RETRY_CONFIDENCE = 0.8;
/** Boxes are cut from a copy whose longest side is at most this (as evaluated). */
const MAX_CROP_SOURCE_SIDE = 2000;

const copy = (bytes: Uint8Array) => bytes.slice().buffer;

function context(canvas: OffscreenCanvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new SandboxError('WORKER_FAILED');
  return ctx;
}

export async function createOcrEngine(parts: OcrModelParts) {
  // Single thread, no proxy Worker, the runtime from bytes: onnxruntime-web never fetches or imports anything.
  ort.env.wasm.wasmBinary = copy(parts.wasm);
  ort.env.wasm.wasmPaths = { wasm: 'data:,' };
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const options: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const det = await ort.InferenceSession.create(new Uint8Array(copy(parts.det)), options);
  const rec = await ort.InferenceSession.create(new Uint8Array(copy(parts.rec)), options);
  const dictionary = new TextDecoder('utf-8', { fatal: true }).decode(parts.dict).split('\n');

  async function run(session: ort.InferenceSession, data: Float32Array, dims: number[]) {
    const input = new ort.Tensor('float32', data, dims);
    try {
      const output = await session.run({ [session.inputNames[0]!]: input });
      return output[session.outputNames[0]!]!;
    } finally {
      input.dispose();
    }
  }

  async function detect(canvas: OffscreenCanvas): Promise<Box[]> {
    const size = detectionSize(canvas.width, canvas.height);
    const padded = new OffscreenCanvas(size.inputWidth, size.inputHeight);
    const ctx = context(padded);
    ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, size.width, size.height);
    const rgba = ctx.getImageData(0, 0, size.inputWidth, size.inputHeight).data;
    const probability = await run(det, detectionTensor(rgba, size.inputWidth, size.inputHeight), [1, 3, size.inputHeight, size.inputWidth]);
    return detectionBoxes(probability.data as Float32Array, size, canvas.width, canvas.height);
  }

  async function read(source: OffscreenCanvas, box: Box) {
    const tall = box.height / box.width >= TALL_BOX_RATIO;
    const [w, h] = tall ? [box.height, box.width] : [box.width, box.height];
    const width = recognitionWidth(w, h);
    const crop = new OffscreenCanvas(width, RECOGNITION_HEIGHT);
    const ctx = context(crop);
    if (tall) {
      // Upright 90° turn: the crop's top edge becomes the left edge.
      ctx.scale(width / w, RECOGNITION_HEIGHT / h);
      ctx.translate(0, box.width);
      ctx.rotate(-Math.PI / 2);
    } else ctx.scale(width / w, RECOGNITION_HEIGHT / h);
    ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
    const scores = await run(rec, recognitionTensor(ctx.getImageData(0, 0, width, RECOGNITION_HEIGHT).data, width),
      [1, 3, RECOGNITION_HEIGHT, width]);
    const [, steps, classes] = scores.dims as number[];
    return decodeCtc(scores.data as Float32Array, steps!, classes!, dictionary);
  }

  async function pass(canvas: OffscreenCanvas) {
    const boxes = await detect(canvas);
    const scale = Math.min(1, MAX_CROP_SOURCE_SIDE / Math.max(canvas.width, canvas.height));
    let source = canvas;
    if (scale < 1) {
      source = new OffscreenCanvas(Math.round(canvas.width * scale), Math.round(canvas.height * scale));
      context(source).drawImage(canvas, 0, 0, source.width, source.height);
    }
    const items: Array<Item & { confidence: number }> = [];
    for (const box of boxes) {
      const scaled = scale === 1 ? box : { x: Math.round(box.x * scale), y: Math.round(box.y * scale),
        width: Math.max(1, Math.round(box.width * scale)), height: Math.max(1, Math.round(box.height * scale)) };
      const decoded = await read(source, scaled);
      if (keepRecognized(decoded)) items.push({ ...decoded, box });
    }
    const confidence = items.length ? items.reduce((sum, item) => sum + item.confidence, 0) / items.length : 0;
    return { text: readingOrder(items), confidence };
  }

  return {
    async recognize(image: Uint8Array): Promise<OcrPage> {
      const started = performance.now();
      // Refuse huge images from their header, before the browser expands any pixels.
      const header = imageDimensions(image);
      if (!(header.width > 0 && header.height > 0) || Math.max(header.width, header.height) > OCR_LIMITS.maxImageEdge
        || header.width * header.height > OCR_LIMITS.maxImagePixels) throw new SandboxError('INPUT_TOO_LARGE');
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(new Blob([copy(image)]));
      } catch {
        throw new SandboxError('IMAGE_INVALID');
      }
      try {
        if (Math.max(bitmap.width, bitmap.height) > OCR_LIMITS.maxImageEdge
          || bitmap.width * bitmap.height > OCR_LIMITS.maxImagePixels) throw new SandboxError('INPUT_TOO_LARGE');
        const { canvas, angle } = deskew(bitmap);
        let result = await pass(canvas), flipped = false;
        if (result.confidence < ORIENTATION_RETRY_CONFIDENCE) {
          const second = await pass(rotate180(canvas));
          if (second.confidence > result.confidence) { result = second; flipped = true; }
        }
        if (result.text.length > OCR_LIMITS.maxPageChars) throw new SandboxError('TEXT_TOO_LARGE');
        return { ok: true, text: result.text, confidence: result.confidence, angle, flipped,
          ms: Math.round(performance.now() - started) };
      } finally {
        bitmap.close();
      }
    },
  };
}
