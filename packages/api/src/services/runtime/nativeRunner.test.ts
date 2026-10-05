/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe, expect, it, vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {Session} from '@openai/agents';
import {runRuntime} from './runner';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {openRouterBound} from '../bill2/openRouterPolicy';

const session = (): Session => ({
  getSessionId: async () => 'synthetic', getItems: async () => [], addItems: async () => {},
  popItem: async () => undefined, clearSession: async () => {},
});
const completion = (content: string | null, finish = 'stop', calls?: unknown[]) => ({
  id: 'native-test', object: 'chat.completion', model: 'm/x', choices: [{index: 0,
    message: {role: 'assistant', content, ...(calls ? {tool_calls: calls} : {})}, finish_reason: finish,
  }], usage: {prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost: 0.00000123},
});
const call = (id: string) => ({id, type: 'function', function: {name: 'read_source', arguments: '{}'}});
const frame = (response: ReturnType<typeof completion>) => JSON.stringify({
  ...response, object: 'chat.completion.chunk', choices: [{index: 0,
    delta: {...response.choices[0]!.message,
      ...(response.choices[0]!.message.tool_calls ? {tool_calls: response.choices[0]!.message.tool_calls.map(
        (value, index) => ({...value as object, index}),
      )} : {}),
    }, finish_reason: response.choices[0]!.finish_reason,
  }],
});

