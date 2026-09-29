/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it, vi} from 'vitest';
import {blindReview} from './blindReview.ts';
import type {TrialResult} from './trial.ts';

function configuration(configId: string): TrialResult[] {
  return Array.from({length: 40}, (_, index) => ({
    configId, scenarioId: 'scenario-' + index, kind: index < 30 ? 'ask' : 'text', index,
    startedAt: 'PRIVATE_TIME', totalMs: 987654321, firstSdkTextMs: 123456789,
    contentChars: 12, reasoningSeen: true, reasoningTokens: 876543210,
    referenceReads: 0, askExecutions: index < 30 ? 1 : 0, finalOutput: 'PRIVATE_SDK_OUTPUT',
    calls: [{sequence: 1, status: 'ok', sentAtMs: 9999, requestBytes: 4321,
      dataCollection: 'deny', boundUsd: 654321.98, providerCostUsd: 876543.21,
      errorMessage: 'PRIVATE_MODEL_AND_ROUTE', facts: {
        content: 'Public response ' + index, reasoningChars: 77777777,
        provider: 'PRIVATE_ROUTE', firstReasoningMs: 66666666, done: true, malformedFrames: 0,
        toolCalls: index < 30 ? [{id: 'PRIVATE_PROVIDER_TOOL_ID', name: 'ask_question',
          arguments: JSON.stringify({question: 'Question ' + index, options: ['A', 'B']})}] : [],
      }},
    ],
  }));
}
const inputs = () => [configuration('PRIVATE_CONFIG_A'), configuration('PRIVATE_CONFIG_B')] as const;
const seed = (value: number) => new Uint8Array(32).fill(value);

describe('probe-local blind review material (offline only)', () => {
  it('keeps all 80 samples and exposes only review fields, never identity, performance or automatic verdicts', () => {
    const results = inputs();
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('NO_NETWORK'); });
    try {
      const output = blindReview(results, seed(1));
      expect(network).not.toHaveBeenCalled();
      expect(output.items).toHaveLength(80);
      expect(output.privateMapping).toHaveLength(80);
      expect(new Set(output.items.map(item => item.opaqueId)).size).toBe(80);
      for (const item of output.items) {
        expect(item.opaqueId).toMatch(/^[a-f0-9]{64}$/);
        expect(Object.keys(item).sort()).toEqual(
          ['opaqueId', 'scenarioId', 'kind', 'index', 'publicText', 'toolArguments'].sort());
        for (const tool of item.toolArguments) expect(Object.keys(tool).sort()).toEqual(['arguments', 'name']);
        const mapping = output.privateMapping.find(entry => entry.opaqueId === item.opaqueId)!;
        const original = results.flat().find(trial => trial.configId === mapping.configId && trial.index === mapping.index)!;
        expect(item).toMatchObject({scenarioId: original.scenarioId, kind: original.kind, index: original.index,
          publicText: original.calls[0]!.facts.content});
        expect(item.toolArguments).toEqual(original.calls[0]!.facts.toolCalls.map(tool =>
          ({name: tool.name, arguments: tool.arguments})));
      }
      const reviewOnly = JSON.stringify(output.items);
      expect(reviewOnly).not.toMatch(/PRIVATE_|configId|model|route|reasoning|cost|totalMs|firstSdkTextMs|startedAt/);
      expect(reviewOnly).not.toMatch(/987654321|123456789|876543210|654321\.98|876543\.21|77777777|66666666/);
      expect(reviewOnly).not.toMatch(/privateMapping|semanticReview|verdict|PASS/);
      expect(output.privateMapping.filter(item => item.configId === 'PRIVATE_CONFIG_A')).toHaveLength(40);
      expect(output.privateMapping.filter(item => item.configId === 'PRIVATE_CONFIG_B')).toHaveLength(40);
    } finally { network.mockRestore(); }
  });

  it('derives unrelated IDs and a mixed randomized order from caller entropy without mutating inputs', () => {
    const results = inputs(), before = structuredClone(results);
    const first = blindReview(results, seed(1)), second = blindReview(results, seed(2));
    expect(blindReview(results, seed(1))).toEqual(first);
    expect(first.items.map(item => item.opaqueId)).not.toEqual(second.items.map(item => item.opaqueId));
    expect(first.items.map(item => item.index)).not.toEqual(second.items.map(item => item.index));
    expect(first.items.map(item => item.opaqueId)).not.toEqual(first.privateMapping.map(item => item.opaqueId));
    const firstHalf = first.items.slice(0, 40).map(item =>
      first.privateMapping.find(mapping => mapping.opaqueId === item.opaqueId)!.configId);
    expect(new Set(firstHalf).size).toBe(2);
    expect(results).toEqual(before);
    first.items[0]!.toolArguments.push({name: 'edited', arguments: '{}'});
    expect(results).toEqual(before);
  });

  it('retains failed, blank, malformed and multiple-tool samples without semantic approval or filtering', () => {
    const results = inputs();
    results[0][0] = {...results[0][0]!, stop: 'unknown_result', calls: []};
    results[1][0]!.calls[0]!.facts.toolCalls.push({id: 'PRIVATE_SECOND_CALL', name: 'unknown_tool', arguments: '{broken'});
    const output = blindReview(results, seed(3));
    expect(output.items).toHaveLength(80);
    const emptyId = output.privateMapping.find(item => item.configId === 'PRIVATE_CONFIG_A' && item.index === 0)!.opaqueId;
    expect(output.items.find(item => item.opaqueId === emptyId)).toMatchObject({publicText: '', toolArguments: []});
    const malformedId = output.privateMapping.find(item => item.configId === 'PRIVATE_CONFIG_B' && item.index === 0)!.opaqueId;
    expect(output.items.find(item => item.opaqueId === malformedId)!.toolArguments).toHaveLength(2);
    expect(output.items.find(item => item.opaqueId === malformedId)!.toolArguments[1])
      .toEqual({name: 'unknown_tool', arguments: '{broken'});
  });

  it('refuses incomplete, duplicated, mismatched or mixed configurations instead of dropping samples', () => {
    expect(() => blindReview(inputs(), new Uint8Array(16))).toThrow('RANDOM_SEED_REQUIRED');
    const short = inputs();
    short[0].pop();
    expect(() => blindReview(short, seed(1))).toThrow('INCOMPLETE_CONFIGURATION');
    const duplicate = inputs();
    duplicate[0][1] = duplicate[0][0]!;
    expect(() => blindReview(duplicate, seed(1))).toThrow('INCOMPLETE_CONFIGURATION');
    const mixed = inputs();
    mixed[0][0]!.configId = 'PRIVATE_OTHER';
    expect(() => blindReview(mixed, seed(1))).toThrow('INCOMPLETE_CONFIGURATION');
    const mismatch = inputs();
    mismatch[1][0]!.scenarioId = 'unexpected-scenario';
    expect(() => blindReview(mismatch, seed(1))).toThrow('CONFIGURATION_MISMATCH');
    const same = configuration('PRIVATE_CONFIG_A');
    expect(() => blindReview([same, same], seed(1))).toThrow('CONFIGURATION_MISMATCH');
  });
});
