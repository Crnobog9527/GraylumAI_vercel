/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it, vi} from 'vitest';
import type {Session} from '@openai/agents';
import {repairArguments, repairMessageToolCalls, newFrameRepairer} from './toolArgumentRepair';
import {runRuntime} from './runner';

describe('repairArguments', () => {
  it.each([
    ['{"query": }', '{"query": ""}'],
    ['{"query":}', '{"query":""}'],
    ['{"query": }  ', '{"query": ""}'],
  ])('puts back the empty string the stream dropped: %s', (raw, expected) => {
    expect(repairArguments(raw)).toBe(expected);
    expect(JSON.parse(repairArguments(raw))).toEqual({query: ''});
  });
  it.each(['{"query": "search:定位"}', '{}', '{"query": ""}'])('never touches arguments that already parse: %s', raw => {
    expect(repairArguments(raw)).toBe(raw);
  });
  it.each(['{"query": ', '{"query" "x"}', 'not json', '{"a": 1, }', '{"query": }}'])('leaves what it cannot fix alone: %s', raw => {
    expect(repairArguments(raw)).toBe(raw);
  });
});

describe('repairMessageToolCalls', () => {
  const call = (name: string, args: string) => ({id: 'c', type: 'function', function: {name, arguments: args}});
  it('repairs a read_source call and keeps the rest of the message', () => {
    const message = {role: 'assistant', content: null, tool_calls: [call('read_source', '{"query": }')]};
    const fixed = repairMessageToolCalls(message);
    expect(fixed.tool_calls![0]).toEqual(call('read_source', '{"query": ""}'));
    expect(fixed.role).toBe('assistant');
  });
  it('leaves other tools, good arguments and messages without calls as the very same object', () => {
    for (const message of [{tool_calls: [call('ask_question', '{"q": }')]}, {tool_calls: [call('read_source', '{"query":"x"}')]}, {content: 'hi'}])
      expect(repairMessageToolCalls(message)).toBe(message);
  });
});

describe('newFrameRepairer', () => {
  const frame = (calls: unknown) => JSON.stringify({id: 'g', choices: [{index: 0, delta: {tool_calls: calls}, finish_reason: null}]});
  const pieces = (...args: string[]) => args.map((a, i) => frame([{index: 0, ...(i === 0 ? {id: 'c', type: 'function'} : {}), function: i === 0 ? {name: 'read_source', arguments: a} : {arguments: a}}]));
  const assemble = (frames: string[]) => frames.map(f => JSON.parse(f).choices[0].delta.tool_calls?.[0]?.function?.arguments ?? '').join('');
  it('inserts the dropped empty string exactly where the frames lost it (the staging stream)', () => {
    const repair = newFrameRepairer();
    const out = pieces('', '', '{"query": ', '}').map(repair);
    expect(assemble(out)).toBe('{"query": ""}');
  });
  it('returns every other frame byte for byte', () => {
    const repair = newFrameRepairer();
    const frames = pieces('', '{"query": "search:定位"', '}');
    expect(frames.map(repair)).toEqual(frames);
    const plain = JSON.stringify({id: 'g', choices: [{index: 0, delta: {content: 'hi'}, finish_reason: null}]});
    expect(repair(plain)).toBe(plain);
    expect(repair('not json')).toBe('not json');
  });
  it('never inserts anything while the arguments are inside a string, however the provider splits the deltas', () => {
    const repair = newFrameRepairer();
    // The query value itself ends with a colon and the next delta starts with a closing brace: this is text, not a gap.
    const frames = pieces('', '{"query": "search:', '}x"}');
    expect(frames.map(repair)).toEqual(frames);
    expect(assemble(frames.map(newFrameRepairer()))).toBe('{"query": "search:}x"}');
    // An escaped quote does not end the string either.
    const escaped = pieces('', '{"query": "a\\":', '} b"}');
    const out = escaped.map(newFrameRepairer());
    expect(out).toEqual(escaped);
  });
  it('does not repair other tools and keeps calls apart by index', () => {
    const repair = newFrameRepairer();
    const other = [frame([{index: 0, id: 'c', function: {name: 'ask_question', arguments: '{"q": '}}]), frame([{index: 0, function: {arguments: '}'}}])];
    expect(other.map(repair)).toEqual(other);
    const two = newFrameRepairer();
    const mixed = [frame([{index: 0, id: 'a', function: {name: 'read_source', arguments: '{"query": "x"'}}]),
      frame([{index: 1, id: 'b', function: {name: 'read_source', arguments: '{"query": '}}]), frame([{index: 1, function: {arguments: '}'}}]),
      frame([{index: 0, function: {arguments: '}'}}])].map(two);
    expect(JSON.parse(mixed[2]!).choices[0].delta.tool_calls[0].function.arguments).toBe('""}');
    expect(mixed[3]).toBe(frame([{index: 0, function: {arguments: '}'}}]));
  });
});

