/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { paygHostProfile } from './paygHostPolicy';
import { decimal } from '../bill2/decimal';
import { openRouterCallBound } from '../bill2/openRouterPolicy';

const directory = resolve(__dirname, '../../../../../docs/launch/evidence');
const bytes = readFileSync(resolve(directory, 'fusion-argon-20261021.json'));
const evidence = JSON.parse(bytes.toString('utf8'));
const draft = JSON.parse(readFileSync(resolve(directory, 'fusion-argon-20261021.profiles-draft.json'), 'utf8'));
const plan = JSON.parse(readFileSync(resolve(directory, 'fusion-argon-20261021-plan.json'), 'utf8'));
const hash = createHash('sha256').update(bytes).digest('hex');
type Sample = typeof evidence.samples[number];

it('Argon receipts are unique, metered within the formal bounds, and sum within the $3 authorization', () => {
  const samples: Sample[] = evidence.samples;
  expect(evidence.model).toBe('google/gemini-4-argon');
  expect(evidence.endpointTag).toBe('google-ai-studio');
  expect(samples).toHaveLength(6);
  expect(new Set(samples.map(s => s.requestHash)).size).toBe(6);
  expect(new Set(samples.map(s => s.generationHash)).size).toBe(6);
  const cost = samples.reduce((total: bigint, s) => total + decimal(s.costUsd), 0n);
  expect(cost).toBe(decimal(evidence.totalCostUsd));
  expect(cost <= decimal('3')).toBe(true);
  expect(createHash('sha256').update(JSON.stringify(evidence.route)).digest('hex')).toBe(evidence.catalogHash);
  for (const sample of samples) {
    const planned = plan.samples.find((item: { id: string }) => item.id === sample.id);
    expect(sample.requestHash).toBe(planned.requestHash);
    expect(sample.bytes).toBe(planned.bytes);
    expect(sample.outputLimit).toBe(planned.output);
    expect(sample.lookupFinal).toBe(true);
    expect(sample.providerName).toBe('Google AI Studio');
    const bound = openRouterCallBound(evidence.providerLimits, sample.outputLimit, sample.bytes + 8192);
    expect(sample.upperUsd).toBe(bound.upperUsd);
    expect(decimal(sample.costUsd) <= decimal(bound.upperUsd)).toBe(true);
    expect(sample.completionTokens).toBeLessThanOrEqual(sample.outputLimit);
    expect(sample.reasoningTokens).toBeLessThanOrEqual(sample.completionTokens);
    expect(sample.cachedTokens).toBeLessThanOrEqual(sample.promptTokens);
    expect(sample.cacheWriteTokens).toBeLessThanOrEqual(sample.promptTokens);
    expect(sample.promptTokens / sample.bytes).toBeLessThanOrEqual(0.7);
    expect(sample.promptTokens / (sample.bytes + 8192)).toBeLessThanOrEqual(0.7);
    if (!sample.outputStressPassed) expect(sample.usableOpinion).toBe(true);
  }
  const stress = samples.filter(s => s.outputStressPassed);
  expect(stress).toHaveLength(2);
  for (const sample of stress) {
    expect(sample.finishReason).toBe('length');
    expect(sample.outputLimit).toBe(512);
    expect(sample.completionTokens).toBeGreaterThanOrEqual(0.9 * sample.outputLimit);
  }
});

it('the Argon profile binds the committed model evidence and keeps only reviewer low / 4096', () => {
  expect(draft.evidenceSha256).toBe(hash);
  expect(draft.profiles).toHaveLength(1);
  const profile = draft.profiles[0];
  expect(paygHostProfile.safeParse(profile).success).toBe(true);
  expect(profile).toMatchObject({ model: evidence.model, endpointTag: evidence.endpointTag, outputLimit: 4096,
    purposes: ['fusion_review'], requestFormats: ['fusion-json-v1-stream'] });
  expect(profile.evidence).toMatchObject({ reference: evidence.reference, manifestHash: hash,
    distinctSamples: 6, sizeBands: 2, maxVerifiedBytes: 186000,
    maxPromptToBytes: evidence.maxPromptToBytes, maxPromptToUpper: evidence.maxPromptToUpper,
    testedOutputLimit: 512, includesReasoning: true, costBoundPassed: true, cacheCovered: true });
  expect(profile.reasoningVariants).toEqual([{ reasoning: { effort: 'low' }, outputLimit: 4096,
    testedOutputLimit: 512, evidenceReference: evidence.reference, manifestHash: hash,
    outputStressSamples: 2, includesReasoning: true }]);
  expect(paygHostProfile.safeParse({ ...profile, purposes: ['fusion_review', 'ordinary'] }).success).toBe(false);
});
