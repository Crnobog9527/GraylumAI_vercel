/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { paygHostProfile } from './paygHostPolicy';

// FUSION-PROFILE (Owner 2026-10-17, plan B): the committed Sol / Opus profile drafts parse under the real schema and
// restate the committed evidence exactly (hash, sample counts, ratios, output stress).
const dir = resolve(__dirname, '../../../../../docs/launch/evidence');
const evidenceBytes = readFileSync(resolve(dir, 'fusion-profile-20261017.json'));
const evidence = JSON.parse(evidenceBytes.toString('utf8'));
const draft = JSON.parse(readFileSync(resolve(dir, 'fusion-profile-20261017.profiles-draft.json'), 'utf8'));
const hash = createHash('sha256').update(evidenceBytes).digest('hex');

it('drafts cite the committed evidence file', () => {
  expect(draft.evidenceSha256).toBe(hash);
  expect(evidence.totalCostUsd).toBeLessThanOrEqual(evidence.budgetUsd);
  expect(evidence.samples.every((s: { costWithinBound: boolean; completionWithinLimit: boolean; cachedWithinPrompt: boolean }) =>
    s.costWithinBound && s.completionWithinLimit && s.cachedWithinPrompt)).toBe(true);
});
it.each(['openai/gpt-6.1-sol', 'anthropic/claude-opus-5.5'])('%s draft is a valid Fusion-only profile matching its evidence', model => {
  const profile = draft.profiles.find((p: { model: string }) => p.model === model);
  expect(paygHostProfile.safeParse(profile).success).toBe(true);
  const m = evidence.models[model];
  expect(profile.purposes).toEqual(m.purposes);
  expect(profile.evidence).toMatchObject({ manifestHash: hash, distinctSamples: m.samples, sizeBands: m.sizeBands.length,
    maxVerifiedBytes: m.maxVerifiedBytes, maxPromptToBytes: m.maxPromptToBytes, maxPromptToUpper: m.maxPromptToUpper });
  for (const variant of profile.reasoningVariants) {
    expect(variant.manifestHash).toBe(hash);
    expect(variant.outputStressSamples).toBe(m.outputStressSamplesByLimit[String(variant.testedOutputLimit)]);
  }
  // The relaxed evidence may never be stretched to another purpose.
  expect(paygHostProfile.safeParse({ ...profile, purposes: [...profile.purposes, 'ordinary'] }).success).toBe(false);
});
