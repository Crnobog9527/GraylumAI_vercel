/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import type {Upstream} from './transport.ts';

type Delta = Record<string, unknown>;

/** Builds an OpenRouter-style Chat Completions stream from deltas. */
export function sseResponse(model: string, deltas: Delta[], options: {finish?: string; usage?: Record<string, unknown>} = {}) {
  const chunk = (delta: Delta, finish: string | null) => ({
    id: 'gen-dry-run', provider: 'dry-run', model, object: 'chat.completion.chunk', created: 0,
    choices: [{index: 0, delta, finish_reason: finish}],
  });
  const frames = [
    ...deltas.map((delta, index) => chunk(index === 0 ? {role: 'assistant', ...delta} : delta, null)),
    chunk({}, options.finish ?? 'stop'),
    {id: 'gen-dry-run', provider: 'dry-run', model, object: 'chat.completion.chunk', created: 0, choices: [],
      // No token counts: a dry run books exactly the reported cost of zero.
      usage: options.usage ?? {cost: 0}},
  ];
  const text = frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(new TextEncoder().encode(text), {status: 200, headers: {'content-type': 'text/event-stream'}});
}

export const textDeltas = (text: string): Delta[] => [...text.matchAll(/.{1,12}/gsu)].map(([part]) => ({content: part}));

export function toolDeltas(name: string, args: unknown, id = 'call_dry_run'): Delta[] {
  const json = JSON.stringify(args);
  return [
    {tool_calls: [{index: 0, id, type: 'function', function: {name, arguments: ''}}]},
    {tool_calls: [{index: 0, function: {arguments: json.slice(0, 10)}}]},
    {tool_calls: [{index: 0, function: {arguments: json.slice(10)}}]},
  ];
}

/** Deterministic stand-in for OpenRouter. Used whenever --live is absent, so
 * a dry run exercises the SDK and every guard without any network request. */
export function syntheticUpstream(referencePaths: readonly string[]): Upstream {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as {
      model: string; tools?: Array<{function: {name: string; parameters?: {required?: string[]}}}>; messages: Array<{role: string}>;
    };
    const names = (body.tools ?? []).map(tool => tool.function.name);
    const toolResult = body.messages.some(message => message.role === 'tool');
    const callId = 'call_dry_run_' + body.messages.length;
    if (names.includes('read_reference') && !toolResult && referencePaths[0]) {
      return sseResponse(body.model, toolDeltas('read_reference', {path: referencePaths[0]}, callId), {finish: 'tool_calls'});
    }
    if (names.includes('ask_question')) {
      const deltas = [...textDeltas('Dry run, no request was sent. '),
        ...toolDeltas('ask_question', {question: 'Dry run question?', options: ['Option A', 'Option B'],
          // The v5 card schema requires the recommended field (null: a neutral card).
          ...(body.tools!.find(tool => tool.function.name === 'ask_question')!.function.parameters?.required
            ?.includes('recommended') ? {recommended: null} : {})}, callId)];
      return sseResponse(body.model, deltas, {finish: 'tool_calls'});
    }
    return sseResponse(body.model, textDeltas('Dry run reply. No network request was sent for this trial.'));
  };
}
