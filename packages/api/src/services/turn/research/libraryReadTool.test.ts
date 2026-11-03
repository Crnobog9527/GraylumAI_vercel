/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {libraryReferences} from '../agent/runtimeContext';
import {sourceToolBytes} from './sourceRuntimeTool';

const doc = '00000000-0000-4000-8000-000000000001';

describe('library references and tool sizing', () => {
  it('accepts one to five distinct references with a positive version, and nothing else', () => {
    expect(libraryReferences.safeParse([{documentId: doc, version: 1}]).success).toBe(true);
    for (const bad of [[], [{documentId: doc, version: 0}], [{documentId: 'x', version: 1}],
      [{documentId: doc, version: 1, filename: 'a.md'}], [{documentId: doc, version: 1}, {documentId: doc.toUpperCase(), version: 1}],
      Array.from({length: 6}, (_, i) => ({documentId: doc.slice(0, -1) + i, version: 1}))])
      expect(libraryReferences.safeParse(bad).success).toBe(false);
  });

  it('describes the library queries only when references are frozen, and sizes the same text', () => {
    expect(sourceToolBytes(['read_source'], false, true)).toBeGreaterThan(sourceToolBytes(['read_source'], false));
    expect(sourceToolBytes(['search'], false, true)).toBe(sourceToolBytes(['search'], false));
  });

  it('describes the search usage only for retrieval and sizes the same text', () => {
    expect(sourceToolBytes(['read_source'], false, false, true)).toBeGreaterThan(sourceToolBytes(['read_source'], false, true));
    expect(sourceToolBytes(['read_source'], false, false, false)).toBe(sourceToolBytes(['read_source'], false));
  });
});
