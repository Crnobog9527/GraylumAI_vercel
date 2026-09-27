/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {createHash} from 'node:crypto';
import {BudgetStop, usdToNano, nanoToUsd, type Budget} from './budget.ts';
import {callBoundUsd, routing, type ProbeConfig} from './config.ts';
import {streamObserver, type StreamFacts} from './sse.ts';

export const LOCAL_BASE_URL = 'http://127.0.0.1/ac0';
const LOCAL_URL = LOCAL_BASE_URL + '/chat/completions';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const PROBE_TOOL_NAMES = ['ask_question', 'read_reference'];
/** Rejections OpenRouter returns before generation starts; they are not billed. */
const UNBILLED_STATUSES = new Set([400, 401, 402, 403, 404, 413, 422, 429]);

export type Upstream = (url: string, init: RequestInit) => Promise<Response>;
export type CallStatus = 'ok' | 'rejected' | 'unknown';
export type CostSource = 'provider' | 'tokens_at_max_price' | 'upper_bound' | 'not_billed';
export type CallRecord = {
  sequence: number;
  status: CallStatus | 'in_flight';
  /** Milliseconds from trial start to the moment the request was sent. */
  sentAtMs: number;
  headersMs?: number;
  totalMs?: number;
  httpStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  requestBytes: number;
  dataCollection: 'deny';
  boundUsd: number;
  costUsd?: number;
  costSource?: CostSource;
  facts: StreamFacts;
};

/** Refuses to hand any body to the network unless it carries data_collection deny. */
export function assertDataCollectionDenied(body: unknown): void {
  const provider = (body as {provider?: {data_collection?: unknown}} | null)?.provider;
  if (provider?.data_collection !== 'deny') throw new Error('PROBE_DATA_COLLECTION_NOT_DENIED');
}

function denied(reason: string): never {
  throw new Error('PROBE_REQUEST_DENIED:' + reason);
}

function checkBody(body: Record<string, unknown>, config: ProbeConfig, maxTokens: number): void {
  if (body.model !== config.model) denied('model');
  if (body.stream !== true || (body.stream_options as {include_usage?: unknown})?.include_usage !== true) denied('stream');
  if (body.store !== false) denied('store');
  if ('reasoning' in body || body.reasoning_effort !== config.effort) denied('reasoning');
  if (body.max_tokens !== maxTokens || 'max_completion_tokens' in body) denied('max_tokens');
  // Routing is added here only, so nothing upstream can weaken it.
  if ('provider' in body) denied('provider');
  const tools = body.tools === undefined ? [] : body.tools;
  if (!Array.isArray(tools)) denied('tools');
  for (const tool of tools as Array<{function?: {name?: unknown}}>) {
    if (!PROBE_TOOL_NAMES.includes(String(tool?.function?.name))) denied('tool_name');
  }
  if (tools.length && body.parallel_tool_calls !== false) denied('parallel_tool_calls');
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < limit) {
      const part = await reader.read();
      if (part.done) break;
      text += decoder.decode(part.value, {stream: true});
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text.slice(0, limit);
}

function providerMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as {error?: {message?: unknown}};
    if (typeof parsed.error?.message === 'string') return parsed.error.message.slice(0, 300);
  } catch { /* not JSON */ }
  return text.slice(0, 300);
}

/** One trial's fetch for the OpenAI client. Every provider request passes the
 * checks, the budget reservation and the routing here, exactly once. After a
 * call whose outcome is unknown, the trial may not send again. */
