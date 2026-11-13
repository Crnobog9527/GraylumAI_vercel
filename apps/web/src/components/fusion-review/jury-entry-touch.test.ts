/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// MOBILE-UX (#1938 follow-up): the links under a row of the jury chooser (「继续修订」「查看上次评审」) were 28px high on the phone.
it('the links under a jury chooser row are at least 44px high at the phone width (639px and below)', () => {
  const css = readFileSync(fileURLToPath(new URL('./jury-entry.module.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const phone = [...css.matchAll(/@media\s*\(\s*max-width:\s*639px\s*\)\s*\{([\s\S]*?\})\s*\}/g)].map(match => match[1]).join('\n');
  const rule = /\.chooserList\s+\.link\s*\{([^}]*)\}/.exec(phone)?.[1] ?? '';
  const height = Number(/min-height:\s*(\d+)px/.exec(rule)?.[1] ?? 0);
  expect(height).toBeGreaterThanOrEqual(44);
});
