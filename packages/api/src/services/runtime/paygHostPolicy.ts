/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { reasoningPolicy, frozenReasoningFields, type ReasoningPolicy } from './reasoningPolicy';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FrozenRun } from '../bill2/service';
import { PAYG_MAX_TOOLS } from '../bill2/paygPolicy';
import { stagingRuntimeWindow } from './stagingEnvironment';
import type { StagingPolicy } from './stagingPolicy';
import { StagingAccessError } from './stagingErrors';
import { PURPOSE_OUTPUT_CAP } from './purposeBudgets';

export const PAYG_HOST_SETTING = 'runtime_payg_staging';
/** Per-request byte cap of every per-call billing profile (a request above it cannot be claimed). */
export const PAYG_PROFILE_MAX_BYTES = 196608;
const reference = z.string().trim().min(1).max(128);
const admittedRoutes: Readonly<Record<string,string>> = {
  'anthropic/claude-sonnet-5.5':'anthropic',
  'google/gemini-3.8-flash':'google-ai-studio',
  'openai/gpt-6-luna':'openai',
  // FUSION-REVIEW panel (Owner 2026-10-17): Sol as a reviewer, Opus as the summary. A route here only allows
  // a profile; admission still needs a profile entry with evidence for the purpose, format and reasoning.
  'openai/gpt-6.1-sol':'openai',
  'anthropic/claude-opus-5.5':'anthropic',
};
// fusion_review / fusion_summary: FUSION-REVIEW per-model calls, claimed only as a billing group (0234).
// fusion_compare: FUSION-COMPARE columns (0290), one plain-text streamed answer per model; its profile entry and
// evidence come with FUSION-COMPARE PR-4.
const phase = z.enum(['ordinary', 'skill', 'organizer', 'skill_matching', 'attached_organizer', 'report',
  'fusion_review', 'fusion_summary', 'fusion_compare']);
const sharedEvidence = {
  maxPromptToBytes: z.number().positive().max(0.7), maxPromptToUpper: z.number().positive().max(0.7),
  outputLimit: z.number().int().positive().max(PURPOSE_OUTPUT_CAP),
  testedOutputLimit: z.number().int().positive().max(PURPOSE_OUTPUT_CAP),
  outputSemantics: z.literal('max-tokens-includes-reasoning'),
  includesReasoning: z.literal(true), cacheCovered: z.literal(true), costBoundPassed: z.literal(true),
};
const FUSION_PURPOSES: ReadonlySet<string> = new Set(['fusion_review', 'fusion_summary']);
/** FUSION-PROFILE (Owner 2026-10-17, plan B): evidence taken on the real Fusion wire (fusionRequestBody: system + user,
 * Chinese report and JSON material, strict JSON-schema output, no tools, two messages) in two size bands, the larger
 * one near the per-call byte cap. Accepted only for a profile whose every purpose is a Fusion purpose and whose only
 * request format is fusion-json-v1-stream; every other purpose keeps requiring the full #665 matrix. The byte, cost
 * and output-semantics checks are the same as the matrix's. */
const fusionShapeEvidence = z.object({
  scope: z.literal('fusion-request-shape'), reference, manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  distinctSamples: z.number().int().min(4), sizeBands: z.literal(2),
  maxVerifiedBytes: z.number().int().min(180000).max(PAYG_PROFILE_MAX_BYTES),
  ...sharedEvidence,
}).strict();
/** Trusted admin configuration, never a browser admission field. Evidence references
 * must identify independently checked real samples; fixture results are not evidence. */
