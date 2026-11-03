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

/**
 * A whole run may cost the platform at most this many US dollars. Owner 2026-10-28: 0.5, raised the same day to 2 ("同意：自动
 * 浏览器测试每次全套的花费上限从 0.5 美元调到 2 美元") after the first staging run showed that the search supplier alone (about
 * 0.01 per call) costs more than the models.
 */
export const DEFAULT_SPEND_CAP_USD = 2;

/**
 * The daily real-model smoke check (CORE_E2E_DAILY=1, the @daily journeys) may spend at most this much per UTC day, all runs of
 * the day together. Owner 2026-11-03: "同意改用三层验证、批准每天 0.5 美元真实模型检查".
 */
export const DAILY_SPEND_CAP_USD = 0.5;
export const dailyMode = (env: Record<string, string | undefined> = process.env) => env.CORE_E2E_DAILY === '1';

export function spendCapUsd(env: Record<string, string | undefined> = process.env): number {
  const approved = dailyMode(env) ? DAILY_SPEND_CAP_USD : DEFAULT_SPEND_CAP_USD;
  const raw = env.CORE_E2E_MAX_USD;
  if (raw === undefined || raw === '') return approved;
  const value = Number(raw);
  // The cap can be lowered for a dry run, never raised past the approved budget.
  if (!Number.isFinite(value) || value <= 0 || value > approved) {
    throw new Error(`CORE_E2E_MAX_USD must be a number in (0, ${approved}].`);
  }
  return value;
}

/** Where the spend count starts: the run's start, or in daily mode the start of the UTC day, so every run of the day counts. */
export function spendSince(runStartedAt: string, env: Record<string, string | undefined> = process.env): string {
  if (!dailyMode(env)) return runStartedAt;
  const day = new Date(runStartedAt);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())).toISOString();
}

/**
 * The model the journeys run on (CORE_E2E_MODEL_ID). Gemini 3.8 Flash for now: it already has full per-call billing profiles, and a
 * profile for another model needs its own sampling run. 99-model-check.spec.ts enforces it.
 */
export const DEFAULT_TEST_MODEL_ID = 'google/gemini-3.8-flash';
export const testModelId = (env: Record<string, string | undefined> = process.env) => env.CORE_E2E_MODEL_ID?.trim() || DEFAULT_TEST_MODEL_ID;
/**
 * Calls that are not the dialogue model but are part of the product path and already profiled: the organizer (Luna), the jury
 * summary (Opus) and the two reviewers that stay on the jury next to Flash (Sol, Argon; see README, step 3).
 */
export const DEFAULT_SIDE_MODEL_IDS = ['openai/gpt-6-luna', 'anthropic/claude-opus-5.5', 'openai/gpt-6.1-sol', 'google/gemini-4-argon'] as const;
export const sideModelIds = (env: Record<string, string | undefined> = process.env) =>
  env.CORE_E2E_SIDE_MODEL_IDS === undefined ? [...DEFAULT_SIDE_MODEL_IDS] : env.CORE_E2E_SIDE_MODEL_IDS.split(',').map(id => id.trim()).filter(Boolean);
