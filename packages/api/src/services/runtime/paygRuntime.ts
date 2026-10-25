/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {MIN_ANSWER_TOKENS_AFTER_BUDGET} from '../../shared/modelReasoning';
import type {AgentTurnUnavailable} from '../../shared/agentTurn';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { frozenCallPolicy, type FrozenCall, type FrozenPaygRun } from '../bill2/service';
import { measureCallInput, openRouterCallBound } from '../bill2/openRouterPolicy';
import { paygStablePolicy } from '../bill2/paygPolicy';
import { validateNominalBound } from '../../shared/nominalPricing';
import { aggregateCredits } from '../bill2/decimal';
import { callBillingUnit } from './billingUnitAdmission';
import { IMAGE_PURPOSES, measureImage, type ImageQuote } from '../bill2/imageInput';

type StablePayg = z.infer<typeof paygStablePolicy>;
/** T for one request: the text bytes plus the image token ceiling (LIB-2d), never the base64 length. */
function measurePaygInput(request: string, stable: StablePayg, parsed: { messages?: unknown }) {
  const image: ImageQuote | null = measureImage(parsed, stable.imageInput);
  const measured = measureCallInput(request, stable.templateTokens, stable.marginTokens);
  const imageBytes = image?.dataUrlBytes ?? 0;
  return { image, bytes: measured.requestBytes, textBytes: measured.requestBytes - imageBytes,
    promptTokensUpper: measured.promptTokensUpper - imageBytes + (image?.tokensUpper ?? 0) };
}

export const resumeInput = z.object({
  executionId: z.string().uuid(), cursor: z.number().int().nonnegative(), epoch: z.number().int().nonnegative(),
}).strict();
export type ResumeInput = z.infer<typeof resumeInput>;
export type PaygWait = {
  state: 'waiting_credits' | 'waiting_resume';
  code: 'RUNTIME_NEW_CALLS_STOPPED' | 'RUNTIME_WAITING_CREDITS' | 'RUNTIME_WAITING_RESUME' | 'RUNTIME_USAGE_CONFIGURATION_REQUIRED';
  executionId: string; cursor: number; epoch: number; remainingCalls: number;
  body?: string; unavailable?: AgentTurnUnavailable;
  /** Internal: the frozen test window or model no longer admits this round, so it can never resume (paygResume.ts). */
  resumeClosed?: true;
};
export type PaygPosition = { cursor: number; epoch: number; remainingCalls: number };
/** A call's saved provider response, as runtime_response returns it. */
export type SavedResponse = { callId: string; state: string; rawBody: string | null; retryable?: boolean } | null;

/**
 * DB-PERF: which sequences a live PAYG owner can skip looking up. Beyond the calls that existed when it began
 * (remainingCalls counts every bill2 call of the run) and not a tool slot this invocation claimed, no response can be
 * saved: this owner's own main calls only move forward. Replay, recovery and v1 runs always look up.
 */
export function unsavedResponseSequence(isPayg: boolean,
  execution: { live: boolean; remainingCalls?: number; billing: { limits: { maxCalls: number } } },
  research: { claimedSubcall?(sequence: number): boolean } | null) {
  const existing = isPayg && execution.live && typeof execution.remainingCalls === 'number'
    ? execution.billing.limits.maxCalls - execution.remainingCalls : undefined;
  return (sequence: number) => existing !== undefined && sequence > existing && !research?.claimedSubcall?.(sequence);
}

