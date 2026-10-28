/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import path from 'node:path';

/** Dedicated accounts, never shared with the Codex acceptance batches or the load test. */
export const CORE_ROLES = ['gold', 'pro'] as const;
export type CoreRole = (typeof CORE_ROLES)[number];

export const authDirectory = path.join(__dirname, '../../.auth');
export const resultsDirectory = path.resolve(process.cwd(), 'test-results/core-path');

export const statePathFor = (role: CoreRole) => path.join(authDirectory, `core-${role}.json`);

export function credentialsFor(role: CoreRole, env: Record<string, string | undefined> = process.env) {
  const key = role.toUpperCase();
  return { email: env[`CORE_E2E_${key}_EMAIL`]?.trim() ?? '', password: env[`CORE_E2E_${key}_PASSWORD`] ?? '' };
}

/** A whole run may cost the platform at most this many US dollars (Owner 2026-10-28: 0.5). */
export const DEFAULT_SPEND_CAP_USD = 0.5;
export function spendCapUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CORE_E2E_MAX_USD;
  if (raw === undefined || raw === '') return DEFAULT_SPEND_CAP_USD;
  const value = Number(raw);
  // The cap can be lowered for a dry run, never raised past the approved budget.
  if (!Number.isFinite(value) || value <= 0 || value > DEFAULT_SPEND_CAP_USD) {
    throw new Error(`CORE_E2E_MAX_USD must be a number in (0, ${DEFAULT_SPEND_CAP_USD}].`);
  }
  return value;
}

/**
 * The model the journeys run on (CORE_E2E_MODEL_ID). Gemini 3.8 Flash for now: it already has full per-call billing profiles, and a
 * profile for another model needs its own sampling run. 99-model-check.spec.ts enforces it.
 */
export const DEFAULT_TEST_MODEL_ID = 'google/gemini-3.8-flash';
export const testModelId = (env: Record<string, string | undefined> = process.env) => env.CORE_E2E_MODEL_ID?.trim() || DEFAULT_TEST_MODEL_ID;
/** Calls that are not the dialogue model but are part of the product path and already profiled: the organizer and the jury summary. */
export const DEFAULT_SIDE_MODEL_IDS = ['openai/gpt-6-luna', 'anthropic/claude-opus-5.5'] as const;
export const sideModelIds = (env: Record<string, string | undefined> = process.env) =>
  env.CORE_E2E_SIDE_MODEL_IDS === undefined ? [...DEFAULT_SIDE_MODEL_IDS] : env.CORE_E2E_SIDE_MODEL_IDS.split(',').map(id => id.trim()).filter(Boolean);
