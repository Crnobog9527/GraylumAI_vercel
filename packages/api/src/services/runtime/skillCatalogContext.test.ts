/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {runtimeContext} from './runtimeContext';
import {openRouterRequestBody, type RequestContext} from './providerRequest';
import {historyToolNames, FREE_CHAT_REQUEST_FORMAT} from './providerRequest';
import {executionTools} from './executionTools';
import {skillCatalogReserveBytes} from './skillCatalog';
import {selectRuntimeCallInput} from './context';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const baseEntry = {name: 'script-writer', description: '写口播稿时使用。', moduleId: id(1), skillId: id(2), packageId: id(2),
  revisionId: id(3), packageHash: 'a'.repeat(64), resultBytes: 600};
const entry = (patch: Partial<typeof baseEntry> = {}) => ({...baseEntry, ...patch});
const base = {version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'hello', instructions: 'Answer', model: 'm/x',
  maxOutputTokens: 4096, maxTurns: 3, historyItems: 0, network: 'deny'};
const withCatalog = {...base, tools: ['load_skill'], skillCatalog: [baseEntry], maxSkillLoads: 2, skillCatalogMaxBytes: 8000, maxToolCalls: 2};

describe('frozen Skill catalog', () => {
  it('is valid only on an ordinary turn, with its tool, load limit and size together', () => {
    expect(runtimeContext.safeParse(withCatalog).success).toBe(true);
    expect(runtimeContext.safeParse({...withCatalog, tools: []}).success).toBe(false);
    expect(runtimeContext.safeParse({...base, tools: ['load_skill']}).success).toBe(false);
    expect(runtimeContext.safeParse({...withCatalog, maxSkillLoads: undefined}).success).toBe(false);
    expect(runtimeContext.safeParse({...withCatalog, maxSkillLoads: 3}).success).toBe(false);
    expect(runtimeContext.safeParse({...withCatalog, skillCatalogMaxBytes: undefined}).success).toBe(false);
    expect(runtimeContext.safeParse({...withCatalog, role: 'skill'}).success).toBe(false);
    expect(runtimeContext.safeParse({...withCatalog, opcTurnToken: id(9)}).success).toBe(false);
    expect(runtimeContext.safeParse({...withCatalog, skillCatalog: []}).success).toBe(false);
  });
});

const policy = {modelId: id(7), provider: 'openrouter', account: 'a', model: 'm/x', protocol: 'openrouter-chat-v1' as const,
  upperUsd: '0.02', inputLimit: 10000, outputLimit: 100, automaticRetry: false as const, hiddenTools: false as const, lookupSupported: true,
  providerLimits: {providerSlug: 'synthetic', contextTokens: 10000, promptUsdPerMillion: '2', completionUsdPerMillion: '0', requestUsd: '0'}};
const request = (name: string) => JSON.stringify({model: 'm/x', messages: [{content: 'I', role: 'system'}, {role: 'user', content: 'hello'}],
  tools: [{type: 'function', function: {name, description: 'd', parameters: {type: 'object'}, strict: true}}],
  max_tokens: 100, stream: false, store: false, reasoning_effort: 'none'});
const v6 = (patch: Partial<RequestContext>): RequestContext =>
  ({providerRequestFormat: FREE_CHAT_REQUEST_FORMAT, tools: ['load_skill'], network: 'deny', reasoning: {effort: 'none'}, ...patch});

describe('provider request', () => {
  it('sends load_skill only for a context that froze a catalog', () => {
    expect(() => openRouterRequestBody(request('load_skill'), {context: v6({skillCatalog: [baseEntry]}), policy, phase: 'ordinary',
      primaryDialogue: true})).not.toThrow();
    expect(() => openRouterRequestBody(request('load_skill'), {context: v6({}), policy, phase: 'ordinary', primaryDialogue: true}))
      .toThrow('RUNTIME_REAL_TOOLS_DISABLED');
  });
  it('replays an earlier load_skill call in free chat history', () => {
    expect(historyToolNames(FREE_CHAT_REQUEST_FORMAT).has('load_skill')).toBe(true);
  });
});

