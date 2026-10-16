/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectionBoxes, detectionSize, detectionTensor } from '../ocr/detect';
import { decodeCtc, keepRecognized, recognitionTensor, recognitionWidth } from '../ocr/recognize';
import { readingOrder, type Item } from '../ocr/reading-order';
import { packOcrInput, unpackOcrInput } from '../ocr/pack';
import { validateOcrBatch } from '../ocr/result';
import { OCR_ASSET_SHA256 } from '../ocr/assets';
import { skewAngle } from '../ocr/deskew';
import { sandboxCsp } from '../frame-document';
import { OCR_ASSETS, dictionaryFromConfig, libraryOcrAssets } from '../../../../scripts/library-ocr-assets.mjs';

const webRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('detection', () => {
  it('sizes the model input like the evaluated configuration', () => {
    // 0.75 × 2339 rounds to 1760 (a multiple of 32), so the page is scaled by 1760 / 2339.
    expect(detectionSize(1654, 2339)).toEqual({ width: 1245, height: 1760, inputWidth: 1248, inputHeight: 1760, ratio: 1760 / 2339 });
    expect(detectionSize(900, 600)).toEqual({ width: 900, height: 600, inputWidth: 928, inputHeight: 608, ratio: 1 });
    expect(detectionSize(4000, 100).inputWidth).toBe(1920);
  });
  it('normalises RGB with ImageNet mean and deviation, channel first', () => {
    const t = detectionTensor(new Uint8ClampedArray([255, 0, 128, 255]), 1, 1);
    expect([...t].map((v) => Number(v.toFixed(3)))).toEqual([2.249, -2.036, 0.426]);
  });
  it('turns connected text pixels into padded boxes in original coordinates and drops specks', () => {
    const size = { width: 64, height: 32, inputWidth: 64, inputHeight: 32, ratio: 0.5 };
    const p = new Float32Array(64 * 32);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 40; x++) p[y * 64 + x] = 0.9;
    p[5 * 64 + 60] = 0.9; // a single speck (area 1 < 20)
    // x 10–39, y 10–19, padded by 6 / 4, then scaled back by 1 / 0.5.
    expect(detectionBoxes(p, size, 128, 64)).toEqual([{ x: 8, y: 12, width: 84, height: 36 }]);
  });
});

describe('recognition', () => {
  const dictionary = ['a', 'b', '中'];
  const scores = (steps: number[]) => {
    const out = new Float32Array(steps.length * 5);
    steps.forEach((c, t) => { out[t * 5 + c] = 0.9; });
    return out;
  };
  it('decodes greedy CTC: blanks and repeats collapse, the last class is a space', () => {
    expect(decodeCtc(scores([1, 1, 0, 1, 2, 4, 3]), 7, 5, dictionary)).toEqual({ text: 'aab 中', confidence: expect.closeTo(0.9, 5) });
    expect(() => decodeCtc(scores([1]), 1, 4, dictionary)).toThrow('OCR_DICTIONARY_MISMATCH');
  });
  it('keeps text at 0.5 confidence and symbols only at 0.8', () => {
    expect(keepRecognized({ text: '中', confidence: 0.5 })).toBe(true);
    expect(keepRecognized({ text: '—', confidence: 0.7 })).toBe(false);
  });
  it('scales boxes to height 48 and uses the red channel in [-1, 1]', () => {
    expect(recognitionWidth(200, 50)).toBe(192);
    expect(recognitionWidth(2, 50)).toBe(8);
    const t = recognitionTensor(new Uint8ClampedArray(48 * 1 * 4).fill(255), 1);
    expect(t.length).toBe(3 * 48);
    expect(t.every((v) => v === 1)).toBe(true);
  });
});

describe('reading order', () => {
  const line = (text: string, x: number, y: number, width = 400, height = 30): Item => ({ text, box: { x, y, width, height } });
  it('reads two columns left then right, below a full-width title', () => {
    const items = [line('标题', 100, 0, 900), line('R1', 560, 60), line('L1', 100, 60), line('R2', 560, 100), line('L2', 100, 100)];
    expect(readingOrder(items)).toBe('标题\nL1\nL2\nR1\nR2');
  });
  it('reads a table row by row, cells left to right', () => {
    const cell = (text: string, col: number, row: number) => line(text, 100 + col * 160, 100 + row * 50, 120);
    const items = [cell('B1', 1, 0), cell('A2', 0, 1), cell('A1', 0, 0), cell('C2', 2, 1), cell('B2', 1, 1), cell('C1', 2, 0)];
    expect(readingOrder(items)).toBe('A1 B1 C1\nA2 B2 C2');
  });
  it('keeps one column in rows and skips empty text', () => {
    expect(readingOrder([line('第二行', 100, 50), line('', 100, 90), line('第一行', 100, 10)])).toBe('第一行\n第二行');
  });
});