describe('a read_source call with the dropped empty string runs the tool', () => {
  const session = (): Session => ({getSessionId: async () => 's', getItems: async () => [], addItems: async () => {}, popItem: async () => undefined, clearSession: async () => {}});
  const response = (message: object, finish_reason: string) => JSON.stringify({id: 'l', object: 'chat.completion', created: 1, model: 'test/model',
    choices: [{index: 0, finish_reason, message: {role: 'assistant', ...message}}]});
  it('lists the index instead of failing the turn (it used to repeat the broken call until the turns ran out)', async () => {
    const executed: unknown[] = [];
    const exchange = vi.fn(async (sequence: number) => sequence === 1
      ? response({content: null, tool_calls: [{id: 'call_1', type: 'function', function: {name: 'read_source', arguments: '{"query": }'}}]}, 'tool_calls')
      : response({content: '已读取。'}, 'stop'));
    const output = await runRuntime({model: 'test/model', instructions: 'I', input: 'hi', session: session(), maxOutputTokens: 1000, maxTurns: 3,
      exchange, selectHistory: async (_h, i) => i,
      tools: [{name: 'read_source', description: 'd', execute: async arguments_ => { executed.push(arguments_); return '{"kind":"workspace_index"}'; }}]});
    expect(output).toBe('已读取。');
    expect(executed).toEqual([{query: ''}]);
    expect(exchange).toHaveBeenCalledTimes(2);
  });
});

describe('the same repair on a streamed response (the staging shape)', () => {
  const session = (): Session => ({getSessionId: async () => 's', getItems: async () => [], addItems: async () => {}, popItem: async () => undefined, clearSession: async () => {}});
  const chunk = (delta: object, finish: string | null = null) => JSON.stringify({id: 'gen-1', object: 'chat.completion.chunk', created: 1, model: 'test/model',
    choices: [{index: 0, delta: {role: 'assistant', ...delta}, finish_reason: finish}]});
  const tool = (index: number, extra: object) => chunk({tool_calls: [{index, ...extra}]});
  it('streams a read_source call whose empty string was dropped and runs the tool once with an empty query', async () => {
    const executed: unknown[] = [];
    const brokenCall = {id: 'call_1', type: 'function', function: {name: 'read_source', arguments: '{"query": }'}};
    const exchange = vi.fn(async (sequence: number, _body: string, onChunk?: (chunk: string) => void) => {
      if (sequence === 1) {
        for (const frame of [tool(0, {id: 'call_1', type: 'function', function: {name: 'read_source', arguments: ''}}), tool(0, {function: {arguments: ''}}),
          tool(0, {function: {arguments: '{"query": '}}), tool(0, {function: {arguments: '}'}}), chunk({content: ''}, 'tool_calls')]) onChunk?.(frame);
        return JSON.stringify({id: 'gen-1', object: 'chat.completion', created: 1, model: 'test/model',
          choices: [{index: 0, finish_reason: 'tool_calls', message: {role: 'assistant', content: null, tool_calls: [brokenCall]}}]});
      }
      onChunk?.(chunk({content: '已读取。'}));onChunk?.(chunk({content: ''}, 'stop'));
      return JSON.stringify({id: 'gen-2', object: 'chat.completion', created: 1, model: 'test/model',
        choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content: '已读取。'}}]});
    });
    const output = await runRuntime({model: 'test/model', instructions: 'I', input: 'hi', session: session(), maxOutputTokens: 1000, maxTurns: 3,
      exchange, stream: true, selectHistory: async (_h, i) => i,
      tools: [{name: 'read_source', description: 'd', execute: async arguments_ => { executed.push(arguments_); return '{"kind":"workspace_index"}'; }}]});
    expect(output).toBe('已读取。');
    expect(executed).toEqual([{query: ''}]);
    expect(exchange).toHaveBeenCalledTimes(2);
  });
});