describe('execution tool budget', () => {
  // The loads this reply may make are reserved once, for the first history selection only (like a Skill file's reserve):
  // later calls measure the actual result already in the request, never the result plus its reserve.
  it('reports the catalog reserve (largest 2 loads) separately and keeps it out of the per-call tool bytes', () => {
    const run = (context: unknown) => executionTools({context: runtimeContext.parse(context), executionId: id(9), args: {p_execution_id: id(9)},
      agentTurn: false, grounded: false, fiveFields: false, sources: (() => []) as never, ownerRpc: (async () => ({})) as never,
      budget: {assertCanStart: () => {}}, execution: {sessionId: id(8)}, research: null, onRefused: () => {},
      exchange: (async () => '') as never});
    const catalog = [entry({resultBytes: 700}), entry({name: 'caption-writer', resultBytes: 1900}), entry({name: 'title-writer', resultBytes: 400})];
    const plain = run({...base, tools: []});
    const loaded = run({...withCatalog, skillCatalog: catalog});
    expect(loaded.tools.map(tool => tool.name)).toEqual(['load_skill']);
    expect(skillCatalogReserveBytes(catalog)).toBe(2600);
    expect(loaded.catalogReserve).toBe(2600);
    expect(plain.catalogReserve).toBe(0);
    expect(loaded.toolBytes - plain.toolBytes).toBeLessThan(600);
  });
});

describe('loaded Skills in later turns', () => {
  const call = (callId: string) => ({type: 'function_call', callId, name: 'load_skill', arguments: '{"query":"script-writer"}', status: 'completed'});
  const result = (callId: string, instructions: string, named = true) => ({type: 'function_call_result', callId, ...(named ? {name: 'load_skill'} : {}),
    output: JSON.stringify({name: 'script-writer', instructions}), status: 'completed'});
  const user = (text: string) => ({type: 'message', role: 'user', content: text});
  const options = {instructions: 'I', inputBytes: 100000, toolBytes: 0};

  it('replaces a Skill loaded in an earlier turn by a marker, because that Skill may since be republished or disabled', () => {
    const items = [user('write a script'), call('c1'), result('c1', 'OLD SKILL INSTRUCTIONS'), user('shorter')];
    const sent = JSON.stringify(selectRuntimeCallInput(items, 3, options));
    expect(sent).not.toContain('OLD SKILL INSTRUCTIONS');
    expect(sent).toContain('script-writer');
    expect(sent).toContain('load_skill again');
  });
  it('knows the result by its call when the item carries no name, and keeps the result of the current turn', () => {
    const items = [user('a'), call('c1'), result('c1', 'OLD INSTRUCTIONS', false), user('b'), call('c2'), result('c2', 'CURRENT INSTRUCTIONS')];
    const sent = JSON.stringify(selectRuntimeCallInput(items, 3, options));
    expect(sent).not.toContain('OLD INSTRUCTIONS');
    expect(sent).toContain('CURRENT INSTRUCTIONS');
  });
  it('leaves other tools alone, even when the user asks to compare versions', () => {
    const other = {type: 'function_call_result', callId: 'r1', name: 'read_source', output: '{"body":"KEEP"}', status: 'completed'};
    const readCall = {type: 'function_call', callId: 'r1', name: 'read_source', arguments: '{}', status: 'completed'};
    const items = [user('a'), readCall, other, user('b')];
    expect(JSON.stringify(selectRuntimeCallInput(items, 3, {...options, preserveHistoricalMaterial: true}))).toContain('KEEP');
    const loaded = [user('a'), call('c1'), result('c1', 'OLD INSTRUCTIONS'), user('b')];
    expect(JSON.stringify(selectRuntimeCallInput(loaded, 3, {...options, preserveHistoricalMaterial: true}))).not.toContain('OLD INSTRUCTIONS');
  });
});
