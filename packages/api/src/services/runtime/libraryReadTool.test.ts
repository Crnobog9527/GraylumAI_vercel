/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it, vi} from 'vitest';
import {libraryQuery, readLibrary} from './libraryReadTool';
import {libraryReferences} from './runtimeContext';
import {sourceToolBytes} from './sourceRuntimeTool';

const doc = '00000000-0000-4000-8000-000000000001';
const execution = '00000000-0000-4000-8000-0000000000e1';
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

describe('library read execution', () => {
  const toolArgs = {p_execution_id: execution, p_call_id: 'c1', p_name: 'read_source', p_arguments: {query: 'doc-1'}};
  const segment = {kind: 'library_segment', documentId: doc, version: 2, body: '原文'};

  it('reads through SQL once and freezes the persisted result', async () => {
    const ownerRpc = vi.fn(async (name: string) => name === 'runtime_library_read' ? segment : {result: {...segment, saved: true}});
    const text = await readLibrary({ownerRpc: ownerRpc as never, executionId: execution, query: 'doc-1/segment-1',
      saved: {result: null}, toolArgs});
    expect(ownerRpc).toHaveBeenNthCalledWith(1, 'runtime_library_read', {p_execution_id: execution, p_query: 'doc-1/segment-1'});
    expect(ownerRpc).toHaveBeenNthCalledWith(2, 'runtime_tool', {...toolArgs, p_action: 'complete', p_result: segment});
    expect(JSON.parse(text)).toEqual({...segment, saved: true});
  });

  it('replays a frozen read only while its document is live, never re-sending deleted text', async () => {
    const live = vi.fn(async () => true);
    expect(JSON.parse(await readLibrary({ownerRpc: live as never, executionId: execution, query: 'doc-1/segment-1',
      saved: {result: segment}, toolArgs}))).toEqual(segment);
    expect(live).toHaveBeenCalledWith('runtime_library_visible', {p_execution_id: execution, p_result: segment});
    const gone = vi.fn(async () => false);
    const replay = await readLibrary({ownerRpc: gone as never, executionId: execution, query: 'doc-1/segment-1',
      saved: {result: segment}, toolArgs});
    expect(JSON.parse(replay)).toEqual({kind: 'unavailable', reason: 'source_deleted'});
    expect(replay).not.toContain('原文');
  });

  it('checks a frozen search result before replay so a deleted document excerpt is never sent again', async () => {
    const search = {kind: 'library_search', terms: ['苹果派'], hits: [{ref: 'doc-1', documentId: doc, version: 2,
      title: 'PRIVATE_NAME.md', excerpt: '苹果派的做法 SEARCH_EXCERPT'}]};
    const live = vi.fn(async () => true);
    expect(JSON.parse(await readLibrary({ownerRpc: live as never, executionId: execution, query: 'search:苹果派',
      saved: {result: search}, toolArgs}))).toEqual(search);
    expect(live).toHaveBeenCalledWith('runtime_library_visible', {p_execution_id: execution, p_result: search});
    const gone = vi.fn(async () => false);
    const replay = await readLibrary({ownerRpc: gone as never, executionId: execution, query: 'search:苹果派',
      saved: {result: search}, toolArgs});
    expect(JSON.parse(replay)).toEqual({kind: 'unavailable', reason: 'source_deleted'});
    expect(replay).not.toContain('SEARCH_EXCERPT');
    expect(replay).not.toContain('PRIVATE_NAME');
  });

  it('checks a frozen index before replay so a deleted filename is never sent again', async () => {
    const index = {kind: 'library_index', documents: [{documentId: doc, title: 'PRIVATE_NAME.md', version: 2}]};
    for (const visible of [true, false]) {
      const ownerRpc = vi.fn(async () => visible);
      const result = await readLibrary({ownerRpc: ownerRpc as never, executionId: execution, query: '',
        saved: {result: index}, toolArgs});
      expect(ownerRpc).toHaveBeenCalledWith('runtime_library_visible', {p_execution_id: execution, p_result: index});
      expect(JSON.parse(result)).toEqual(visible ? index : {kind: 'unavailable', reason: 'source_deleted'});
    }
  });

  it('replays a frozen refusal as it was, without a database read', async () => {
    const ownerRpc = vi.fn();
    const refusal = {kind: 'unavailable', reason: 'read_limit'};
    expect(JSON.parse(await readLibrary({ownerRpc: ownerRpc as never, executionId: execution, query: '',
      saved: {result: refusal}, toolArgs}))).toEqual(refusal);
    expect(ownerRpc).not.toHaveBeenCalled();
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

