/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// 2026-11-11 (PERF measurement): the chart library (262 KB raw, about 100 KB gzip) was part of the data review page's
// first download because TrendCharts.tsx imported it and DataReviewView.tsx imported TrendCharts.tsx. It may be reached
// only through a dynamic import() now. This walks the page's static imports (this folder's files) and fails when
// recharts is reachable again without one.
const here = dirname(fileURLToPath(import.meta.url));
/** Static `import … from` and `export … from` targets; a dynamic import('…') is not one. */
const staticImports = (source: string) => [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)';/gms)].map(match => match[1]!);
const fileOf = (from: string, target: string) => ['.tsx', '.ts'].map(ext => resolve(dirname(from), target + ext)).find(existsSync);

function reachable(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const imports = staticImports(readFileSync(file, 'utf8'));
    seen.set(file, imports);
    for (const target of imports) {
      const next = target.startsWith('.') ? fileOf(file, target) : undefined;
      if (next) queue.push(next);
    }
  }
  return seen;
}

it('the data review page reaches the chart library only through a dynamic import', () => {
  const graph = reachable(join(here, 'DataReviewView.tsx'));
  const withCharts = [...graph].filter(([, imports]) => imports.includes('recharts')).map(([file]) => file.replace(`${here}/`, ''));
  expect(withCharts).toEqual([]);
  // The walk really followed the page into the trend tab, and the drawing file is where the library lives.
  expect([...graph.keys()].map(file => file.replace(`${here}/`, ''))).toEqual(expect.arrayContaining(['TrendCharts.tsx', 'TrendChart.tsx']));
  expect(graph.has(join(here, 'TrendPlot.tsx'))).toBe(false);
  expect(staticImports(readFileSync(join(here, 'TrendPlot.tsx'), 'utf8'))).toContain('recharts');
  expect(readFileSync(join(here, 'TrendChart.tsx'), 'utf8')).toMatch(/import\('\.\/TrendPlot'\)/);
});
