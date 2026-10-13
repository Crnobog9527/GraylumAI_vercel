import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoWorkspace } from './DemoWorkspace';

const SRC = resolve(__dirname, '../../..');
const BANNED = [/@\/trpc\b/, /@supabase\//, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/];

function resolveLocal(from: string, spec: string) {
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

/** Every local source file the demo pulls in (type-only imports included, which is stricter than needed). */
function importGraph(entry: string) {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const next = resolveLocal(file, match[1]);
      if (next) queue.push(next);
    }
  }
  return [...seen];
}

afterEach(() => vi.restoreAllMocks());

describe('landing demo isolation', () => {
  it('pulls in no API client, Supabase or network call anywhere in its import graph', () => {
    const files = importGraph(join(__dirname, 'LazyDemo.tsx'));
    expect(files.some(file => file.endsWith('DemoWorkspace.tsx'))).toBe(true);
    expect(files.some(file => file.endsWith('question-card.tsx'))).toBe(true);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of BANNED) expect({ file, hit: pattern.test(source) }).toEqual({ file, hit: false });
    }
  });

  it('renders the real conversation components without any request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const html = renderToStaticMarkup(createElement(DemoWorkspace));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(html).toContain('data-question-card="open"');
    expect(html).toContain('aria-label="定位清单"');
    expect(html).toContain('示例');
  });
});
