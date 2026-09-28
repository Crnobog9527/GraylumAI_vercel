/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { openRouterStream, OPENROUTER_STREAM_BYTE_LIMIT } from '../bill2/openRouterStream';
import {
  MIN_ANSWER_TOKENS_AFTER_BUDGET, MIN_MAX_TOKENS_WITH_THINKING, PURPOSE_LABELS,
  checkReasoningConfig, readReasoningConfig, reasoningRequestFields, type PurposeSetting, type ReasoningPurpose,
} from '../../shared/modelReasoning';
import { runtimeModelOption, type RuntimeModelRow } from './runtimeEligibility';

/** "Try once" (MODEL-REASONING ⑥): one real, platform-paid call with a fixed
 * short question, on the configured route with the purpose's reasoning setting.
 * It is not billed through BILL2 and returns measurements only, never text. */
export const TRY_PROMPT = '请用一句话介绍你自己。';
export const TRY_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const TRY_TIMEOUT_MS = 60_000;
/** Output allowance with thinking off or at the provider's non-thinking default. */
export const TRY_PLAIN_MAX_TOKENS = 256;

export type TryResult = {
  ok: boolean;
  httpStatus: number | null;
  /** From sending the request to the first answer text. */
  firstTextMs: number | null;
  totalMs: number;
  hasText: boolean;
  finishReason: string | null;
  /** The output limit cut the reply; thinking may have used it up. */
  truncated: boolean;
  reasoningTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  maxTokens: number;
  error: string | null;
  /** The provider's own error text, bounded; never request data or credentials. */
  providerMessage: string | null;
};

/** The setting a purpose uses: an unset organizer means the provider default. */
export function purposeSettingFor(purpose: ReasoningPurpose, setting: PurposeSetting | undefined): PurposeSetting | null {
  if (setting) return setting;
  return purpose === 'organize' ? { mode: 'provider_default' } : null;
}

/** Allowance per MODEL-REASONING ⑤ so thinking cannot use up the whole reply. */
export function tryMaxTokens(setting: PurposeSetting, defaultThinking: boolean, modelMaxTokens: number): number {
  const wanted = setting.mode === 'budget' ? setting.maxTokens + MIN_ANSWER_TOKENS_AFTER_BUDGET
    : setting.mode === 'effort' && setting.effort !== 'none' ? MIN_MAX_TOKENS_WITH_THINKING
    : setting.mode === 'provider_default' && defaultThinking ? MIN_MAX_TOKENS_WITH_THINKING
    : TRY_PLAIN_MAX_TOKENS;
  return Math.min(wanted, modelMaxTokens);
}

export class TryRefused extends Error {}

/** Builds the exact request, or refuses with an administrator-readable reason before any call. */
export function tryRequest(row: RuntimeModelRow, purpose: ReasoningPurpose) {
  const eligible = runtimeModelOption(row, 'organizer');
  if (!eligible.available) throw new TryRefused(eligible.reason ?? '模型配置不完整');
  const config = readReasoningConfig(row.config), maxTokens = Number(row.max_tokens);
  const issues = checkReasoningConfig(config, { maxTokens, modelId: row.model_id });
  if (issues.length) throw new TryRefused('思考设置需要处理：' + issues[0]!.message);
  if (!config.route) throw new TryRefused('请先选择供应商线路');
  const setting = purposeSettingFor(purpose, config.purposes[purpose]);
  if (!setting) throw new TryRefused(`"${PURPOSE_LABELS[purpose]}"还没有设置思考方式`);
  const limit = tryMaxTokens(setting, config.catalog?.reasoning?.defaultEnabled !== false, maxTokens);
  const body = {
    model: row.model_id,
    messages: [{ role: 'user', content: TRY_PROMPT }],
    max_tokens: limit,
    stream: true,
    stream_options: { include_usage: true },
    provider: { only: [config.route], allow_fallbacks: false, require_parameters: true },
    ...reasoningRequestFields(setting),
  };
  return { body, maxTokens: limit };
}

const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Sends the request once, reads the bounded stream and measures it. No retry. */
export async function tryReasoning(row: RuntimeModelRow, purpose: ReasoningPurpose, transport: typeof fetch = fetch,
  clock: () => number = () => performance.now()): Promise<TryResult> {
  const { body, maxTokens } = tryRequest(row, purpose);
  const started = clock();
  let firstTextMs: number | null = null;
  const base = { maxTokens, firstTextMs: null, hasText: false, finishReason: null, truncated: false,
    reasoningTokens: null, completionTokens: null, costUsd: null };
  let response: Response;
  try {
    response = await transport(TRY_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TRY_TIMEOUT_MS),
      headers: { Authorization: 'Bearer ' + row.api_key!.trim(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    return { ...base, ok: false, httpStatus: null, totalMs: Math.round(clock() - started), error: 'TRANSPORT_FAILED', providerMessage: null };
  }
  if (!response.ok) {
    let providerMessage: string | null = null;
    try {
      const text = (await response.text()).slice(0, 65536);
      const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
      providerMessage = typeof message === 'string' ? message.slice(0, 300) : null;
    } catch { /* The status alone is reported. */ }
    return { ...base, ok: false, httpStatus: response.status, totalMs: Math.round(clock() - started), error: 'HTTP_' + response.status, providerMessage };
  }
  const stream = openRouterStream(String(body.model), response.headers.get('x-generation-id') ?? undefined, chunk => {
    if (firstTextMs !== null) return;
    try {
      const delta = (JSON.parse(chunk) as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.trim()) firstTextMs = Math.round(clock() - started);
    } catch { /* The stream parser reports malformed frames itself. */ }
  });
  const reader = response.body?.getReader(), decoder = new TextDecoder();
  let bytes = 0, interrupted = false;
  try {
    for (;;) {
      if (!reader) break;
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > OPENROUTER_STREAM_BYTE_LIMIT) { interrupted = true; break; }
      stream.push(decoder.decode(part.value, { stream: true }));
    }
    stream.push(decoder.decode());
  } catch {
    interrupted = true;
  } finally {
    await reader?.cancel().catch(() => {});
  }
  const result = stream.result(), totalMs = Math.round(clock() - started);
  if (interrupted || !result.sdkResponse)
    return { ...base, firstTextMs, ok: false, httpStatus: response.status, totalMs,
      error: interrupted ? 'STREAM_INTERRUPTED' : 'STREAM_INVALID', providerMessage: null };
  const choice = result.sdkResponse.choices[0]!, usage = (result.sdkResponse.usage ?? {}) as Record<string, unknown>;
  const details = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  const text = typeof choice.message.content === 'string' ? choice.message.content : '';
  return {
    ok: true, httpStatus: response.status, firstTextMs, totalMs, maxTokens,
    hasText: text.trim().length > 0, finishReason: choice.finish_reason, truncated: choice.finish_reason === 'length',
    reasoningTokens: count(details.reasoning_tokens), completionTokens: count(usage.completion_tokens), costUsd: count(usage.cost),
    error: null, providerMessage: null,
  };
}
