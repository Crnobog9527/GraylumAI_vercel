/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it} from 'vitest';
import {runtimeContext} from './runtimeContext';
import {openRouterRequestBody, type RequestContext} from './providerRequest';
import {historyToolNames, FREE_CHAT_REQUEST_FORMAT} from './providerRequest';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const entry = {name: 'script-writer', description: '写口播稿时使用。', moduleId: id(1), skillId: id(2), packageId: id(2),
  revisionId: id(3), packageHash: 'a'.repeat(64), resultBytes: 600};
const base = {version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'hello', instructions: 'Answer', model: 'm/x',
  maxOutputTokens: 4096, maxTurns: 3, historyItems: 0, network: 'deny'};
const withCatalog = {...base, tools: ['load_skill'], skillCatalog: [entry], maxSkillLoads: 2, skillCatalogMaxBytes: 8000, maxToolCalls: 2};

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
    expect(() => openRouterRequestBody(request('load_skill'), {context: v6({skillCatalog: [entry]}), policy, phase: 'ordinary',
      primaryDialogue: true})).not.toThrow();
    expect(() => openRouterRequestBody(request('load_skill'), {context: v6({}), policy, phase: 'ordinary', primaryDialogue: true}))
      .toThrow('RUNTIME_REAL_TOOLS_DISABLED');
  });
  it('replays an earlier load_skill call in free chat history', () => {
    expect(historyToolNames(FREE_CHAT_REQUEST_FORMAT).has('load_skill')).toBe(true);
  });
});
