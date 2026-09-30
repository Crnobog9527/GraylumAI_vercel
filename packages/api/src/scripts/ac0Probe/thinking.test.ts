/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0d: the reasoning object as a second thinking form, and data_collection
// omitted only for configs that say so. No network: every upstream is a mock.
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createBudget, memoryLedger} from './budget.ts';
import {builtInConfigs, resolveConfigs, routing, type ProbeConfig} from './config.ts';
import {sseResponse, syntheticUpstream, textDeltas} from './dryRun.ts';
import {KEY_ENV, runProbe} from './main.ts';
import {assertDataCollection, probeTransport, type Upstream} from './transport.ts';

const KEY = 'z'.repeat(40);
let home: string;
let out: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ac0-thinking-'));
  out = [];
});
afterEach(() => rmSync(home, {recursive: true, force: true}));

type Sent = {body: Record<string, any>};
function recording() {
  const sent: Sent[] = [];
  const respond = syntheticUpstream(['references/gather.md']);
  const upstream: Upstream = async (url, init) => {
    sent.push({body: JSON.parse(String(init.body))});
    return respond(url, init);
  };
  return {sent, upstream};
}

const deps = (fetch?: Upstream) => ({home, fetch, stdout: (t: string) => out.push(t), stderr: (t: string) => out.push(t)});

async function live(configs: string, ...counts: string[]) {
  const args = ['--out-dir', join(home, 'results'), '--configs', configs, ...counts];
  const dry = await runProbe(args, {}, deps());
  expect(dry.exitCode).toBe(0);
  const network = recording();
  const outcome = await runProbe([...args, '--live', '--confirm', dry.plan!.planId], {[KEY_ENV]: KEY}, deps(network.upstream));
  expect(outcome.exitCode).toBe(0);
  return {outcome, sent: network.sent};
}

const byId = (id: string) => builtInConfigs.find(config => config.id === id)!;
const flashRouting = {only: ['alibaba'], allow_fallbacks: false, require_parameters: true, max_price: {prompt: 0.3, completion: 0.95}};

describe('qwen3.8-flash on Alibaba', () => {
  it('sends reasoning enabled false, no reasoning_effort and no data_collection on every call', async () => {
    const {outcome, sent} = await live('qwen-flash-alibaba-off', '--ask', '2', '--reference', '1');
    expect(sent.length).toBe(4);
    for (const call of sent) {
      expect(call.body.model).toBe('qwen/qwen3.8-flash');
      expect(call.body.reasoning).toEqual({enabled: false});
      expect('reasoning_effort' in call.body).toBe(false);
      expect(call.body.provider).toEqual(flashRouting);
      expect('parallel_tool_calls' in call.body).toBe(false);
    }
    for (const result of outcome.results!) for (const call of result.calls) expect(call.dataCollection).toBe('omitted');
    expect(out.join('')).toContain('qwen-flash-alibaba-off: qwen/qwen3.8-flash via alibaba, reasoning={"enabled":false}, ' +
      'data_collection=omitted');
    const summary = JSON.parse(readFileSync(join(outcome.runDir!, 'summary.json'), 'utf8'));
    expect(summary.configs[0]).toMatchObject({thinking: 'reasoning={"enabled":false}', dataCollection: 'omitted'});
  });

  it('sends the minimal-thinking tier as a reasoning token budget', async () => {
    const {sent} = await live('qwen-flash-alibaba-min', '--ask', '1');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.reasoning).toEqual({max_tokens: 256});
    expect('reasoning_effort' in sent[0]!.body).toBe(false);
    expect(sent[0]!.body.provider).toEqual(flashRouting);
  });

  it('keeps data_collection deny and reasoning_effort for every other config in the same run', async () => {
    const {sent} = await live('qwen-deepinfra-none,qwen-flash-alibaba-off,deepseek-official-low', '--ask', '1');
    expect(sent).toHaveLength(3);
    const [qwen, flash, deepseek] = sent.map(call => call.body);
    expect(qwen!.provider.data_collection).toBe('deny');
    expect(qwen!.reasoning_effort).toBe('none');
    expect('reasoning' in qwen!).toBe(false);
    expect('data_collection' in flash!.provider).toBe(false);
    expect(deepseek!.provider).toMatchObject({only: ['deepseek'], data_collection: 'deny'});
    expect(deepseek!.reasoning_effort).toBe('low');
  });

  it('omits data_collection only for the two built-in flash configs', () => {
    const omitted = builtInConfigs.filter(config => !('data_collection' in routing(config))).map(config => config.id);
    expect(omitted).toEqual(['qwen-flash-alibaba-off', 'qwen-flash-alibaba-min']);
    for (const config of builtInConfigs) {
      if (!omitted.includes(config.id)) expect(routing(config)).toHaveProperty('data_collection', 'deny');
    }
  });
});

