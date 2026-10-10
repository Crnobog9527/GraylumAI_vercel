/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB-2b acceptance in real Chromium: the sandbox has no network, storage or navigation reach;
// hostile workers are stopped; must-test 8 (#549 malicious samples) is rejected in the browser path
// without freezing the page; and a normal Word file is extracted end to end.
import type { Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './browser-harness';
import type { Outcome } from './harness-entry';
import { buildDocx, footnoteRef, hyperlink, para, picture, run, table, TINY_PNG } from './docx-fixture';
import { maliciousSamples } from './malicious-samples';
import {
  FAKE_CODE_WORKER, frameProbe, GARBAGE_WORKER, HANG_WORKER, selfNavigationProbe, THROWING_WORKER, workerProbe,
} from './sandbox-probes';

type Api = {
  extractSample(name: string): Promise<Outcome<{ text: string; headings: { level: number; text: string }[];
    images: { contentType: string; byteLength: number; base64: string }[]; imageCount: number }>>;
  runWorker(source: string, timeoutMs: number): Promise<Outcome<Record<string, string>>>;
  runRelay(script: string, timeoutMs: number): Promise<Outcome<Record<string, string>>>;
  frameCount(): number;
};
type Call = <K extends keyof Api>(name: K, ...args: Parameters<Api[K]>) => ReturnType<Api[K]>;

/** Longest acceptable main-thread stall while a file is being parsed in the sandbox. */
const MAX_PAGE_STALL_MS = 500;

let harness: Harness;
let page: Page;
const call: Call = ((name: keyof Api, ...args: unknown[]) => page.evaluate(
  ([method, params]) => {
    const api = (window as unknown as { sandboxTest: Record<string, (...a: unknown[]) => unknown> }).sandboxTest;
    return api[method as string](...(params as unknown[]));
  }, [name, args] as const)) as Call;

beforeAll(async () => {
  harness = await startHarness();
  page = await harness.open();
}, 120_000);
afterAll(async () => { await harness?.close(); }, 30_000);

describe('sandbox isolation (Chromium)', () => {
  it('blocks every network, script-loading, eval and storage channel inside the parser Worker', async () => {
    const before = harness.outsideRequests.length;
    const outcome = await call('runWorker', workerProbe(harness.outside), 30_000);
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

  it('blocks requests, loads, forms, popups, top navigation, cookies and storage from the frame document', async () => {
    const before = harness.outsideRequests.length;
    const outcome = await call('runRelay', frameProbe(harness.outside), 30_000);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const report = (outcome as { value: Record<string, string> }).value;
    for (const name of ['fetch', 'fetchNoCors', 'xhr', 'websocket', 'eventSource']) {
      expect(report[name], `${name}: ${JSON.stringify(report)}`).toMatch(/^blocked:/);
    }
    for (const name of ['cookie', 'localStorage', 'parentDocument']) expect(report[name]).toMatch(/^threw:/);
    expect(report.origin).toBe('null');
    expect(report.popupHandle ?? 'null').toBe('null');
    await page.waitForTimeout(1_500);
    expect(harness.outsideRequests.slice(before)).toEqual([]);
    expect(harness.unexpected).toEqual([]);
    expect(page.url()).toBe(`${harness.origin}/`);
    expect(await call('frameCount')).toBe(0);
  }, 60_000);

  it('fails safely when a frame navigates itself', async () => {
    // Browsers cannot stop a sandboxed frame from navigating itself. Only the fixed, hash-pinned relay
    // runs there (it never navigates) and the parser Worker has no handle on the frame. If the frame
    // navigates anyway, the page discards the run; bytes only ever travel over the relay's own port.
    const late = await call('runRelay', selfNavigationProbe(harness.outside, false), 10_000);
    expect(late).toMatchObject({ ok: false, code: 'SANDBOX_NAVIGATED' });
    const early = await call('runRelay', selfNavigationProbe(harness.outside, true), 2_000);
    expect(early).toMatchObject({ ok: false, code: 'SANDBOX_TIMEOUT' });
    expect(await call('frameCount')).toBe(0);
  }, 30_000);

  it('terminates a CPU-bound worker on timeout without stalling the page', async () => {
    const closed: Promise<void>[] = [];
    page.on('worker', (worker) => closed.push(new Promise((resolve) => worker.on('close', () => resolve()))));
    const outcome = await call('runWorker', HANG_WORKER, 1_000);
    expect(outcome).toMatchObject({ ok: false, code: 'SANDBOX_TIMEOUT' });
    expect(outcome.elapsedMs).toBeLessThan(3_000);
    expect(outcome.maxGapMs).toBeLessThan(MAX_PAGE_STALL_MS);
    expect(await call('frameCount')).toBe(0);
    expect(closed.length).toBeGreaterThan(0);
    await Promise.all(closed);
  }, 30_000);

  it.each([
    ['malformed reply', GARBAGE_WORKER, 'SANDBOX_PROTOCOL'],
    ['unknown error code', FAKE_CODE_WORKER, 'SANDBOX_PROTOCOL'],
    ['worker crash', THROWING_WORKER, 'WORKER_FAILED'],
  ])('rejects a %s with a stable code', async (_name, source, code) => {
    expect(await call('runWorker', source, 10_000)).toMatchObject({ ok: false, code });
    expect(await call('frameCount')).toBe(0);
  }, 30_000);
});

describe('must-test 8 in the browser: #549 malicious samples', () => {
  const samples = maliciousSamples();
  beforeAll(() => {
    for (const sample of samples) harness.samples.set(`bad:${sample.name}`, sample.bytes);
  });

  it.each(samples.map((sample) => [sample.name, sample.code] as const))('%s → %s, page stays responsive', async (name, code) => {
    const before = harness.outsideRequests.length;
    const outcome = await call('extractSample', `bad:${name}`);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: false, code });
    expect(outcome.maxGapMs).toBeLessThan(MAX_PAGE_STALL_MS);
    expect(await call('frameCount')).toBe(0);
    expect(harness.outsideRequests.slice(before)).toEqual([]);
  }, 60_000);
});

describe('worker bundle loading', () => {
  it.each(['login-redirect', 'html'] as const)('refuses a %s answer instead of running it', async (mode) => {
    harness.samples.set('good:tiny', buildDocx({ body: para('x') }));
    harness.workerResponse = mode;
    const fresh = await harness.open();
    try {
      const outcome = await fresh.evaluate(() => (window as unknown as { sandboxTest: { extractSample(n: string): Promise<unknown> } })
        .sandboxTest.extractSample('good:tiny'));
      expect(outcome).toMatchObject({ ok: false, code: 'SANDBOX_UNAVAILABLE' });
    } finally {
      harness.workerResponse = 'script';
      await fresh.close();
    }
  }, 30_000);
});

describe('normal Word file through the production bundle', () => {
  it('extracts text, headings, table, header, footer, footnote and image bytes; follows no link', async () => {
    const body = [
      para('季度复盘 Quarterly Review', 'Title'),
      para('一、数据', 'Heading1'),
      `<w:p>${run('播放量增长')}${footnoteRef(1)}${run('，详见 ')}${hyperlink(1, '报表链接')}</w:p>`,
      table([['平台', '粉丝'], ['小红书', '1.2万']]),
      `<w:p>${picture(1)}</w:p>`,
      para('Next steps', 'Heading2'),
    ].join('');
    harness.samples.set('good:review', buildDocx({
      body, header: '内部资料', footer: 'Page 1', footnotes: ['数据来自后台'], images: [TINY_PNG],
      hyperlinks: [`${harness.outside}/clicked-link`],
    }));
    const before = harness.outsideRequests.length;
    const outcome = await call('extractSample', 'good:review');
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const value = (outcome as Extract<typeof outcome, { ok: true }>).value;
    expect(value.text).toBe('内部资料\n季度复盘 Quarterly Review\n一、数据\n播放量增长[1]，详见 报表链接\n平台\t粉丝\n小红书\t1.2万\n'
      + 'Next steps\n[1] 数据来自后台\nPage 1');
    expect(value.headings.map((heading) => [heading.level, heading.text]))
      .toEqual([[1, '季度复盘 Quarterly Review'], [1, '一、数据'], [2, 'Next steps']]);
    expect(value.images).toEqual([expect.objectContaining({ contentType: 'image/png', base64: TINY_PNG.toString('base64') })]);
    expect(outcome.maxGapMs).toBeLessThan(MAX_PAGE_STALL_MS);
    await page.waitForTimeout(500);
    expect(harness.outsideRequests.slice(before)).toEqual([]);
  }, 60_000);
});