// Small-cap probes establish truncation semantics; outputLimit is the separately authorized profile cap.
// Direct variants need two length receipts. The approved Sonnet low exception references same-route none evidence.
export const paygHostProfile = z.object({
  model: reference, endpointTag: reference, protocol: z.literal('openrouter-chat-v1'),
  profileVersion: reference, evidenceVersion: reference,
  admissionPath: z.literal('empirical'),
  templateTokens: z.literal(4096), marginTokens: z.literal(4096),
  maxBytes: z.literal(PAYG_PROFILE_MAX_BYTES), maxMessages: z.literal(128),
  // 2 until the staging profiles are updated (0250, 0267); a smaller profile leaves the optional tools out.
  maxTools: z.number().int().min(2).max(PAYG_MAX_TOOLS), maxSchemaBytes: z.literal(16384),
  purposes: z.array(phase).min(1).max(8),
  requestFormats: z.array(z.enum(['serial-tools-v2', 'serial-tools-v4-stream',
    'agent-turn-v5-stream', 'serial-tools-v6-reasoning', 'fusion-json-v1-stream', 'fusion-text-v1-stream'])).min(1).max(6),
  reasoningVariants: z.array(z.object({
    reasoning: reasoningPolicy,
    outputLimit: z.number().int().positive().max(PURPOSE_OUTPUT_CAP),
    testedOutputLimit: z.number().int().positive().max(PURPOSE_OUTPUT_CAP),
    evidenceReference: reference, manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    outputStressSamples: z.number().int().min(0), includesReasoning: z.literal(true),
    outputSemanticsEvidence: z.literal('same-route-none').optional(),
  }).strict()).min(1).max(16),
  outputLimit: z.number().int().min(1).max(PURPOSE_OUTPUT_CAP),
  expiresAt: z.string().datetime(),
  evidence: z.union([z.object({
    reference, manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    distinctSamples: z.literal(60), messageStressSamples: z.literal(12), maxVerifiedMessages: z.literal(128),
    completeCells: z.literal(15), variantsPerCell: z.literal(4),
    ...sharedEvidence,
  }).strict(), fusionShapeEvidence]),
}).strict().refine(p => !('scope' in p.evidence) || (p.purposes.every(purpose => FUSION_PURPOSES.has(purpose))
  && p.requestFormats.length === 1 && p.requestFormats[0] === 'fusion-json-v1-stream'),
{ message: 'PAYG_FUSION_EVIDENCE_SCOPE' }).refine(p => p.outputLimit <= p.evidence.outputLimit
  && p.reasoningVariants.every(v => v.outputLimit <= p.evidence.outputLimit
    && v.testedOutputLimit === p.evidence.testedOutputLimit),
{ message: 'PAYG_OUTPUT_EVIDENCE_REQUIRED' }).refine(p => p.reasoningVariants.every(v => {
  if (!v.outputSemanticsEvidence) return v.outputStressSamples >= 2;
  return p.model === 'anthropic/claude-sonnet-5.5' && p.endpointTag === 'anthropic'
    && isDeepStrictEqual(v.reasoning, {effort:'low'}) && v.outputStressSamples === 0 && v.testedOutputLimit === 2048
    && p.reasoningVariants.some(source => !source.outputSemanticsEvidence
      && isDeepStrictEqual(source.reasoning, {parameter:'none'}) && source.outputStressSamples >= 2
      && source.testedOutputLimit === 2048 && source.outputLimit >= v.outputLimit
      && source.evidenceReference === v.evidenceReference && source.manifestHash === v.manifestHash);
}), { message: 'PAYG_SAME_ROUTE_NONE_EVIDENCE_REQUIRED' });
export const paygHostSettings = z.object({
  version: z.literal(1), enabled: z.boolean(), windowId: z.string().uuid(),
  profiles: z.array(paygHostProfile).max(16),
}).strict();
// A minimal object can always disable new admissions, regardless of stale evidence.
export const paygHostSettingWrite = z.union([z.object({enabled:z.literal(false)}).strict(), paygHostSettings]);
export type PaygHostProfile = z.infer<typeof paygHostProfile>;
type Requirement = { modelId: string; phase: z.infer<typeof phase>; outputLimit: number; requestFormat: string; reasoning?: ReasoningPolicy };

/** Called only for NEW real admissions, after admission replay and pending organizer recovery.
 * Off/missing -> v1. An enabled but invalid configuration refuses admission, never silently bills v1.
 * Do not call from execute/resume: their frozen contract is the only billing authority. */
export async function readPaygHostPolicies(admin: SupabaseClient, window: StagingPolicy,
  policies: FrozenRun['callPolicy'], requirements: Requirement[], env: Record<string, string | undefined> = process.env,
  deadline: string = window.expiresAt,
) {
  if (stagingRuntimeWindow(env) !== window.id) throw new StagingAccessError('RUNTIME_STAGING_TARGET_DENIED');
  const { data, error } = await admin.from('system_settings').select('value').eq('key', PAYG_HOST_SETTING).maybeSingle();
  if (error) throw new StagingAccessError('RUNTIME_PAYG_CONFIG_UNAVAILABLE');
  if (!data || data.value === null) return undefined;
  let value:unknown=data.value;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw new StagingAccessError('RUNTIME_PAYG_PROFILE_REQUIRED');}}
  // Turning off remains possible even if profile evidence has expired or is incomplete.
  if (value !== null && typeof value === 'object' && 'enabled' in value && value.enabled === false) return undefined;
  const parsed = paygHostSettings.safeParse(value);
  if (!parsed.success || parsed.data.windowId !== window.id) throw new StagingAccessError('RUNTIME_PAYG_PROFILE_REQUIRED');
  const config = parsed.data;
  if (!config.enabled) return undefined;
  return policies.map(policy => {
    const matches = config.profiles.filter(p => p.model === policy.model && p.endpointTag === policy.providerLimits?.providerSlug);
    const profile = matches.length === 1 ? matches[0] : undefined;
    const uses = requirements.filter(r => r.modelId === policy.modelId);
    if (!profile || admittedRoutes[profile.model] !== profile.endpointTag || policy.protocol !== profile.protocol || !policy.providerLimits || !uses.length
      || Date.parse(profile.expiresAt) <= Date.now() || Date.parse(profile.expiresAt) < Date.parse(deadline)
      || profile.maxBytes + profile.templateTokens + profile.marginTokens + profile.outputLimit > policy.providerLimits.contextTokens
      || uses.some(r => !profile.purposes.includes(r.phase) || !profile.requestFormats.some(format => format === r.requestFormat)
        || !profile.reasoningVariants.some(v => isDeepStrictEqual(frozenReasoningFields(v.reasoning), frozenReasoningFields(r.reasoning))
          && v.outputLimit >= r.outputLimit && v.outputLimit <= profile.evidence.outputLimit)
        || r.outputLimit > profile.outputLimit)) throw new StagingAccessError('RUNTIME_PAYG_PROFILE_REQUIRED');
    // Retain the window's exact quote (SQL compares entry-minus-payg). Actual request O
    // is already capped by admission and is remeasured before every claim.
    return { ...policy, payg: {
      version: 'staging-host-v1', policyId: window.id, profileVersion: profile.profileVersion,
      evidenceVersion: profile.evidenceVersion, admissionPath: profile.admissionPath,
      templateTokens: profile.templateTokens, marginTokens: profile.marginTokens,
      maxBytes: profile.maxBytes, maxMessages: profile.maxMessages,
      maxTools: profile.maxTools, maxSchemaBytes: profile.maxSchemaBytes,
      purposes: profile.purposes, expiresAt: profile.expiresAt,
    } };
  });
}