/** Uses final provider bytes, after normalization and cache markers. No client quote is accepted. */
export function runtimePaygCall(request: string, phase: string,
  policy: z.infer<typeof frozenCallPolicy>, rules: FrozenPaygRun['rules'], epoch: number, nativeOutput = false) {
  const stable = paygStablePolicy.parse(policy.payg);
  const limits = policy.providerLimits;
  if (!limits || !stable.purposes.includes(phase)) throw new Error('BILL2_PAYG_QUOTE_INVALID');
  const parsed = JSON.parse(request);
  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const messages = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
  const schemaBytes = tools.reduce((sum: number, tool: { function?: { parameters?: unknown } }) => sum
    + (tool.function?.parameters === undefined ? 0 : Buffer.byteLength(JSON.stringify(tool.function.parameters))), 0)
    + (parsed.response_format === undefined ? 0 : Buffer.byteLength(JSON.stringify(parsed.response_format)));
  const { image, bytes, textBytes, promptTokensUpper } = measurePaygInput(request, stable, parsed);
  if (image && !IMAGE_PURPOSES.has(phase)) throw new Error('BILL2_IMAGE_DENIED');
  if (textBytes > stable.maxBytes || bytes > policy.inputLimit || messages < 1 || messages > stable.maxMessages
    || tools.length > stable.maxTools || schemaBytes > stable.maxSchemaBytes) throw new Error('BILL2_INPUT_PROFILE_INVALID');
  const outputLimit = nativeOutput ? requestOutputLimit(parsed, policy.outputLimit) : policy.outputLimit;
  const { upperUsd } = openRouterCallBound(limits, outputLimit, promptTokensUpper, image?.tokensUpper ?? 0);
  validateNominalBound(stable.nominalPricing, { ...limits, pricingHash: stable.pricingHash,
    endpointTag: stable.endpointTag, promptTokensUpper });
  const unit = callBillingUnit(rules, policy);
  if (!unit.billingUnit) throw new Error('BILL2_UNIT_MULTIPLIER_INVALID');
  const call: FrozenCall = {
    provider: policy.provider, account: policy.account, model: policy.model, protocol: policy.protocol,
    providerLimits: limits, requestHash: createHash('sha256').update(request).digest('hex'), upperUsd,
    inputLimit: policy.inputLimit, outputLimit, automaticRetry: false, hiddenTools: false,
    lookupSupported: policy.lookupSupported, phase, ...unit, runtimeEpoch: epoch,
    payg: { policyId: stable.policyId, policyVersion: stable.version, profileVersion: stable.profileVersion,
      evidenceVersion: stable.evidenceVersion, pricingHash: stable.pricingHash, endpointTag: stable.endpointTag,
      nominalPricing: stable.nominalPricing, templateTokens: stable.templateTokens, marginTokens: stable.marginTokens,
      bytes, promptTokensUpper, messages, tools: tools.length, schemaBytes, ...(image ? { image } : {}) },
  };
  return { call, upperCredits: aggregateCredits([upperUsd], rules.creditsPerUsd, unit.billingUnit.multiplier) };
}


function requestOutputLimit(parsed: Record<string, unknown>, quotedLimit: number): number {
  const value = parsed.max_tokens ?? parsed.max_completion_tokens;
  if ('max_tokens' in parsed && 'max_completion_tokens' in parsed
    || !Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > quotedLimit) {
    throw new Error('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY');
  }
  return Number(value);
}

/** New native PAYG only, before request hashing or claim. Old request bytes and quotes are untouched.
 * SQL bill2_payg_validate_quote permits O <= the stable quote; its T + O / U checks remain authoritative.
 * Non-PAYG quotes lack a frozen template/margin bound and cannot inherit invented fixture overhead. */
export function fitNativeRequestOutput(request: string, policy: z.infer<typeof frozenCallPolicy>): string {
  if (!policy.payg) return request;
  const stable = paygStablePolicy.parse(policy.payg);
  if (!policy.providerLimits) throw new Error('BILL2_PAYG_QUOTE_INVALID');
  const parsed = JSON.parse(request) as Record<string, unknown>;
  const originalLimit = requestOutputLimit(parsed, policy.outputLimit);
  const key = 'max_tokens' in parsed ? 'max_tokens' : 'max_completion_tokens';
  const reasoning = parsed.reasoning as {max_tokens?: unknown} | undefined;
  const minimum = Number.isSafeInteger(reasoning?.max_tokens)
    ? Number(reasoning!.max_tokens) + MIN_ANSWER_TOKENS_AFTER_BUDGET : 1;
  const fits = (body: string, output: number) => measurePaygInput(body, stable, JSON.parse(body))
    .promptTokensUpper + output <= policy.providerLimits!.contextTokens;
  if (originalLimit >= minimum && fits(request, originalLimit)) return request;
  const serialize = (output: number) => JSON.stringify({...parsed, [key]: output});
  if (minimum > originalLimit || !fits(serialize(minimum), minimum)) {
    throw new Error('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY');
  }
  let low = minimum;
  let high = originalLimit;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(serialize(middle), middle)) low = middle;
    else high = middle - 1;
  }
  return serialize(low);
}
