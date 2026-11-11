/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What every page downloads. The root document (components/layout/RootDocument.tsx) is rendered by every root layout, so every
 * module it reaches with a static import is in the JavaScript of every page: the public pages, the login page and the app.
 * A library that only some pages need must not be reachable from it. 2026-11-11: `lib/entry-language.ts` imported the reply
 * language list from a file that also built a zod schema, which put all of zod (107 KB, 34 KB compressed) on every page.
 *
 * The walk follows static imports only: `import type`, and `import()` (loaded on demand), do not count.
 */
const SRC = path.resolve(__dirname, '..');
const API_SRC = path.resolve(SRC, '../../../packages/api/src');
const ENTRY = path.join(SRC, 'components/layout/RootDocument.tsx');

/** Libraries only some pages need. Add a package here when it is taken out of the shared JavaScript. */
const NOT_ON_EVERY_PAGE = ['zod', 'recharts', 'react-markdown', 'remark-gfm', 'pdfjs-dist', 'mammoth', 'onnxruntime-web'];
const NOT_ON_EVERY_PAGE_PREFIXES = ['@tiptap/'];

const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveImport(from: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) return resolveFile(path.join(SRC, specifier.slice(2)));
  if (specifier.startsWith('@repo/api/src/')) return resolveFile(path.join(API_SRC, specifier.slice('@repo/api/src/'.length)));
  if (specifier.startsWith('.')) return resolveFile(path.resolve(path.dirname(from), specifier));
  return null;
}

const isClientModule = (source: string) => /^\s*(?:\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(source);

/**
 * Every package the browser gets from the entry by static imports, with one chain of files that reaches it. The entry is a
 * server component: its own imports run on the server, and the browser's part starts at each 'use client' file it reaches.
 */
function browserPackagesReachedFrom(entry: string): Map<string, string[]> {
  const packages = new Map<string, string[]>();
  const seen = new Set<string>();
  const queue: Array<{ file: string; client: boolean; chain: string[] }> = [{ file: entry, client: false, chain: [path.relative(SRC, entry)] }];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { file, chain } = next;
    if (!/\.tsx?$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    const client = next.client || isClientModule(source);
    const key = `${client ? 'client' : 'server'}:${file}`;
    if (seen.has(key) || seen.has(`client:${file}`)) continue;
    seen.add(key);
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1];
      const target = resolveImport(file, specifier);
      if (target) queue.push({ file: target, client, chain: [...chain, path.relative(SRC, target)] });
      else if (client && !specifier.startsWith('.') && !specifier.startsWith('@/') && !packages.has(specifier)) packages.set(specifier, chain);
    }
  }
  return packages;
}

describe('the JavaScript every page downloads', () => {
  const reached = browserPackagesReachedFrom(ENTRY);

  it('walks the root document far enough to be a real check', () => {
    // The walk found the app's shared providers: if these go missing the walk is broken, not the code clean.
    expect([...reached.keys()]).toEqual(expect.arrayContaining(['@tanstack/react-query', '@trpc/client', 'sonner']));
  });

  it('does not reach a library that only some pages need', () => {
    const offenders = [...reached].filter(([name]) =>
      NOT_ON_EVERY_PAGE.includes(name) || NOT_ON_EVERY_PAGE_PREFIXES.some(prefix => name.startsWith(prefix)));
    expect(offenders.map(([name, chain]) => `${name} via ${chain.join(' -> ')}`)).toEqual([]);
  });
});
