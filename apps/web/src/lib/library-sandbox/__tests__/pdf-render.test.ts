/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
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
