/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it, vi} from 'vitest';
import type {Session} from '@openai/agents';
import {runRuntime} from './runner';

const session = (): Session => ({getSessionId: async () => 'synthetic', getItems: async () => [], addItems: async () => {},
  popItem: async () => undefined, clearSession: async () => {}});
const call = (id: string, query: string) => ({id, type: 'function', function: {name: 'read_source', arguments: JSON.stringify({query})}});
const response = (message: object, finish_reason = 'stop') => JSON.stringify({id: 'local', object: 'chat.completion', created: 1,
  model: 'test/model', choices: [{index: 0, finish_reason, message: {role: 'assistant', ...message}}]});

/** The model asks for two searches in one response, then (if it may) for another one, then answers. */
function harness(options: {libraryRetrieval?: boolean; maxToolCalls?: number}) {
  const bodies: Array<{tools?: unknown[]}> = [];
  const executed: string[] = [];
  const exchange = vi.fn(async (sequence: number, body: string) => {
    bodies.push(JSON.parse(body));
    if (sequence === 1) return response({content: null, tool_calls: [call('c1', 'search:a'), call('c2', 'search:b')]}, 'tool_calls');
    if (sequence === 2) return response({content: null, tool_calls: [call('c3', 'search:c')]}, 'tool_calls');
    return response({content: 'final answer'});
  });
  const run = () => runRuntime({model: 'test/model', instructions: 'Answer', input: 'hello', session: session(), maxOutputTokens: 1000,
    maxTurns: 4, selectHistory: async (_h, i) => i, exchange, ...options,
    tools: [{name: 'read_source', description: 'read', execute: async (arguments_) => {
      executed.push(String(arguments_.query));return '{"kind":"library_search","hits":[]}';
    }}]});
  return {bodies, executed, exchange, run};
}

describe('library retrieval turns (CHAT-AUTO-CONTEXT)', () => {
  it('keeps only the first of several parallel calls and stops offering tools after the last allowed call', async () => {
    const h = harness({libraryRetrieval: true, maxToolCalls: 2});
    // Call 1 (search:a) runs; the second response asks for search:c, which is the last allowed call; the third request has no tool.
    await expect(h.run()).resolves.toBe('final answer');
    expect(h.executed).toEqual(['search:a', 'search:c']);
    expect(h.bodies).toHaveLength(3);
    expect(h.bodies[0]!.tools).toHaveLength(1);
    expect(h.bodies[1]!.tools).toHaveLength(1);
    expect(h.bodies[2]!.tools ?? []).toEqual([]);
    expect(JSON.stringify(h.bodies[2])).not.toContain('tool_choice');
  });

  it('without the retrieval marker nothing changes: a parallel batch is refused and tools stay offered', async () => {
    const h = harness({maxToolCalls: 2});
    await expect(h.run()).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
    expect(h.executed).toEqual([]);
  });
});

describe('executions admitted with the sourceCalls marker', () => {
  it('execute only the first of several parallel calls, even without the retrieval marker', async () => {
    const h = harness({sourceCalls: 'first-call-v1', maxToolCalls: 2} as never);
    await expect(h.run()).resolves.toBe('final answer');
    expect(h.executed[0]).toBe('search:a');
    expect(h.executed).not.toContain('search:b');
  });
  it('an execution without the marker keeps its old rule even when it carries a frozen request format', async () => {
    const h = harness({providerRequestFormat: 'serial-tools-v6-reasoning', maxToolCalls: 2} as never);
    await expect(h.run()).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
    expect(h.executed).toEqual([]);
  });
});

describe('free chat research replies (CHAT-AUTO-CONTEXT C)', () => {
  it('one call per response, and no tool on the request after the last allowed call, without the retrieval marker', async () => {
    const h = harness({sourceCalls: 'first-call-v1', research: {freeChat: 'free-chat-v1'}, maxToolCalls: 2} as never);
    await expect(h.run()).resolves.toBe('final answer');
    expect(h.executed).toEqual(['search:a', 'search:c']);
    expect(h.bodies[2]!.tools ?? []).toEqual([]);
  });
});
