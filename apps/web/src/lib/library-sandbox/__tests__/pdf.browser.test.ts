/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB-2c acceptance in real Chromium (must-test 18): pdf.js runs inside the same network-less sandbox
// Worker as LIB-2b; hostile PDFs (script, actions, links, forms, attachments, XFA, external streams)
// cause no request; malformed and oversized files stop at a limit with a stable code and the page
// stays responsive; encrypted PDFs are refused; pages without a text layer are classified.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './browser-harness';
import type { Outcome } from './harness-entry';
import { classificationSamples, hostileSamples, oversizedPdf, slowPdf } from './pdf-samples';
import { workerProbe } from './sandbox-probes';

type PdfValue = { text: string; pageCount: number; pages: { status: string; imageCoverage: number }[] };
type Api = {
  extractPdfSample(name: string, options?: { timeoutMs?: number; abortAfterMs?: number }): Promise<Outcome<PdfValue>>;
  runWorker(source: string, timeoutMs: number): Promise<Outcome<Record<string, string>>>;
  frameCount(): number;
};
type Call = <K extends keyof Api>(name: K, ...args: Parameters<Api[K]>) => ReturnType<Api[K]>;

const MAX_PAGE_STALL_MS = 500;
let harness: Harness;
let page: Page;
const call: Call = ((name: keyof Api, ...args: unknown[]) => page.evaluate(
  ([method, params]) => {
    const api = (window as unknown as { sandboxTest: Record<string, (...a: unknown[]) => unknown> }).sandboxTest;
    return api[method as string](...(params as unknown[]));
  }, [name, args] as const)) as Call;

async function extract(name: string, bytes: Buffer, options?: { timeoutMs?: number; abortAfterMs?: number }) {
  harness.samples.set(name, bytes);
  const before = harness.outsideRequests.length;
  const outcome = await call('extractPdfSample', name, options);
  expect(outcome.maxGapMs, `${name} stalled the page`).toBeLessThan(MAX_PAGE_STALL_MS);
  expect(await call('frameCount')).toBe(0);
  return { outcome, requests: () => harness.outsideRequests.slice(before) };
}

beforeAll(async () => {
  harness = await startHarness();
  page = await harness.open();
}, 120_000);
afterAll(async () => { await harness?.close(); }, 30_000);

describe('PDF Worker bundle in the sandbox', () => {
  it('keeps every network, script-loading, eval and storage channel blocked after pdf.js has loaded', async () => {
    const before = harness.outsideRequests.length;
    // The probe runs after the whole bundle (pdf.js, its polyfills and our hardening) has initialised.
    const outcome = await call('runWorker', `${harness.pdfWorkerSource}\n;self.onmessage = null;\n${workerProbe(harness.outside)}`, 30_000);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const report = (outcome as { value: Record<string, string> }).value;
    for (const name of ['fetch', 'fetchNoCors', 'xhr', 'websocket', 'eventSource', 'importScripts', 'eval', 'newFunction',
      'nestedWorker', 'indexedDB', 'caches']) {
      expect(report[name], `${name}: ${JSON.stringify(report)}`).toMatch(/^blocked:/);
    }
    expect(report.locationAssign).not.toBe('NAVIGATED');
    await page.waitForTimeout(1_000);
    expect(harness.outsideRequests.slice(before)).toEqual([]);
    expect(harness.unexpected).toEqual([]);
  }, 60_000);

  it('runs pdf.js in-process with the stream guard armed and no inflater', async () => {
    const outcome = await call('runWorker', `${harness.pdfWorkerSource}\n;self.onmessage = null; postMessage({ ok: true, value: {
      decompressionStream: typeof DecompressionStream, guard: JSON.stringify(globalThis.__graylumPdfGuard),
      pdfjsWorker: typeof (globalThis.pdfjsWorker && globalThis.pdfjsWorker.WorkerMessageHandler) } });`, 30_000);
    expect(outcome).toMatchObject({ ok: true, value: {
      decompressionStream: 'undefined', guard: '{"maxStreamBytes":50000000,"hit":null}', pdfjsWorker: 'function' } });
  }, 30_000);

  it('extracts Chinese (predefined CMaps) and English text page by page with no request', async () => {
    const bytes = readFileSync(new URL('./pdf-quality/fixtures/20-raw-mixed-cmaps.pdf', import.meta.url));
    const { outcome, requests } = await extract('good:mixed', bytes);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const value = (outcome as { value: PdfValue }).value;
    expect(value.pageCount).toBe(2);
    expect(value.text.split('\f')).toHaveLength(2);
    expect(value.text).toContain('English and 中文 on one page');
    expect(value.pages.map((item) => item.status)).toEqual(['text', 'text']);
    await page.waitForTimeout(300);
    expect(requests()).toEqual([]);
  }, 60_000);
});

