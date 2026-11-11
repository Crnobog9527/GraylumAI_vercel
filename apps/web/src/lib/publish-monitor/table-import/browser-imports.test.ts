/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANUAL_METRICS, MAX_METRIC_VALUE, MAX_ROWS_PER_CALL } from '@repo/api/src/shared/publishMonitorManual';
import * as server from '@repo/api/src/services/publishMonitor/manualImport';

// 2026-11-11 (PERF measurement): the data review page downloaded zod (107 KB raw, 31 KB gzip) because the table import
// read one number, MAX_ROWS_PER_CALL, from the server's import service. The browser files below may take values only
// from modules that import nothing from a package; the server's service may be used for types alone.
const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '../../..');
const api = resolve(web, '../../../packages/api/src');
const read = (path: string) => readFileSync(path, 'utf8');
/** `import … from 'x'` statements that are not `import type`, with the module they name. */
const valueImports = (source: string) => [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)';/gms)].map(match => match[1]!);
const anyImports = (source: string) => [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)';/gms)].map(match => match[1]!);

describe('the table import does not pull the server import service into the page', () => {
  it.each([
    ['components/publish-monitor/ManualImport.tsx'],
    ['lib/publish-monitor/table-import/mapping.ts'],
  ])('%s takes no value from services/publishMonitor/manualImport', file => {
    expect(valueImports(read(join(web, file)))).not.toContain('@repo/api/src/services/publishMonitor/manualImport');
  });

  it('the modules the browser does take values from import nothing at all', () => {
    for (const file of ['shared/publishMonitorManual.ts', 'services/publishMonitor/postForMe/http.ts']) {
      expect(anyImports(read(join(api, file))), file).toEqual([]);
    }
  });

  it('the server still enforces the same limits (one definition, re-exported)', () => {
    expect(server.MAX_ROWS_PER_CALL).toBe(MAX_ROWS_PER_CALL);
    expect(server.MAX_METRIC_VALUE).toBe(MAX_METRIC_VALUE);
    expect(server.MANUAL_METRICS).toBe(MANUAL_METRICS);
    const row = { postKey: 'p', url: null, postedAt: null, titleExcerpt: null, metrics: { views: 1 } };
    const rows = (count: number) => ({ accountProjectId: '00000000-0000-4000-8000-000000000001', origin: 'table' as const,
      rows: Array.from({ length: count }, () => row) });
    expect(server.manualImportInput.safeParse(rows(MAX_ROWS_PER_CALL)).success).toBe(true);
    expect(server.manualImportInput.safeParse(rows(MAX_ROWS_PER_CALL + 1)).success).toBe(false);
    expect(server.manualRow.safeParse({ ...row, metrics: { views: MAX_METRIC_VALUE * 10 } }).success).toBe(false);
  });
});