describe('transport guards for both thinking forms', () => {
  const transport = (config: ProbeConfig) => {
    const sent: unknown[] = [];
    const t = probeTransport({
      config, maxTokens: 64, timeoutMs: 1000, budget: createBudget({maxCalls: 10, maxUsd: 1, ledger: memoryLedger()}),
      upstream: async (_url, init) => {
        sent.push(JSON.parse(String(init.body)));
        return sseResponse(config.model, textDeltas('hi'), {usage: {cost: 0}});
      },
      authorization: 'Bearer test', clock: () => performance.now(), trialStart: performance.now(), redact: text => text,
    });
    const post = (thinking: Record<string, unknown>) => t.fetch('http://127.0.0.1/ac0/chat/completions', {method: 'POST',
      body: JSON.stringify({model: config.model, messages: [{role: 'user', content: JSON.stringify(thinking)}], stream: true,
        stream_options: {include_usage: true}, store: false, max_tokens: 64, ...thinking})});
    return {post, sent};
  };

  it('refuses a reasoning config body that differs from the config or adds reasoning_effort', async () => {
    const {post, sent} = transport(byId('qwen-flash-alibaba-off'));
    for (const thinking of [
      {}, {reasoning: {enabled: true}}, {reasoning: {enabled: false, max_tokens: 10}}, {reasoning: {effort: 'none'}},
      {reasoning: {enabled: false}, reasoning_effort: 'none'}, {reasoning_effort: 'none'},
    ]) {
      await expect(post(thinking)).rejects.toThrow('PROBE_REQUEST_DENIED:reasoning');
    }
    expect(sent).toHaveLength(0);
    await (await post({reasoning: {enabled: false}})).text();
    expect(sent).toHaveLength(1);
  });

  it('refuses a reasoning object on an effort config', async () => {
    const {post, sent} = transport(byId('qwen-deepinfra-none'));
    await expect(post({reasoning_effort: 'none', reasoning: {enabled: false}})).rejects.toThrow('PROBE_REQUEST_DENIED:reasoning');
    await expect(post({reasoning: {effort: 'none'}})).rejects.toThrow('PROBE_REQUEST_DENIED:reasoning');
    expect(sent).toHaveLength(0);
  });

  it('checks data_collection per config: deny required unless omitted, and then absent', () => {
    const omit = byId('qwen-flash-alibaba-off');
    const deny = byId('qwen-alibaba-none');
    expect(() => assertDataCollection({provider: {only: ['alibaba']}}, omit)).not.toThrow();
    expect(() => assertDataCollection({provider: {data_collection: 'deny'}}, omit)).toThrow('PROBE_DATA_COLLECTION_NOT_OMITTED');
    expect(() => assertDataCollection({provider: {data_collection: 'allow'}}, omit)).toThrow('PROBE_DATA_COLLECTION_NOT_OMITTED');
    expect(() => assertDataCollection({}, omit)).toThrow('PROBE_DATA_COLLECTION_NOT_OMITTED');
    expect(() => assertDataCollection({provider: {only: ['alibaba']}}, deny)).toThrow('PROBE_DATA_COLLECTION_NOT_DENIED');
    expect(() => assertDataCollection({provider: {data_collection: 'deny'}}, deny)).not.toThrow();
  });
});

describe('config file limits', () => {
  const extra = (fields: Record<string, unknown>) => [{id: 'x', model: 'a/b', route: 'r', maxPrice: {prompt: 1, completion: 1}, ...fields}];

  it('accepts a reasoning object from a file and still sends deny for it', () => {
    const [config] = resolveConfigs(['x'], extra({reasoning: {enabled: false}}));
    expect(routing(config!)).toHaveProperty('data_collection', 'deny');
  });

  it('refuses dataCollection from a file, both thinking forms, neither, or an unknown reasoning field', () => {
    expect(() => resolveConfigs(['x'], extra({effort: 'none', dataCollection: 'omit'}))).toThrow('dataCollection is built-in only');
    expect(() => resolveConfigs(['x'], extra({effort: 'none', reasoning: {enabled: false}}))).toThrow('PROBE_CONFIG_FILE_INVALID');
    expect(() => resolveConfigs(['x'], extra({}))).toThrow('PROBE_CONFIG_FILE_INVALID');
    expect(() => resolveConfigs(['x'], extra({reasoning: {enabled: false, exclude: true}}))).toThrow('PROBE_CONFIG_FILE_INVALID');
    expect(() => resolveConfigs(['x'], extra({reasoning: {max_tokens: 0}}))).toThrow('PROBE_CONFIG_FILE_INVALID');
  });
});
