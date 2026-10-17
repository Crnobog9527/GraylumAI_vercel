/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxError } from '../errors';
import { imageDimensions } from '../ocr/image-header';
import { libraryOcrAssets } from '../../../../scripts/library-ocr-assets.mjs';

const run = vi.hoisted(() => vi.fn());
vi.mock('../sandbox-host', () => ({ runSandboxedWorker: run }));
vi.mock('../worker-bundle', () => ({ loadWorkerBundle: async () => 'worker', withinDeadline: <T>(task: Promise<T>) => task }));

const webRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const page = (text: string) => ({ ok: true, text, confidence: 0.9, angle: 0, flipped: false, ms: 1 });

describe('image header', () => {
  it('reads JPEG, PNG and WebP sizes without decoding', () => {
    const jpeg = new Uint8Array(40);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, 0x13, 0x88, 0x0f, 0xa0, 3]);
    expect(imageDimensions(jpeg)).toEqual({ width: 4000, height: 5000 });
    const png = new Uint8Array(40);
    png.set([0x89, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0x07, 0xd0, 0, 0, 0x03, 0xe8]);
    expect(imageDimensions(png)).toEqual({ width: 2000, height: 1000 });
    const webp = new Uint8Array(40);
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)));
    webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
    webp.set([0x7f, 0x02, 0, 0xff, 0x01, 0], 24);
    expect(imageDimensions(webp)).toEqual({ width: 640, height: 512 });
    expect(() => imageDimensions(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toThrow('IMAGE_INVALID');
  });
});

describe('recognition client', () => {
  beforeEach(async () => {
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_SCAN_RECOGNITION', 'true');
    const files = await libraryOcrAssets(webRoot) as unknown as Record<string, Buffer>;
    vi.stubGlobal('fetch', async (url: string) => new Response(new Uint8Array(files[url.split('/').pop()!]!)));
    run.mockReset();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('retries a timed-out batch one image at a time and reports only the slow image', async () => {
    run.mockRejectedValueOnce(new SandboxError('SANDBOX_TIMEOUT'))
      .mockResolvedValueOnce({ pages: [page('a')] })
      .mockRejectedValueOnce(new SandboxError('SANDBOX_TIMEOUT'))
      .mockResolvedValueOnce({ pages: [page('c')] });
    const { recognizeImagesInBrowser } = await import('../ocr/client');
    const pages = await recognizeImagesInBrowser([new Blob(['1']), new Blob(['2']), new Blob(['3'])]);
    expect(pages).toEqual([page('a'), { ok: false, code: 'SANDBOX_TIMEOUT' }, page('c')]);
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls.slice(1).map(([options]) => options.timeoutMs)).toEqual([90_000, 90_000, 90_000]);
    expect(run.mock.calls[0]![0].allowWasm).toBe(true);
  });

  it('reports a lone image that times out as that page\'s result, including the last of a batch', async () => {
    run.mockResolvedValueOnce({ pages: Array.from({ length: 8 }, (_, i) => page(String(i))) })
      .mockRejectedValueOnce(new SandboxError('SANDBOX_TIMEOUT'));
    const { recognizeImagesInBrowser } = await import('../ocr/client');
    const seen: number[] = [];
    const pages = await recognizeImagesInBrowser(Array.from({ length: 9 }, (_, i) => new Blob([String(i)])),
      { onPage: (index) => seen.push(index) });
    expect(pages[8]).toEqual({ ok: false, code: 'SANDBOX_TIMEOUT' });
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not retry other failures', async () => {
    run.mockRejectedValueOnce(new SandboxError('SANDBOX_PROTOCOL'));
    const { recognizeImagesInBrowser } = await import('../ocr/client');
    await expect(recognizeImagesInBrowser([new Blob(['1']), new Blob(['2'])])).rejects.toThrow('SANDBOX_PROTOCOL');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
