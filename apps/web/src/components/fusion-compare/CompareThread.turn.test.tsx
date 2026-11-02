/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@/trpc/client', () => ({ trpc: { fusionCompare: { turnList: { useQuery: () => ({ data: state.data, isFetched: true, refetch: vi.fn() }) } } } }));
import { useCompareThread } from './CompareThread';

function Probe() {
  const thread = useCompareThread('s');
  return <p>{thread.cards.map(card => card.compareId).join(',')}|{JSON.stringify(thread.names)}|{String(thread.loaded)}</p>;
}

it('the conversation\'s compares are the turn-path list, oldest first, with their model names', () => {
  state.data = { cards: [{ compareId: 'b', state: 'finished', createdAt: '2026-11-02T10:00:00Z' },
    { compareId: 'a', state: 'finished', createdAt: '2026-11-02T09:00:00Z' }], names: { m0: 'Sonnet' } };
  expect(renderToStaticMarkup(<Probe />)).toContain('a,b|{&quot;m0&quot;:&quot;Sonnet&quot;}|true');
});

// CORE-PATH-V2 V2-12 B4: the page no longer calls the old compare procedures (they go with the old path in batch F).
it('no page or component calls the old fusionCompare procedures', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path); continue; }
      if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      if (/(trpc|client)\.fusionCompare\.(list|read|stop|stream|adopt|estimate|start)\b/.test(readFileSync(path, 'utf8'))) found.push(path.replace(root, ''));
    }
  };
  walk(root);
  expect(found).toEqual([]);
});
