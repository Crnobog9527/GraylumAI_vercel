/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// The signed-in product's phone width is 639px and below since the phone shell (Owner 2026-11-12, mobile plan A); the compare
// card had its own 700px. One width everywhere: between 640 and 700px a page must not be half phone, half desktop.
it('the compare card turns into one column with tabs at the same phone width as the shell (639px and below)', () => {
  const css = readFileSync(fileURLToPath(new URL('./compare.module.css', import.meta.url)), 'utf8');
  const widths = [...css.matchAll(/@media\s*\(\s*max-width:\s*(\d+)px\s*\)/g)].map(match => match[1]);
  expect(widths).toEqual(['639']);
  expect(css).toMatch(/@media\(max-width:639px\)\{\s*\.tabs\{display:flex/);
});
