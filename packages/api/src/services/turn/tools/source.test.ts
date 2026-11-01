/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { libraryTurnReader } from './source';
import { turnTools, TOOL_UNAVAILABLE } from './index';
import { ledger } from './__tests__/fixtures';
import type { ToolPlan } from './types';

const doc = (n: number) => ({ documentId: `00000000-0000-4000-8000-00000000000${n}`, version: 1, title: `file ${n}` });

describe('read_source: one read-only query per call, no row (Owner 10-28, ENGINEERING section 5 supplement)', () => {
  it('numbers the documents of this turn and passes the known references back; database ids never reach the model', async () => {
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ error: null,
      data: String(args.p_query).startsWith('doc-') ? { kind: 'library_directory', ref: 'doc-2', entries: [] }
        : { kind: 'library_search', hits: [doc(1), doc(2), doc(1)] } }));
    const read = libraryTurnReader({ rpc } as never, 'actor', 'session');
    const first = JSON.parse((await read('search:coffee')).text);
    expect(first.hits.map((h: { ref: string }) => h.ref)).toEqual(['doc-1', 'doc-2', 'doc-1']);
    expect(JSON.stringify(first)).not.toContain('00000000-0000-4000');
    await read('doc-2');
    expect(rpc).toHaveBeenLastCalledWith('library_turn_read', { p_actor_id: 'actor', p_session_id: 'session', p_query: 'doc-2',
      p_refs: [1, 2].map(n => ({ ref: `doc-${n}`, documentId: doc(n).documentId, version: 1 })) });
  });

  it('writes no turn_calls row, counts against the turn limit, and a failed read only tells the model', async () => {
    const h = ledger();
    const plan: ToolPlan = { offered: ['read_source'], available: ['read_source'], trimmed: [], paidToolUpperUsd: [],
      limits: { paidTools: 0, freeTools: 2 }, subcalls: 0, note: null, reserveBytes: 0 };
    let n = 0;
    const tools = turnTools({ plan, calls: h.deps, research: null, suppliers: { slots: { take: async () => 1, drop: async () => 1 } },
      readSource: async () => { if (++n === 2) throw new Error('db'); return { text: '{"kind":"library_index"}' }; } });
    const tool = tools.tools[0]!;
    expect(await tool.execute({ query: 'library' }, 'c1')).toBe('{"kind":"library_index"}');
    expect(JSON.parse(await tool.execute({ query: 'x' }, 'c2'))).toMatchObject({ kind: 'unavailable', reason: 'read_failed' });
    expect(tool.enabled?.()).toBe(false);
    expect(await tool.execute({ query: 'library' }, 'c3')).toBe(TOOL_UNAVAILABLE);
    expect(h.writes).toEqual([]);
    expect(tools.summary().freeCalls).toBe(2);
  });

  it('numbers the documents the user attached first, so doc-1 reads the first of them (V2-10)', async () => {
    const rpc = vi.fn(async () => ({ data: {}, error: null }));
    const read = libraryTurnReader({ rpc } as never, 'actor', 'session', [{ documentId: 'first', version: 2 }, { documentId: 'second', version: 1 }]);
    await read('doc-1');
    expect(rpc).toHaveBeenCalledWith('library_turn_read', expect.objectContaining({ p_query: 'doc-1',
      p_refs: [{ ref: 'doc-1', documentId: 'first', version: 2 }, { ref: 'doc-2', documentId: 'second', version: 1 }] }));
  });
});