describe('deskew', () => {
  it('finds the angle of slanted dark rows', () => {
    const w = 400, h = 300, grey = new Float32Array(w * h).fill(255);
    const slope = Math.tan((2 * Math.PI) / 180);
    for (let row = 40; row < 260; row += 30) {
      for (let x = 20; x < 380; x++) for (let t = 0; t < 4; t++) {
        const y = Math.round(row + (x - w / 2) * slope) + t;
        if (y >= 0 && y < h) grey[y * w + x] = 0;
      }
    }
    expect(Math.abs(Math.abs(skewAngle(grey, w, h)) - 2)).toBeLessThanOrEqual(0.2);
  });
});

describe('sandbox input and reply', () => {
  const parts = { wasm: new Uint8Array([1]), det: new Uint8Array([2, 2]), rec: new Uint8Array([3]), dict: new Uint8Array([4]) };
  it('packs models and images into one buffer and back', () => {
    const packed = new Uint8Array(packOcrInput({ ...parts, images: [new Uint8Array([9, 9, 9])] }));
    const back = unpackOcrInput(packed, 8);
    expect([...back.det]).toEqual([2, 2]);
    expect(back.images.map((i) => [...i])).toEqual([[9, 9, 9]]);
    expect(() => unpackOcrInput(packed.subarray(0, packed.length - 1), 8)).toThrow('SANDBOX_PROTOCOL');
    expect(() => unpackOcrInput(new Uint8Array(packOcrInput({ ...parts, images: [] })), 8)).toThrow('SANDBOX_PROTOCOL');
    expect(() => unpackOcrInput(packed, 0)).toThrow('SANDBOX_PROTOCOL');
  });
  it('accepts exactly one well-formed result per image', () => {
    const ok = { ok: true, text: 'x', confidence: 0.9, angle: 1.5, flipped: false, ms: 10 };
    expect(validateOcrBatch({ pages: [ok, { ok: false, code: 'IMAGE_INVALID' }] }, 2).pages).toHaveLength(2);
    for (const bad of [{ pages: [ok] }, { pages: [{ ...ok, confidence: 2 }, ok] }, { pages: [{ ok: false, code: 'NOPE' }, ok] },
      { pages: [{ ...ok, extra: undefined, text: 1 }, ok] }]) expect(() => validateOcrBatch(bad, 2)).toThrow('SANDBOX_PROTOCOL');
  });
  it('allows WebAssembly only in the recognition CSP, never eval or network', () => {
    expect(sandboxCsp('sha256-x')).not.toContain('wasm-unsafe-eval');
    const csp = sandboxCsp('sha256-x', { wasm: true });
    expect(csp).toContain("script-src 'sha256-x' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/'unsafe-eval'|'unsafe-inline'/);
  });
});

describe('recognition assets', () => {
  it('page-side SHA-256 values match the build-time ones and the committed files', async () => {
    const files = await libraryOcrAssets(webRoot) as unknown as Record<string, Buffer>;
    const build = OCR_ASSETS as unknown as Record<string, [string, string]>;
    for (const [, [name, sha]] of Object.entries(OCR_ASSET_SHA256)) {
      expect(createHash('sha256').update(files[name]!).digest('hex'), name).toBe(sha);
      if (name !== 'dict.txt') expect(build[name]![1]).toBe(sha);
    }
  });
  it('extracts the dictionary from the official YAML and refuses malformed entries', () => {
    const yaml = (entries: string[]) => `PostProcess:\n  character_dict:\n${entries.map((e) => `  - ${e}`).join('\n')}\n`;
    expect(() => dictionaryFromConfig(yaml(['a']))).toThrow('expected 6904');
    expect(() => dictionaryFromConfig(yaml(['"a"']))).toThrow('double-quoted');
    expect(() => dictionaryFromConfig(yaml(['ab']))).toThrow('not one character');
  });
});
