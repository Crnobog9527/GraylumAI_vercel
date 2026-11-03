/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {libraryQuery} from './libraryReadTool';
import {libraryReferences} from '../agent/runtimeContext';
import {sourceToolBytes} from './sourceRuntimeTool';

const doc = '00000000-0000-4000-8000-000000000001';
const withRefs = (extra: Record<string, unknown> = {}) =>
  ({libraryReferences: [{documentId: doc, version: 2}], ...extra}) as never;

describe('library read routing', () => {
  it('reads library documents only for an execution that froze references', () => {
    expect(libraryQuery({query: 'doc-1'}, {} as never)).toBeNull();
    expect(libraryQuery({query: 'doc-1'}, withRefs())).toBe('doc-1');
    expect(libraryQuery({query: ' doc-2/segment-3 '}, withRefs())).toBe('doc-2/segment-3');
    expect(libraryQuery({query: 'library'}, withRefs())).toBe('');
    expect(libraryQuery({}, withRefs())).toBe('');
  });

  it('leaves workspace and selected-source reads alone', () => {
    expect(libraryQuery({}, withRefs({workspaceContext: true}))).toBeNull();
    expect(libraryQuery({query: 'positioning:abc'}, withRefs({workspaceContext: true}))).toBeNull();
    expect(libraryQuery({query: 'doc-1'}, withRefs({workspaceContext: true}))).toBe('doc-1');
    expect(libraryQuery({}, withRefs({sources: [{}]}))).toBeNull();
    expect(libraryQuery({query: 'doc-1', path: '/etc'}, withRefs())).toBeNull();
  });

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
});

describe('library search routing (CHAT-AUTO-CONTEXT)', () => {
  const retrieval = (extra: Record<string, unknown> = {}) => ({libraryRetrieval: true, ...extra}) as never;
  it('routes search: and doc-N for an execution that froze retrieval, even without @ references', () => {
    expect(libraryQuery({query: 'search:定位 选题'}, retrieval())).toBe('search:定位 选题');
    expect(libraryQuery({query: ' search: banana '}, retrieval())).toBe('search: banana');
    expect(libraryQuery({query: 'doc-7/segment-2'}, retrieval())).toBe('doc-7/segment-2');
    expect(libraryQuery({query: 'library'}, retrieval())).toBe('');
    expect(libraryQuery({query: 'search:x', path: '/etc'}, retrieval())).toBeNull();
  });
  it('never routes search: without retrieval, and leaves workspace reads alone', () => {
    expect(libraryQuery({query: 'search:定位'}, {} as never)).toBeNull();
    expect(libraryQuery({query: 'search:定位'}, withRefs())).toBeNull();
    expect(libraryQuery({query: 'positioning:abc'}, retrieval({workspaceContext: true}))).toBeNull();
    expect(libraryQuery({}, retrieval({workspaceContext: true}))).toBeNull();
  });
  it('describes the search usage only for retrieval and sizes the same text', () => {
    expect(sourceToolBytes(['read_source'], false, false, true)).toBeGreaterThan(sourceToolBytes(['read_source'], false, true));
    expect(sourceToolBytes(['read_source'], false, false, false)).toBe(sourceToolBytes(['read_source'], false));
  });
});

