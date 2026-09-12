/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Agent, Runner, OpenAIChatCompletionsModel, tool } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import { parseProviderUsage } from '../providerUsage';
import {openRouterSearchCount} from '../openRouterSearch';

export const SDK_VERSION = '0.18.0' as const;
export type CallEvidence = {
  sequence: number;
  providerId: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageEvidence: ReturnType<typeof parseProviderUsage>['evidence'] | null;
  state: 'responded' | 'unknown' | 'truncated';
};
export type SliceRunInput = {
  model: string;
  apiKey: string;
  instructions: string;
  input: string;
  maxOutputTokens: number;
  /** Must durably claim this exact call and validate the frozen budget before dispatch. */
  beforeCall: (sequence: number, request: unknown) => Promise<void>;
  recordCall: (evidence: CallEvidence) => Promise<void>;
  /** Bound by the service to one explicitly selected, fixed artifact identity. */
  readArtifact?: () => Promise<string>;
  signal?: AbortSignal;
};
export class SliceRunError extends Error {
  constructor(readonly code: 'OUTCOME_UNKNOWN' | 'TRUNCATED' | 'CALL_LIMIT' | 'MODEL_NOT_ALLOWED') {
    super(code);
  }
}

/** SDK owns the bounded tool loop. Business services own identities and accounting. */
export async function runSkillSlice(input: SliceRunInput, transport: typeof fetch = fetch) {
  if (!input.model.trim() || /(^openai\/|gpt)/i.test(input.model)) throw new SliceRunError('MODEL_NOT_ALLOWED');
  if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > 20000) throw new SliceRunError('CALL_LIMIT');
  const signal = AbortSignal.any([AbortSignal.timeout(45000), ...(input.signal ? [input.signal] : [])]);
  let calls = 0, toolCalls = 0;
  let boundaryFailure: SliceRunError | undefined;
  const evidence: CallEvidence[] = [];
  const guardedFetch: typeof fetch = async (url, init) => {
    if (String(url) !== 'https://openrouter.ai/api/v1/chat/completions') throw new SliceRunError('MODEL_NOT_ALLOWED');
    if (++calls > (input.readArtifact ? 2 : 1) || signal.aborted) throw new SliceRunError('CALL_LIMIT');
    const sequence = calls;
    const body = JSON.parse(String(init?.body));
    if (body.model !== input.model || body.stream) throw new SliceRunError('MODEL_NOT_ALLOWED');
    // No provider fallbacks, searches, parallel tool fanout or SDK-inferred provider choice.
    body.provider = { allow_fallbacks: false, require_parameters: true };
    body.parallel_tool_calls = false;
    await input.beforeCall(sequence, body);
    let recorded = false;
    let item: CallEvidence = { sequence, providerId: null, finishReason: null, inputTokens: null, outputTokens: null, usageEvidence: null, state: 'unknown' };
    try {
      const response = await transport(url, { ...init, body: JSON.stringify(body), signal, redirect: 'error' });
      if (!response.body) throw new SliceRunError('OUTCOME_UNKNOWN');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 262144) throw new SliceRunError('OUTCOME_UNKNOWN');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      const rawText = Buffer.concat(chunks).toString('utf8');
      const raw = JSON.parse(rawText);
      item.providerId = typeof raw.id === 'string' ? raw.id.slice(0, 200) : null;
      item.finishReason = typeof raw.choices?.[0]?.finish_reason === 'string' ? raw.choices[0].finish_reason.slice(0, 80) : null;
      // Validate raw evidence BEFORE SDK normalization (SDK may otherwise default missing usage to zero).
      const { usage, evidence: rawEvidence } = parseProviderUsage(raw.usage);
      item.usageEvidence = rawEvidence;
      item.inputTokens = usage.inputTokens; item.outputTokens = usage.outputTokens;
      if ((openRouterSearchCount(raw.usage) ?? 0)>0 || raw.choices?.some((choice:any)=>choice.message?.annotations?.some((annotation:any)=>annotation.type==='url_citation'))) {
        throw new SliceRunError('OUTCOME_UNKNOWN');
      }
      if (!response.ok || raw.choices?.length !== 1 || !['stop','tool_calls'].includes(item.finishReason ?? '')) {
        if (item.finishReason === 'length') item.state = 'truncated';
        throw new SliceRunError(item.state === 'truncated' ? 'TRUNCATED' : 'OUTCOME_UNKNOWN');
      }
      item.state = 'responded';
      recorded = true;
      await input.recordCall(item); evidence.push(item);
      return new Response(rawText, { status: response.status, headers: {'content-type':'application/json'} });
    } catch (error) {
      // A transport or persistence failure never triggers a second provider attempt.
      boundaryFailure = error instanceof SliceRunError ? error : new SliceRunError('OUTCOME_UNKNOWN');
      // A failed durable write is ambiguous. The caller must read back that call
      // before recovery, rather than retrying a possibly committed write here.
      if (!recorded) await input.recordCall(item);
      throw boundaryFailure;
    }
  };
  const client = new OpenAI({apiKey: input.apiKey, baseURL:'https://openrouter.ai/api/v1', maxRetries:0, timeout:45000, fetch:guardedFetch});
  const model = new OpenAIChatCompletionsModel(client, input.model, {strictFeatureValidation:true});
  const read = tool({name:'read_selected_artifact', description:'Read the exact artifact explicitly selected for this execution. No arbitrary IDs or versions.',
    parameters:z.object({}).strict(), errorFunction:null,
    execute:async () => { if (++toolCalls > 1) throw new SliceRunError('CALL_LIMIT'); signal.throwIfAborted(); if (!input.readArtifact) throw new SliceRunError('CALL_LIMIT'); return input.readArtifact(); }});
  const agent = new Agent({name:'Selected Skill', model, instructions:input.instructions, tools:input.readArtifact ? [read] : [],
    modelSettings:{maxTokens:input.maxOutputTokens, parallelToolCalls:false, retry:{maxRetries:0}}});
  const runner = new Runner({tracingDisabled:true, traceIncludeSensitiveData:false, model});
  try {
    const result = await runner.run(agent, input.input, {maxTurns:input.readArtifact ? 2 : 1, signal});
    if (typeof result.finalOutput !== 'string' || !result.finalOutput.trim()) throw new SliceRunError('OUTCOME_UNKNOWN');
    return {body:result.finalOutput, calls:evidence, toolCalls};
  } catch (error) {
    // Never expose SDK run-state/errors: they can contain the private instructions or tool content.
    throw boundaryFailure ?? (error instanceof SliceRunError ? error : new SliceRunError('OUTCOME_UNKNOWN'));
  }
}
