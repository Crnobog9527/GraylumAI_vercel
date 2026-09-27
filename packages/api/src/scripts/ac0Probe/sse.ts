/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.

export type RawToolCall = {id: string; name: string; arguments: string};
export type ProviderUsage = {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  /** OpenRouter reports the charged amount in USD when available. */
  costUsd?: number;
};

/** What the provider sent on one streamed call. Times are milliseconds after
 * the request was handed to the network layer. */
export type StreamFacts = {
  firstByteMs?: number;
  firstContentMs?: number;
  lastContentMs?: number;
  firstReasoningMs?: number;
  firstToolMs?: number;
  content: string;
  reasoningChars: number;
  toolCalls: RawToolCall[];
  finishReason?: string;
  usage?: ProviderUsage;
  /** Provider name OpenRouter reports for the chunk, used to confirm the route. */
  provider?: string;
  done: boolean;
  streamError?: string;
  malformedFrames: number;
};

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Incremental Chat Completions SSE reader. It only observes; the bytes reach
 * the SDK unchanged. Frame limits keep a broken stream from exhausting memory. */
export function streamObserver(elapsed: () => number) {
  const facts: StreamFacts = {content: '', reasoningChars: 0, toolCalls: [], done: false, malformedFrames: 0};
  const decoder = new TextDecoder();
  const calls = new Map<number, RawToolCall>();
  let pending = '';

  function frame(data: string) {
    if (data === '[DONE]') {
      facts.done = true;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      facts.malformedFrames += 1;
      return;
    }
    if (!object(value)) {
      facts.malformedFrames += 1;
      return;
    }
    if (typeof value.provider === 'string') facts.provider = value.provider.slice(0, 128);
    if (value.error !== undefined) {
      const error = object(value.error) ? value.error : {};
      facts.streamError = String(error.code ?? 'provider_stream_error').slice(0, 64);
    }
    const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
    if (object(choice)) readChoice(choice);
    if (object(value.usage)) readUsage(value.usage);
  }

  function readChoice(choice: Record<string, unknown>) {
    const delta = object(choice.delta) ? choice.delta : {};
    const now = elapsed();
    if (typeof delta.content === 'string' && delta.content) {
      facts.firstContentMs ??= now;
      facts.lastContentMs = now;
      facts.content += delta.content;
    }
    const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning.length : 0;
    const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details.length : 0;
    if (reasoning || details) {
      facts.firstReasoningMs ??= now;
      facts.reasoningChars += reasoning;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        if (!object(part)) continue;
        facts.firstToolMs ??= now;
        const index = typeof part.index === 'number' ? part.index : 0;
        const call = calls.get(index) ?? {id: '', name: '', arguments: ''};
        if (typeof part.id === 'string') call.id = part.id;
        const fn = object(part.function) ? part.function : {};
        if (typeof fn.name === 'string') call.name += fn.name;
        if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
        calls.set(index, call);
      }
      facts.toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    }
    if (typeof choice.finish_reason === 'string') facts.finishReason = choice.finish_reason;
  }

  function readUsage(usage: Record<string, unknown>) {
    const details = object(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
    facts.usage = {
      promptTokens: count(usage.prompt_tokens),
      completionTokens: count(usage.completion_tokens),
      reasoningTokens: count(details.reasoning_tokens),
      costUsd: count(usage.cost),
    };
  }

  function push(bytes: Uint8Array) {
    facts.firstByteMs ??= elapsed();
    pending += decoder.decode(bytes, {stream: true});
    if (pending.length > 1_048_576) {
      facts.streamError ??= 'frame_too_large';
      pending = '';
      return;
    }
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (line.startsWith('data:')) frame(line.slice(5).trim());
    }
  }

  function end() {
    pending += decoder.decode();
    if (pending.trim().startsWith('data:')) frame(pending.trim().slice(5).trim());
    pending = '';
    return facts;
  }

  return {push, end, facts};
}
