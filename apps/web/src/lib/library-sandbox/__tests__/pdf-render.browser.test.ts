/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB-2d acceptance in real Chromium: scanned PDF pages are rendered to JPEG in the PDF sandbox (no network,
// no WebAssembly) and recognised end to end; hostile PDFs settle without any outside request; a declared giant
// image is left out instead of exhausting memory; wrong page numbers are refused.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './browser-harness';
import type { Outcome } from './harness-entry';
import { buildPdf } from './pdf-fixture';
import { hostileSamples } from './pdf-samples';

const expected = JSON.parse(readFileSync(new URL('./ocr-fixtures/expected.json', import.meta.url), 'utf8')) as Record<string, string>;
const jpeg = (name: string) => readFileSync(new URL(`./ocr-fixtures/${name}.jpg`, import.meta.url));
/** JPEG width and height from its frame header (fixture images are baseline JPEGs). */
function size(bytes: Buffer): [number, number] {
  for (let i = 2; i < bytes.length;) {
    const marker = bytes[i + 1]!, length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
    i += 2 + length;
  }
  throw new Error('no frame header');
}

/** One A4 page per image, each page only the image (like a scanner's output). */
function scannedPdf(images: Buffer[], imageDict = (w: number, h: number) => `/Width ${w} /Height ${h}`): Buffer {
  const pages = images.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  const objects: Parameters<typeof buildPdf>[0] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages}] /Count ${images.length} >>`];
  images.forEach((image, i) => {
    const [w, h] = size(image), n = 3 + i * 3;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`,
      { dict: '', stream: 'q 595 0 0 842 0 0 cm /Im0 Do Q' },
      { dict: `/Type /XObject /Subtype /Image ${imageDict(w, h)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, stream: image });
  });
  return buildPdf(objects);
}

function accuracy(reference: string, text: string): number {
  const norm = (s: string) => [...s.normalize('NFKC').replace(/\s+/g, '')];
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
const call = <T>(method: string, ...args: unknown[]) => page.evaluate(([m, a]) =>
  (window as unknown as { sandboxTest: Record<string, (...x: unknown[]) => unknown> }).sandboxTest[m as string]!(...(a as unknown[])),
[method, args] as const) as Promise<Outcome<T>>;

beforeAll(async () => {
  harness = await startHarness();
  harness.samples.set('scan.pdf', scannedPdf([jpeg('q29'), jpeg('q12')]));
  // Declares 20,000 × 20,000 pixels (400 MP) with a tiny body: pdf.js must leave it out, not allocate it.
  harness.samples.set('giant.pdf', scannedPdf([jpeg('q33')], () => '/Width 20000 /Height 20000'));
  for (const sample of hostileSamples(harness.outside).slice(0, 3)) harness.samples.set(`hostile-${sample.name}`, sample.bytes);
  page = await harness.open();
}, 120_000);
afterAll(async () => { await harness?.close(); }, 30_000);

describe('scanned PDF pages (Chromium)', () => {
  it('renders pages to JPEG at 1,600 px on the long edge and under 600 KB', async () => {
    const outcome = await call<Array<{ ok: boolean; width?: number; height?: number; bytes?: number }>>('renderSample', 'scan.pdf', [1, 2]);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    for (const result of (outcome as { value: Array<{ ok: boolean; width: number; height: number; bytes: number }> }).value) {
      expect(result.ok).toBe(true);
      expect(Math.max(result.width, result.height)).toBe(1600);
      expect(result.bytes).toBeLessThanOrEqual(600_000);
    }
  }, 120_000);

  it('recognises rendered pages end to end at the evaluated accuracy', async () => {
    const outcome = await call<Array<{ page: number; ok: boolean; text?: string }>>('recognizePdfSample', 'scan.pdf', [1, 2]);
    expect(outcome.ok, JSON.stringify(outcome).slice(0, 500)).toBe(true);
    const [first, second] = (outcome as { value: Array<{ page: number; ok: boolean; text: string }> }).value;
    expect(accuracy(expected.q29!, first!.text)).toBeGreaterThanOrEqual(0.95);
    expect(accuracy(expected.q12!, second!.text)).toBeGreaterThanOrEqual(0.95);
    expect(harness.outsideRequests).toEqual([]);
  }, 180_000);

  it('leaves out a declared giant image instead of allocating it', async () => {
    const outcome = await call<Array<{ ok: boolean }>>('renderSample', 'giant.pdf', [1]);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  }, 120_000);

  it('settles hostile PDFs without any outside request and refuses wrong page numbers', async () => {
    for (const name of [...harness.samples.keys()].filter((key) => key.startsWith('hostile-'))) {
      const outcome = await call('renderSample', name, [1]);
      expect(outcome.maxGapMs, name).toBeLessThan(500);
    }
    expect(harness.outsideRequests).toEqual([]);
    expect(await call('renderSample', 'scan.pdf', [3])).toMatchObject({ ok: false, code: 'SANDBOX_PROTOCOL' });
    expect(await call('renderSample', 'scan.pdf', [1, 1])).toMatchObject({ ok: false, code: 'SANDBOX_PROTOCOL' });
  }, 180_000);
});
