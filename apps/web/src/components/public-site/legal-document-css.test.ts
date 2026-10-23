/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The legal HTML carries literal class names. A CSS module renames plain classes, so every class the documents use must
// be written as :global(...) in the stylesheet, or its rule (for example the table's scroll container) never applies.
describe('legal document stylesheet', () => {
  const directory = path.join(process.cwd(), 'content/legal');
  const css = readFileSync(path.join(process.cwd(), 'src/components/public-site/legal-document.module.css'), 'utf8');
  const classes = new Set<string>();
  for (const file of readdirSync(directory).filter(name => name.endsWith('.html'))) {
    for (const match of readFileSync(path.join(directory, file), 'utf8').matchAll(/class="([^"]+)"/g)) {
      match[1].split(/\s+/).forEach(name => classes.add(name));
    }
  }

  it('uses classes in the documents', () => {
    expect(classes.has('table-wrap')).toBe(true);
  });

  it.each([...classes])('styles the document class %s as a global class', name => {
    expect(css).toContain(`:global(.${name})`);
    expect(css).not.toMatch(new RegExp(`\\.doc \\.${name}\\b`));
  });
});