describe('native C0/C1 SDK integration without external calls', () => {
  it.each(['live', 'replay', 'nonstream'] as const)('rejects tool length before execution (%s)', async mode => {
    const executed = vi.fn(async () => 'source');
    const response = completion('partial body', 'length', [call('first')]);
    const exchange = vi.fn(async (_sequence: number, _request: string, onChunk?: (chunk: string) => void) => {
      if (mode === 'live') onChunk?.(frame(response));
      return JSON.stringify(response);
    });
    await expect(runRuntime({model: 'm/x', instructions: 'I', input: 'hello', session: session(),
      maxOutputTokens: 8192, maxTurns: 2, stream: mode !== 'nonstream', reasoning: {effort: 'none'},
      rejectTruncatedTools: true, tools: [{name: 'read_source', description: 'Read.', execute: executed}],
      selectHistory: async (_history, incoming) => incoming, exchange,
    })).rejects.toThrow('RUNTIME_OUTPUT_TRUNCATED');
    expect(executed).not.toHaveBeenCalled();
    expect(exchange).toHaveBeenCalledOnce();
  });

  it.each(['live', 'replay', 'nonstream'] as const)('retains serial multi-tool rejection (%s)', async mode => {
    const executed = vi.fn(async () => 'source');
    const response = completion(null, 'tool_calls', [call('first'), call('second')]);
    const exchange = vi.fn(async (_sequence: number, _request: string, onChunk?: (chunk: string) => void) => {
      if (mode === 'live') onChunk?.(frame(response));
      return JSON.stringify(response);
    });
    await expect(runRuntime({model: 'm/x', instructions: 'I', input: 'hello', session: session(),
      maxOutputTokens: 8192, maxTurns: 2, stream: mode !== 'nonstream', reasoning: {effort: 'none'},
      rejectTruncatedTools: true, tools: [{name: 'read_source', description: 'Read.', execute: executed}],
      selectHistory: async (_history, incoming) => incoming, exchange,
    })).rejects.toThrow('RUNTIME_EXECUTION_PENDING');
    expect(executed).not.toHaveBeenCalled();
    expect(exchange).toHaveBeenCalledOnce();
  });

  it('keeps v4 live and receipt replay request bytes identical', async () => {
    const requests: string[] = [];
    const outputs: string[] = [];
    for (const live of [true, false]) {
      const shown: string[] = [];
      outputs.push(await runRuntime({model: 'm/x', instructions: 'I', input: 'hello', session: session(),
        maxOutputTokens: 8192, maxTurns: 1, stream: true, reasoning: {effort: 'none'},
        rejectTruncatedTools: true, tools: [], selectHistory: async (_history, incoming) => incoming,
        onText: text => shown.push(text), exchange: async (_sequence, request, onChunk) => {
          requests.push(request);
          const response = completion('{"message":"hello 😀","patches":[]}');
          if (live) onChunk?.(frame(response));
          return JSON.stringify(response);
        },
      }));
      expect(shown.join('')).toBe(outputs.at(-1));
    }
    expect(requests[0]).toBe(requests[1]);
    expect(outputs[0]).toBe(outputs[1]);
  });

  it.each([false, true])('preserves frozen legacy request golden bytes (stream=%s)', async stream => {
    let request = '';
    await runRuntime({model: 'm/x', instructions: '系统说明 "quoted"\n第二行',
      input: 'HOST_OPEN_CURRENT_QUESTION', session: session(), maxOutputTokens: 4096, maxTurns: 1,
      tools: [], stream, selectHistory: async (_history, incoming) => incoming,
      exchange: async (_sequence, body, onChunk) => {
        request = body;
        const response = completion('ok');
        onChunk?.(frame(response));
        return JSON.stringify(response);
      },
    });
    // Existing staging golden hashes from runner.test.ts; no new hashes minted by this implementation.
    expect(createHash('sha256').update(request).digest('hex')).toBe(stream
      ? '2fbc2f6b9786b3ca9d51034a7510e940fdaeda1f80a758b1318f560eeb5b23a4'
      : 'd5775f64b6a2217798aa8b2783919558a5a91d3c08ff448b30f00c948a247d59');
  });

  it('produces identical billing evidence through actual stream and nonstream adapters', async () => {
    const identity = {provider: 'openrouter' as const, account: 'synthetic', model: 'm/x', protocol: 'openrouter-chat-v1' as const,
      providerLimits: {providerSlug: 'synthetic', contextTokens: 20000, promptUsdPerMillion: '2',
        completionUsdPerMillion: '1', requestUsd: '0'}, outputLimit: 8192, upperUsd: ''};
    identity.upperUsd = openRouterBound(identity.providerLimits, identity.outputLimit).upperUsd;
    const response = completion('{"message":"hello 😀","patches":[]}');
    const responseBytes = JSON.stringify(response);
    const evidence: Array<ReturnType<ReturnType<typeof openRouterAdapter>['evidence']>> = [];
    const requests: Record<string, unknown>[] = [];
    for (const stream of [false, true]) {
      const transport = vi.fn<typeof fetch>(async () => new Response(stream
        ? 'data: ' + frame(response) + '\n\ndata: [DONE]\n\n' : responseBytes));
      const adapter = openRouterAdapter({credential: async () => 'SYNTHETIC_TEST_ONLY', transport});
      expect(await runRuntime({model: 'm/x', instructions: 'I', input: 'hello', session: session(),
        maxOutputTokens: 8192, maxTurns: 1, stream, reasoning: {effort: 'none'}, tools: [],
        rejectTruncatedTools: true, selectHistory: async (_history, incoming) => incoming,
        exchange: async (_sequence, body, onChunk) => {
          const request = JSON.parse(body) as Record<string, unknown>;
          requests.push(request);
          const input = JSON.stringify({...request,
            provider: openRouterBound(identity.providerLimits, identity.outputLimit).routing});
          const send = await adapter.prepareDispatch({input}, identity, onChunk);
          const result = adapter.evidence(await send(), identity, 'response');
          evidence.push(result);
          return result.rawBody;
        },
      })).toBe(response.choices[0]!.message.content);
      expect(transport).toHaveBeenCalledOnce();
    }
    const comparable = (value: typeof evidence[number]) => ({
      final: value.final, cost: value.cost, providerId: value.providerId,
      usage: value.usage, response: JSON.parse(value.rawBody),
    });
    expect(comparable(evidence[0]!)).toEqual(comparable(evidence[1]!));
    expect(evidence[0]).toMatchObject({final: true, cost: '0.00000123', providerId: 'native-test'});
    expect(requests[1]).toEqual({...requests[0], stream: true, stream_options: {include_usage: true}});
    expect(evidence[0]!.sourceHash).not.toBe(evidence[1]!.sourceHash); // Actual transport bytes differ.
  });
});
