/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {AgentTurnUnavailable} from '../../shared/agentTurn';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { frozenCallPolicy, type FrozenCall, type FrozenPaygRun } from '../bill2/service';
import { measureCallInput, openRouterCallBound } from '../bill2/openRouterPolicy';
import { paygStablePolicy } from '../bill2/paygPolicy';
import { validateNominalBound } from '../../shared/nominalPricing';
import { aggregateCredits } from '../bill2/decimal';
import { callBillingUnit } from './billingUnitAdmission';

export const resumeInput = z.object({
  executionId: z.string().uuid(), cursor: z.number().int().nonnegative(), epoch: z.number().int().nonnegative(),
}).strict();
export type ResumeInput = z.infer<typeof resumeInput>;
export type PaygWait = {
  state: 'waiting_credits' | 'waiting_resume';
  code: 'RUNTIME_WAITING_CREDITS' | 'RUNTIME_WAITING_RESUME' | 'RUNTIME_USAGE_CONFIGURATION_REQUIRED';
  executionId: string; cursor: number; epoch: number; remainingCalls: number;
  body?: string; unavailable?: AgentTurnUnavailable;
};
export type PaygPosition = { cursor: number; epoch: number; remainingCalls: number };

/** Uses final provider bytes, after normalization and cache markers. No client quote is accepted. */
export function runtimePaygCall(request: string, phase: string,
  policy: z.infer<typeof frozenCallPolicy>, rules: FrozenPaygRun['rules'], epoch: number) {
  const stable = paygStablePolicy.parse(policy.payg);
  const limits = policy.providerLimits;
  if (!limits || !stable.purposes.includes(phase)) throw new Error('BILL2_PAYG_QUOTE_INVALID');
  const parsed = JSON.parse(request);
  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const messages = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
  const schemaBytes = tools.reduce((sum: number, tool: { function?: { parameters?: unknown } }) => sum
    + (tool.function?.parameters === undefined ? 0 : Buffer.byteLength(JSON.stringify(tool.function.parameters))), 0)
    + (parsed.response_format === undefined ? 0 : Buffer.byteLength(JSON.stringify(parsed.response_format)));
  const { requestBytes: bytes, promptTokensUpper } = measureCallInput(request, stable.templateTokens, stable.marginTokens);
  if (bytes > stable.maxBytes || bytes > policy.inputLimit || messages < 1 || messages > stable.maxMessages
    || tools.length > stable.maxTools || schemaBytes > stable.maxSchemaBytes) throw new Error('BILL2_INPUT_PROFILE_INVALID');
  const { upperUsd } = openRouterCallBound(limits, policy.outputLimit, promptTokensUpper);
  validateNominalBound(stable.nominalPricing, { ...limits, pricingHash: stable.pricingHash,
    endpointTag: stable.endpointTag, promptTokensUpper });
  const unit = callBillingUnit(rules, policy);
  if (!unit.billingUnit) throw new Error('BILL2_UNIT_MULTIPLIER_INVALID');
  const call: FrozenCall = {
    provider: policy.provider, account: policy.account, model: policy.model, protocol: policy.protocol,
    providerLimits: limits, requestHash: createHash('sha256').update(request).digest('hex'), upperUsd,
    inputLimit: policy.inputLimit, outputLimit: policy.outputLimit, automaticRetry: false, hiddenTools: false,
    lookupSupported: policy.lookupSupported, phase, ...unit, runtimeEpoch: epoch,
    payg: { policyId: stable.policyId, policyVersion: stable.version, profileVersion: stable.profileVersion,
      evidenceVersion: stable.evidenceVersion, pricingHash: stable.pricingHash, endpointTag: stable.endpointTag,
      nominalPricing: stable.nominalPricing, templateTokens: stable.templateTokens, marginTokens: stable.marginTokens,
      bytes, promptTokensUpper, messages, tools: tools.length, schemaBytes },
  };
  return { call, upperCredits: aggregateCredits([upperUsd], rules.creditsPerUsd, unit.billingUnit.multiplier) };
}
