/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// AC-0b model probe. Standalone script: application code must never import it.
import {createHash} from 'node:crypto';
import {normalizeCandidateRequestHistory} from './agentTurn.ts';
import {isDeepStrictEqual} from 'node:util';
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
  dataCollection: 'deny' | 'omitted';
  boundUsd: number;
  /** Amount booked against the caps. */
  costUsd?: number;
  costSource?: CostSource;
  /** OpenRouter's reported usage.cost, when present. */
  providerCostUsd?: number;
  /** Both token counts priced at max_price, when both are present. */
  tokenCostUsd?: number;
  /** providerCostUsd and tokenCostUsd differ; the larger one was booked. */
  costDisagreement?: boolean;
  facts: StreamFacts;
};

/** Refuses to hand any body to the network unless it carries data_collection deny. */
export function assertDataCollectionDenied(body: unknown): void {
  const provider = (body as {provider?: {data_collection?: unknown}} | null)?.provider;
  if (provider?.data_collection !== 'deny') throw new Error('PROBE_DATA_COLLECTION_NOT_DENIED');
}

/** The data_collection check for one config: deny unless the config explicitly
 * omits it (built-in only, Owner decision 2026-09-28), and then no field at all. */
export function assertDataCollection(body: unknown, config: ProbeConfig): void {
  if (config.dataCollection !== 'omit') return assertDataCollectionDenied(body);
  const provider = (body as {provider?: Record<string, unknown>} | null)?.provider;
  if (!provider || 'data_collection' in provider) throw new Error('PROBE_DATA_COLLECTION_NOT_OMITTED');
}

function denied(reason: string): never {
  throw new Error('PROBE_REQUEST_DENIED:' + reason);
}

function checkBody(body: Record<string, unknown>, config: ProbeConfig, maxTokens: number): void {
  if (body.model !== config.model) denied('model');
  if (body.stream !== true || (body.stream_options as {include_usage?: unknown})?.include_usage !== true) denied('stream');
  if (body.store !== false) denied('store');
  // Thinking is sent exactly as configured, in exactly one of the two forms.
  if (config.reasoning) {
    if ('reasoning_effort' in body || !isDeepStrictEqual(body.reasoning, config.reasoning)) denied('reasoning');
  } else if ('reasoning' in body || body.reasoning_effort !== config.effort) {
    denied('reasoning');
  }
  if (body.max_tokens !== maxTokens || 'max_completion_tokens' in body) denied('max_tokens');
  // Routing is added here only, so nothing upstream can weaken it.
  if ('provider' in body) denied('provider');
  const tools = body.tools === undefined ? [] : body.tools;
  if (!Array.isArray(tools)) denied('tools');
  for (const tool of tools as Array<{function?: {name?: unknown}}>) {
    if (!PROBE_TOOL_NAMES.includes(String(tool?.function?.name))) denied('tool_name');
  }
  // Routes that do not declare parallel_tool_calls are excluded under
  // require_parameters, so the field must never be sent (trial.ts).
  if ('parallel_tool_calls' in body) denied('parallel_tool_calls');
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

  function settleRecord(record: CallRecord, settle: (nano: number) => void, status: CallStatus, source: CostSource, usd: number) {
    record.status = status;
    record.costSource = source;
    const nano = usdToNano(usd);
    record.costUsd = nanoToUsd(nano);
    settle(nano);
  }

  /** Booked cost of a completed call: the larger of OpenRouter's reported cost
   * and both token counts at max_price; one of them alone; otherwise the bound.
   * An unknown or unfinished call always keeps its full bound. */
  function completedCost(record: CallRecord): {usd: number; source: CostSource} {
    const usage = record.facts.usage;
    const provider = usage?.costUsd;
    const {prompt, completion} = options.config.maxPrice;
    const tokens = usage?.promptTokens !== undefined && usage.completionTokens !== undefined
      ? (usage.promptTokens * prompt + usage.completionTokens * completion) / 1_000_000 : undefined;
    if (provider !== undefined) record.providerCostUsd = provider;
    if (tokens !== undefined) record.tokenCostUsd = nanoToUsd(usdToNano(tokens));
    if (provider !== undefined && tokens !== undefined) {
      if (usdToNano(provider) !== usdToNano(tokens)) record.costDisagreement = true;
      return provider >= tokens ? {usd: provider, source: 'provider'} : {usd: tokens, source: 'tokens_at_max_price'};
    }
    if (provider !== undefined) return {usd: provider, source: 'provider'};
    if (tokens !== undefined) return {usd: tokens, source: 'tokens_at_max_price'};
    return {usd: record.boundUsd, source: 'upper_bound'};
  }

  async function probeFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (String(url) !== LOCAL_URL || init?.method !== 'POST') denied('url');
    if (state.stopped) throw new Error('PROBE_TRIAL_STOPPED:' + state.stopped);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    checkBody(body, options.config, options.maxTokens);
    if (options.config.runtimeRouting) normalizeCandidateRequestHistory(body);
    body.provider = routing(options.config);
    const bytes = JSON.stringify(body);
    assertDataCollection(JSON.parse(bytes), options.config);
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
      dataCollection: options.config.dataCollection === 'omit' ? 'omitted' : 'deny', boundUsd: nanoToUsd(usdToNano(boundUsd)), facts: facts.facts,
    };
    records.push(record);
    const signal = AbortSignal.timeout(options.timeoutMs);
    const unknown = (code: string, error?: unknown) => {
      if (record.status !== 'in_flight') return;
      record.errorCode = code;
      if (error instanceof Error) record.errorMessage = options.redact(error.message).slice(0, 300);
      record.totalMs = options.clock() - started;
      state.stopped = 'unknown_result';
      if (facts.facts.usage?.costUsd !== undefined) record.providerCostUsd = facts.facts.usage.costUsd;
      settleRecord(record, settle, 'unknown', 'upper_bound', record.boundUsd);
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
        settleRecord(record, settle, 'rejected', 'not_billed', 0);
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
            const cost = completedCost(record);
            settleRecord(record, settle, 'ok', cost.source, cost.usd);
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
