/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { realContract, refuseOnProduction, runtimeGateEnvironment } from './realHost';
import type { StagingPolicy } from './stagingPolicy';

const window = { id: '10000000-0000-4000-8000-000000000001', callPolicies: [], creditsPerUsd: '100', multiplier: '6',
  expiresAt: '2099-01-01T00:00:00Z' } as unknown as StagingPolicy;
const production = { ...window, mode: 'production' as const, id: 'prod-v1' };

it('keeps the three hosts apart in the frozen contract', () => {
  expect(realContract(undefined)).toEqual({ host: { mode: 'isolated' }, rules: { version: 'runtime-local-v1', quoteVersion: 'runtime-local-v1' } });
  expect(realContract(window)).toEqual({ host: { mode: 'staging_test', testWindowId: window.id },
    rules: { version: 'runtime-staging-v1', quoteVersion: window.id } });
  expect(realContract(production)).toEqual({ host: { mode: 'production' }, rules: { version: 'runtime-production-v1', quoteVersion: 'prod-v1' } });
  expect([undefined, window, production].map(runtimeGateEnvironment)).toEqual(['local', 'staging', 'production']);
});

it('features without a production path refuse a production policy before anything is frozen', () => {
  expect(() => refuseOnProduction(window)).not.toThrow();
  expect(() => refuseOnProduction(production)).toThrow('RUNTIME_PRODUCTION_FEATURE_UNAVAILABLE');
});
