/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { paygHostProfile } from './paygHostPolicy';

// FUSION-COMPARE PR-4 (Owner 2026-10-17 Q4): the compare-shape patch applied to the committed Sol / Opus review profiles
// parses under the real schema, restates the committed compare evidence exactly, and stays Fusion-only.
const dir = resolve(__dirname, '../../../../../docs/launch/evidence');
const evidenceBytes = readFileSync(resolve(dir, 'fusion-compare-20261023.json'));
const evidence = JSON.parse(evidenceBytes.toString('utf8'));
const patchFile = JSON.parse(readFileSync(resolve(dir, 'fusion-compare-20261023.profiles-draft.json'), 'utf8'));
const base = JSON.parse(readFileSync(resolve(dir, 'fusion-profile-20261017.profiles-draft.json'), 'utf8'));
const hash = createHash('sha256').update(evidenceBytes).digest('hex');

it('the patch cites the committed evidence file, which stays within the Owner budget and the cost bound', () => {
  expect(patchFile.evidenceSha256).toBe(hash);
  expect(evidence.totalCostUsd).toBeLessThanOrEqual(evidence.budgetUsd);
  expect(evidence.samples.every((s: { costWithinBound: boolean; completionWithinLimit: boolean; cachedWithinPrompt: boolean;
    status: number; egress: string }) => s.costWithinBound && s.completionWithinLimit && s.cachedWithinPrompt && s.status === 200
    && s.egress === 'US')).toBe(true);
});
it.each(['openai/gpt-6.1-sol', 'anthropic/claude-opus-5.5'])('%s patched profile is valid and matches its compare evidence', model => {
  const patch = patchFile.patches.find((p: { model: string }) => p.model === model);
  const profile = structuredClone(base.profiles.find((p: { model: string }) => p.model === model));
  profile.purposes = [...profile.purposes, ...patch.addPurposes];
  profile.requestFormats = [...profile.requestFormats, ...patch.addRequestFormats];
  profile.evidence.compareShape = patch.setEvidenceCompareShape;
  expect(paygHostProfile.safeParse(profile).success).toBe(true);
  const m = evidence.models[model];
  expect(profile.evidence.compareShape).toMatchObject({ manifestHash: hash, distinctSamples: m.samples, sizeBands: m.sizeBands.length,
    maxVerifiedBytes: m.maxVerifiedBytes, maxPromptToBytes: m.maxPromptToBytes, maxPromptToUpper: m.maxPromptToUpper });
  // The compare samples were taken at the profile's own tested output limit.
  expect(profile.evidence.compareShape.testedOutputLimit).toBe(profile.evidence.testedOutputLimit);
  // Without the compare samples the same profile is refused; with them it still cannot cover another purpose.
  const bare = structuredClone(profile); delete bare.evidence.compareShape;
  expect(paygHostProfile.safeParse(bare).success).toBe(false);
  expect(paygHostProfile.safeParse({ ...profile, purposes: [...profile.purposes, 'ordinary'] }).success).toBe(false);
});
