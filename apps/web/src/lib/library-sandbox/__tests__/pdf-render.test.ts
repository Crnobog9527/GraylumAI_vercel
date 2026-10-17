/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPdfPagesInBrowser } from '../pdf/render-client';
import { packRenderInput, unpackRenderInput } from '../pdf/render-pack';

describe('render Worker input', () => {
  it('carries page numbers and the PDF bytes', () => {
    const packed = new Uint8Array(packRenderInput(new Uint8Array([37, 80, 68, 70]), [2, 5]));
    const { pdf, pages } = unpackRenderInput(packed);
    expect(pages).toEqual([2, 5]);
    expect([...pdf]).toEqual([37, 80, 68, 70]);
  });
  it('refuses no pages, more than 8 pages, or a missing PDF', () => {
    expect(() => unpackRenderInput(new Uint8Array(packRenderInput(new Uint8Array([1]), [])))).toThrow('SANDBOX_PROTOCOL');
    expect(() => unpackRenderInput(new Uint8Array(packRenderInput(new Uint8Array([1]), [1, 2, 3, 4, 5, 6, 7, 8, 9])))).toThrow('SANDBOX_PROTOCOL');
    expect(() => unpackRenderInput(new Uint8Array(packRenderInput(new Uint8Array(0), [1])))).toThrow('SANDBOX_PROTOCOL');
  });
});

describe('renderPdfPagesInBrowser', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('refuses duplicate or out-of-range pages across the whole request, before any Worker runs', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_SCAN_RECOGNITION', 'true');
    const pdf = new Blob(['%PDF']);
    for (const pages of [[], [1, 2, 3, 4, 5, 6, 7, 8, 1], [0], [1.5], [501]]) {
      await expect(renderPdfPagesInBrowser(pdf, pages)).rejects.toThrow('SANDBOX_PROTOCOL');
    }
  });
});