export function probeTransport(options: {
  config: ProbeConfig;
  maxTokens: number;
  timeoutMs: number;
  budget: Budget;
  upstream: Upstream;
  authorization: string;
  clock: () => number;
  trialStart: number;
  redact: (text: string) => string;
}) {
  const records: CallRecord[] = [];
  const abandon = new Map<CallRecord, (code: string) => void>();
  const sentHashes = new Set<string>();
  const state: {stopped: string | null; budgetStop: string | null; httpStatus: number | null} = {
    stopped: null, budgetStop: null, httpStatus: null,
  };

  function settleRecord(record: CallRecord, settle: (nano: number) => void, status: CallStatus, source: CostSource) {
    const usage = record.facts.usage;
    let usd = record.boundUsd;
    if (source === 'not_billed') usd = 0;
    else if (source === 'provider' && usage?.costUsd !== undefined) usd = usage.costUsd;
    else if (source === 'tokens_at_max_price' && usage) {
      const {prompt, completion} = options.config.maxPrice;
      usd = ((usage.promptTokens ?? 0) * prompt + (usage.completionTokens ?? 0) * completion) / 1_000_000;
    }
    record.status = status;
    record.costSource = source;
    const nano = usdToNano(usd);
    record.costUsd = nanoToUsd(nano);
    settle(nano);
  }

  function costSource(facts: StreamFacts, fallback: CostSource): CostSource {
    if (facts.usage?.costUsd !== undefined) return 'provider';
    if (fallback !== 'upper_bound' && facts.usage?.promptTokens !== undefined) return 'tokens_at_max_price';
    return fallback;
  }

  async function probeFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (String(url) !== LOCAL_URL || init?.method !== 'POST') denied('url');
    if (state.stopped) throw new Error('PROBE_TRIAL_STOPPED:' + state.stopped);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    checkBody(body, options.config, options.maxTokens);
    body.provider = routing(options.config);
    const bytes = JSON.stringify(body);
    assertDataCollectionDenied(JSON.parse(bytes));
    const hash = createHash('sha256').update(bytes).digest('hex');
    // With retries disabled every request is a new turn; an identical body is a resend.
    if (sentHashes.has(hash)) denied('duplicate');
    const requestBytes = Buffer.byteLength(bytes);
    const boundUsd = callBoundUsd(options.config, requestBytes, options.maxTokens);
    let settle: (nano: number) => void;
    try {
      settle = options.budget.reserve(usdToNano(boundUsd));
    } catch (error) {
      if (error instanceof BudgetStop) state.budgetStop = error.reason;
      state.stopped = 'budget';
      throw error;
    }
    sentHashes.add(hash);
    const started = options.clock();
    const facts = streamObserver(() => options.clock() - started);
    const record: CallRecord = {
      sequence: records.length + 1, status: 'in_flight', sentAtMs: started - options.trialStart, requestBytes,
      dataCollection: 'deny', boundUsd: nanoToUsd(usdToNano(boundUsd)), facts: facts.facts,
    };
    records.push(record);
    const signal = AbortSignal.timeout(options.timeoutMs);
    const unknown = (code: string, error?: unknown) => {
      if (record.status !== 'in_flight') return;
      record.errorCode = code;
      if (error instanceof Error) record.errorMessage = options.redact(error.message).slice(0, 300);
      record.totalMs = options.clock() - started;
      state.stopped = 'unknown_result';
      settleRecord(record, settle, 'unknown', costSource(facts.facts, 'upper_bound'));
    };
    abandon.set(record, unknown);
    let response: Response;
    try {
      response = await options.upstream(OPENROUTER_URL, {
        method: 'POST', redirect: 'error', body: bytes, signal,
        headers: {Authorization: options.authorization, 'Content-Type': 'application/json'},
      });
    } catch (error) {
      unknown(signal.aborted ? 'timeout' : 'network_error', error);
      throw new Error('PROBE_CALL_UNKNOWN');
    }
    record.httpStatus = response.status;
    record.headersMs = options.clock() - started;
    if (!response.ok || !response.body) {
      const text = options.redact(await boundedText(response, 4096).catch(() => ''));
      record.errorMessage = providerMessage(text);
      state.httpStatus = response.status;
      if (UNBILLED_STATUSES.has(response.status)) {
        record.errorCode = 'http_' + response.status;
        record.totalMs = options.clock() - started;
        state.stopped = 'provider_rejected';
        settleRecord(record, settle, 'rejected', 'not_billed');
      } else {
        unknown('http_' + response.status);
      }
      throw new Error('PROBE_HTTP_' + response.status);
    }
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try {
          part = await reader.read();
        } catch (error) {
          unknown(signal.aborted ? 'timeout' : 'stream_interrupted', error);
          controller.error(new Error('PROBE_CALL_UNKNOWN'));
          return;
        }
        if (part.done) {
          const final = facts.end();
          if (!final.done || !final.finishReason || final.streamError) {
            unknown(final.streamError ? 'provider_stream_error' : 'incomplete_stream');
          } else {
            record.totalMs = options.clock() - started;
            settleRecord(record, settle, 'ok', costSource(final, 'tokens_at_max_price'));
          }
          controller.close();
          return;
        }
        facts.push(part.value);
        controller.enqueue(part.value);
      },
      async cancel() {
        await reader.cancel().catch(() => {});
        unknown('consumer_cancelled');
      },
    });
    return new Response(stream, {status: 200, headers: {'content-type': 'text/event-stream'}});
  }

  /** Called when a trial ends: an unfinished call keeps its full upper bound. */
  function close() {
    for (const record of records) abandon.get(record)?.('not_finished');
  }

  return {fetch: probeFetch, records, state, close};
}
export type ProbeTransport = ReturnType<typeof probeTransport>;
