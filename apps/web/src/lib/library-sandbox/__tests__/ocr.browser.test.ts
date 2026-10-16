/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB-2d acceptance in real Chromium: the recognition sandbox may compile WebAssembly (Owner 2026-10-17) but still
// has no network, eval or storage reach; the Word/PDF sandbox still cannot compile WebAssembly; PaddleOCR reads
// scan-like samples in the browser; an upside-down page is turned over; a bad image fails alone; a tampered model
// is refused before it reaches the sandbox.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './browser-harness';
import type { Outcome } from './harness-entry';
import { wasmWorkerProbe } from './sandbox-probes';
import type { OcrPage } from '../ocr/types';

type Api = {
  runWorker(source: string, timeoutMs: number, allowWasm?: boolean): Promise<Outcome<Record<string, string>>>;
  recognizeSamples(names: string[], options?: { flip?: string[] }): Promise<Outcome<OcrPage[]>>;
};
type Call = <K extends keyof Api>(name: K, ...args: Parameters<Api[K]>) => ReturnType<Api[K]>;

const FIXTURES = ['q29', 'q33', 'q12'] as const;
const expected = JSON.parse(readFileSync(new URL('./ocr-fixtures/expected.json', import.meta.url), 'utf8')) as Record<string, string>;

/** 1 − edit distance / reference length after NFKC and removing whitespace (as in scripts/lib-2d-ocr-eval). */
function accuracy(reference: string, text: string): number {
  const norm = (s: string) => [...s.normalize('NFKC').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, '')];
  const a = norm(reference), b = norm(text);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1), prev[j]! + 1, cur[j - 1]! + 1);
    prev = cur;
  }
  return 1 - prev[b.length]! / a.length;
}

let harness: Harness;
let page: Page;
const call: Call = ((name: keyof Api, ...args: unknown[]) => page.evaluate(
  ([method, params]) => {
    const api = (window as unknown as { sandboxTest: Record<string, (...a: unknown[]) => unknown> }).sandboxTest;
    return api[method as string](...(params as unknown[]));
  }, [name, args] as const)) as Call;

beforeAll(async () => {
  harness = await startHarness();
  for (const name of FIXTURES) harness.samples.set(name, readFileSync(new URL(`./ocr-fixtures/${name}.jpg`, import.meta.url)));
  // A real JPEG whose frame header claims 30,000 × 30,000 pixels.
  const huge = Buffer.from(readFileSync(new URL('./ocr-fixtures/q33.jpg', import.meta.url)));
  const sof = huge.findIndex((byte, i) => byte === 0xff && huge[i + 1]! >= 0xc0 && huge[i + 1]! <= 0xc2);
  huge.writeUInt16BE(30_000, sof + 5);
  huge.writeUInt16BE(30_000, sof + 7);
  harness.samples.set('huge-header', huge);
  page = await harness.open();
}, 120_000);
afterAll(async () => { await harness?.close(); }, 30_000);

describe('recognition sandbox (Chromium)', () => {
  it('compiles WebAssembly but still blocks every network, eval and storage channel', async () => {
    const outcome = await call('runWorker', wasmWorkerProbe(harness.outside), 30_000, true);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const report = (outcome as { value: Record<string, string> }).value;
    expect(report.wasmCompile).toBe('ALLOWED:compiled');
    for (const name of ['fetch', 'fetchNoCors', 'xhr', 'websocket', 'eventSource', 'importScripts', 'eval', 'newFunction',
      'nestedWorker', 'indexedDB', 'caches']) {
      expect(report[name], `${name}: ${JSON.stringify(report)}`).toMatch(/^blocked:/);
    }
    expect(harness.outsideRequests).toEqual([]);
  }, 60_000);

  it('keeps WebAssembly blocked in the Word / PDF sandbox', async () => {
    const outcome = await call('runWorker', wasmWorkerProbe(harness.outside), 30_000);
    expect((outcome as { value: Record<string, string> }).value.wasmCompile).toMatch(/^blocked:/);
  }, 60_000);

  it('reads scan-like samples at the evaluated accuracy, with no outside request', async () => {
    const outcome = await call('recognizeSamples', [...FIXTURES]);
    expect(outcome.ok, JSON.stringify(outcome).slice(0, 500)).toBe(true);
    const pages = (outcome as { value: OcrPage[] }).value;
    pages.forEach((result, i) => {
      expect(result.ok).toBe(true);
      const score = accuracy(expected[FIXTURES[i]!]!, (result as { text: string }).text);
      expect(score, `${FIXTURES[i]} ${score}`).toBeGreaterThanOrEqual(0.95);
    });
    expect(harness.outsideRequests).toEqual([]);
    expect(harness.unexpected).toEqual([]);
  }, 180_000);

  it('turns an upside-down page over and fails a bad image without failing the batch', async () => {
    const outcome = await call('recognizeSamples', ['q29', 'garbage'], { flip: ['q29'] });
    expect(outcome.ok, JSON.stringify(outcome).slice(0, 500)).toBe(true);
    const [flipped, garbage] = (outcome as { value: OcrPage[] }).value;
    expect(flipped).toMatchObject({ ok: true, flipped: true });
    expect(accuracy(expected.q29!, (flipped as { text: string }).text)).toBeGreaterThanOrEqual(0.95);
    expect(garbage).toEqual({ ok: false, code: 'IMAGE_INVALID' });
  }, 180_000);

  it('refuses an image that is huge in pixels from its header, before decoding it', async () => {
    const outcome = await call('recognizeSamples', ['huge-header']);
    expect((outcome as { value: OcrPage[] }).value).toEqual([{ ok: false, code: 'INPUT_TOO_LARGE' }]);
  }, 120_000);

  it('refuses a model file whose SHA-256 does not match', async () => {
    harness.tamperOcrAsset = 'rec.onnx';
    try {
      const fresh = await harness.open();
      const outcome = await fresh.evaluate(() => (window as unknown as {
        sandboxTest: { recognizeSamples(n: string[]): Promise<{ ok: boolean; code?: string }> } }).sandboxTest.recognizeSamples(['q33']));
      expect(outcome).toMatchObject({ ok: false, code: 'SANDBOX_UNAVAILABLE' });
      await fresh.close();
    } finally {
      harness.tamperOcrAsset = null;
    }
  }, 120_000);
});
