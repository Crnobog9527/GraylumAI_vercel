/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import path from 'node:path';

/** Dedicated accounts, never shared with the Codex acceptance batches or the load test. */
export const CORE_ROLES = ['gold', 'pro', 'erase'] as const;
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

/** Every language-model call of a run must be Claude Haiku 5.5 (Owner 2026-10-28); 99-model-check.spec.ts enforces it. */
export const TEST_MODEL_ID = 'anthropic/claude-haiku-5.5';