describe('pages without a text layer (LIB_DOCS_PLAN §4.2)', () => {
  it.each(classificationSamples().map((sample) => [sample.name, sample] as const))('%s', async (name, sample) => {
    const { outcome } = await extract(`class:${name}`, sample.bytes);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const value = (outcome as { value: PdfValue }).value;
    expect(value.pages.map((item) => item.status)).toEqual(sample.statuses);
    if (sample.text) expect(value.text).toMatch(sample.text);
    for (const [index, status] of sample.statuses.entries()) {
      if (status === 'scanned') expect(value.pages[index].imageCoverage).toBeGreaterThanOrEqual(0.5);
      if (status !== 'text') expect(value.text.split('\f')[index]).toBe('');
    }
  }, 60_000);
});

describe('must-test 18: hostile and malformed PDFs', () => {
  const samples = hostileSamples('OUTSIDE');
  it.each(samples.map((sample) => [sample.name, sample.expect] as const))('%s', async (name, expected) => {
    // Rebuild with the real outside address (the list above only provides names and expectations).
    const sample = hostileSamples(harness.outside).find((item) => item.name === name)!;
    const { outcome, requests } = await extract(`bad:${name}`, sample.bytes);
    if ('ok' in expected) {
      expect(outcome.ok, JSON.stringify(outcome).slice(0, 300)).toBe(true);
      if (expected.text) expect((outcome as { value: PdfValue }).value.text).toMatch(expected.text);
    } else if ('code' in expected) {
      expect(outcome).toMatchObject({ ok: false, code: expected.code });
    } else {
      expect(expected.settles).toContain(outcome.ok ? 'ok' : (outcome as { code: string }).code);
    }
    await page.waitForTimeout(200);
    expect(requests()).toEqual([]);
    expect(harness.unexpected).toEqual([]);
  }, 60_000);

  it.each([
    ['open password', 'encrypted-open-password.pdf', (text: string) => text],
    ['permissions password only', 'encrypted-permissions-only.pdf', (text: string) => text],
    // `/Encr#79pt` is the same name written with an escape: the byte check misses it, pdf.js does not.
    ['open password, escaped name', 'encrypted-open-password.pdf', (text: string) => text.replace('/Encrypt', '/Encr#79pt')],
    ['permissions only, escaped name', 'encrypted-permissions-only.pdf', (text: string) => text.replace('/Encrypt', '/Encr#79pt')],
  ])('refuses an encrypted PDF (%s)', async (_name, file, edit) => {
    const original = readFileSync(new URL(`./pdf-fixtures/${file}`, import.meta.url)).toString('latin1');
    const bytes = Buffer.from(edit(original), 'latin1');
    const { outcome } = await extract(`locked:${_name}`, bytes);
    expect(outcome).toMatchObject({ ok: false, code: 'PDF_ENCRYPTED' });
  }, 60_000);

  it('rejects empty and oversized files before starting the sandbox', async () => {
    expect((await extract('size:empty', Buffer.alloc(0))).outcome).toMatchObject({ ok: false, code: 'INPUT_EMPTY' });
    expect((await extract('size:big', oversizedPdf())).outcome).toMatchObject({ ok: false, code: 'INPUT_TOO_LARGE' });
  }, 60_000);

  it('terminates the Worker at the time limit without stalling the page', async () => {
    const closed: Promise<void>[] = [];
    page.on('worker', (worker) => closed.push(new Promise((resolve) => worker.on('close', () => resolve()))));
    const { outcome } = await extract('slow:pages', slowPdf(), { timeoutMs: 3_000 });
    expect(outcome).toMatchObject({ ok: false, code: 'SANDBOX_TIMEOUT' });
    expect(outcome.elapsedMs).toBeLessThan(5_000);
    expect(closed.length).toBeGreaterThan(0);
    await Promise.all(closed);
  }, 60_000);
});

describe('PDF worker bundle loading', () => {
  it('refuses a login redirect instead of running it', async () => {
    harness.samples.set('good:tiny-pdf', readFileSync(new URL('./pdf-quality/fixtures/14-raw-unicns-traditional.pdf', import.meta.url)));
    harness.workerResponse = 'login-redirect';
    const fresh = await harness.open();
    try {
      const outcome = await fresh.evaluate(() => (window as unknown as { sandboxTest: { extractPdfSample(n: string): Promise<unknown> } })
        .sandboxTest.extractPdfSample('good:tiny-pdf'));
      expect(outcome).toMatchObject({ ok: false, code: 'SANDBOX_UNAVAILABLE' });
    } finally {
      harness.workerResponse = 'script';
      await fresh.close();
    }
  }, 30_000);
});
