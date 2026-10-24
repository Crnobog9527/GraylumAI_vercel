/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it, vi} from 'vitest';
import type {Session} from '@openai/agents';
import {runRuntime} from './runner';
import {loadSkillParameters} from './loadSkillTool';

const session = (): Session => ({getSessionId: async () => 'synthetic', getItems: async () => [], addItems: async () => {},
  popItem: async () => undefined, clearSession: async () => {}});
const call = (id: string) => ({id, type: 'function', function: {name: 'load_skill', arguments: JSON.stringify({name: 'script-writer'})}});
const response = (message: object, finish_reason = 'stop') => JSON.stringify({id: 'local', object: 'chat.completion', created: 1,
  model: 'test/model', choices: [{index: 0, finish_reason, message: {role: 'assistant', ...message}}]});

/** The model loads a Skill in each of the first two responses and would load a third time if it were still offered. */
function harness(enabled?: () => boolean) {
  const bodies: Array<{tools?: unknown[]}> = [];
  const exchange = vi.fn(async (sequence: number, body: string) => {
    bodies.push(JSON.parse(body));
    return sequence <= 3 && JSON.parse(body).tools?.length ? response({content: null, tool_calls: [call('c' + sequence)]}, 'tool_calls')
      : response({content: 'final answer'});
  });
  let loads = 0;
  const run = () => runRuntime({model: 'test/model', instructions: 'Answer', input: 'hello', session: session(), maxOutputTokens: 1000,
    maxTurns: 6, selectHistory: async (_h, i) => i, exchange,
    tools: [{name: 'load_skill', description: 'load', parameters: loadSkillParameters, ...(enabled ? {enabled: () => loads < 2} : {}), execute: async () => {loads++;return '{"instructions":"x"}';}}]});
  return {bodies, run, loads: () => loads};
}

describe('a tool with its own cap (CONTENT-CONVERSATION-DRIVEN load_skill)', () => {
  it('stops being offered once its cap is reached, so the reply is not spent on refused calls', async () => {
    const h = harness(() => true);
    await expect(h.run()).resolves.toBe('final answer');
    expect(h.loads()).toBe(2);
    expect(h.bodies).toHaveLength(3);
    expect(h.bodies[0]!.tools).toHaveLength(1);
    expect(h.bodies[1]!.tools).toHaveLength(1);
    expect(h.bodies[2]!.tools ?? []).toEqual([]);
  });

  it('a tool without a cap is offered on every call, as before', async () => {
    const h = harness();
    await expect(h.run()).resolves.toBe('final answer');
    expect(h.bodies.slice(0, 3).every(body => body.tools?.length === 1)).toBe(true);
    expect(h.loads()).toBe(3);
  });
});
