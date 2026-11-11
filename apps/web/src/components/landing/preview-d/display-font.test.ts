/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';

const localFont = vi.hoisted(() => vi.fn(() => ({ variable: 'display-font', className: 'display-font' })));
vi.mock('next/font/local', () => ({ default: localFont }));

// 2026-11-11: with the default (preload on) the build wrote <link rel="preload" as="font"> for this face into the HTML of every
// page of the site, although only the unpublished samples D, G and H use it.
it('does not preload the samples-only heading face', async () => {
  await import('./display-font');
  expect(localFont).toHaveBeenCalledOnce();
  expect(localFont).toHaveBeenCalledWith(expect.objectContaining({ preload: false, display: 'swap', variable: '--d-display' }));
});
