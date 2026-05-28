/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
  createClient: vi.fn(() => {
    throw new Error('Supabase client should not be created before the auth gate');
  }),
  checkRateLimit: vi.fn(() => {
    throw new Error('Rate limit should not be checked before the auth gate');
  }),
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  filterAIOutput: vi.fn((text: string) => text),
  billingServiceConstructor: vi.fn(),
  calculateTokenCostWithPricing: vi.fn(),
  estimatePreDeductCredits: vi.fn(),
  getBillingRuntimeSettings: vi.fn(),
  getModelPricing: vi.fn(),
  upsertContextSnapshot: vi.fn(),
  decideWebSearch: vi.fn(),
  getSystemDefaultModels: vi.fn(),
  selectModel: vi.fn(),
  shouldUpgradeAssistantRoute: vi.fn(),
  applyUserPromptTemplate: vi.fn(),
  buildRuntimeSystemPrompt: vi.fn(),
  getChatRuntimeSettings: vi.fn(),
  isModulePromptResolutionError: vi.fn(),
  resolveActiveModulePrompt: vi.fn(),
  countTokens: vi.fn(),
  estimateOutputTokens: vi.fn(),
  getConfiguredProviderApiKey: vi.fn(),
  getOpenAICompatibleHeaders: vi.fn(),
  normalizeOpenAICompatibleEndpoint: vi.fn(),
  usesOpenAICompatibleApi: vi.fn(),
}));

vi.mock('next/server', () => ({
  NextRequest: class NextRequest {},
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: routeMocks.createClient,
}));

vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: routeMocks.checkRateLimit,
}));

vi.mock('@repo/api/src/services', () => ({
  filterAIOutput: routeMocks.filterAIOutput,
  logger: routeMocks.logger,
}));

vi.mock('@repo/api/src/services/billing', () => {
  class BillingService {
    constructor(...args: unknown[]) {
      routeMocks.billingServiceConstructor(...args);
    }
  }

  class ModelPricingUnavailableError extends Error {}

  return {
    BillingService,
    ModelPricingUnavailableError,
    calculateTokenCostWithPricing: routeMocks.calculateTokenCostWithPricing,
    estimatePreDeductCredits: routeMocks.estimatePreDeductCredits,
    getBillingRuntimeSettings: routeMocks.getBillingRuntimeSettings,
    getModelPricing: routeMocks.getModelPricing,
  };
});

vi.mock('@repo/api/src/services/contextManager', () => ({
  ContextManager: class ContextManager {},
}));

vi.mock('@repo/api/src/services/contextSnapshots', () => ({
  upsertContextSnapshot: routeMocks.upsertContextSnapshot,
}));

vi.mock('@repo/api/src/services/modelRouter', () => ({
  decideWebSearch: routeMocks.decideWebSearch,
  getSystemDefaultModels: routeMocks.getSystemDefaultModels,
  selectModel: routeMocks.selectModel,
  shouldUpgradeAssistantRoute: routeMocks.shouldUpgradeAssistantRoute,
}));

vi.mock('@repo/api/src/services/chatRuntime', () => ({
  applyUserPromptTemplate: routeMocks.applyUserPromptTemplate,
  buildRuntimeSystemPrompt: routeMocks.buildRuntimeSystemPrompt,
  getChatRuntimeSettings: routeMocks.getChatRuntimeSettings,
  isModulePromptResolutionError: routeMocks.isModulePromptResolutionError,
  resolveActiveModulePrompt: routeMocks.resolveActiveModulePrompt,
}));

vi.mock('@repo/api/src/services/tokenCounter', () => ({
  countTokens: routeMocks.countTokens,
  estimateOutputTokens: routeMocks.estimateOutputTokens,
}));

vi.mock('@repo/api/src/services/providerUtils', () => ({
  getConfiguredProviderApiKey: routeMocks.getConfiguredProviderApiKey,
  getOpenAICompatibleHeaders: routeMocks.getOpenAICompatibleHeaders,
  normalizeOpenAICompatibleEndpoint: routeMocks.normalizeOpenAICompatibleEndpoint,
  usesOpenAICompatibleApi: routeMocks.usesOpenAICompatibleApi,
}));

const { POST } = await import('../../../../apps/web/src/app/api/ai/stream/route');

const INVALID_MODULE_MESSAGE = '功能模块参数无效';
const MISSING_AUTH_MESSAGE = '未提供认证 Token';
const VALID_MODULE_ID = '00000000-0000-4000-8000-000000000001';

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function makeStreamRequest(body: Record<string, unknown>) {
  return new Request('https://graylum.test/api/ai/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'moduleId smoke test',
      ...body,
    }),
  });
}

async function callStreamRoute(body: Record<string, unknown>) {
  const response = await POST(makeStreamRequest(body) as any);
  const payload = await response.json() as { error?: string };

  return {
    error: payload.error ?? '',
    status: response.status,
  };
}

function expectNoDownstreamRuntimeAccess() {
  expect(routeMocks.createClient).not.toHaveBeenCalled();
  expect(routeMocks.checkRateLimit).not.toHaveBeenCalled();
  expect(routeMocks.billingServiceConstructor).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
}

describe('ai stream route moduleId early validation', () => {
  it.each([
    ['numeric moduleId', 123],
    ['object moduleId', { id: VALID_MODULE_ID }],
    ['array moduleId', [VALID_MODULE_ID]],
    ['invalid string moduleId', 'not-a-module-id'],
  ])('returns 400 invalid module before auth for %s', async (_name, moduleId) => {
    const result = await callStreamRoute({ moduleId });

    expect(result.status).toBe(400);
    expect(result.status).not.toBe(500);
    expect(result.error).toContain(INVALID_MODULE_MESSAGE);
    expectNoDownstreamRuntimeAccess();
  });

  it('lets a valid UUID moduleId pass module validation and reach the auth gate', async () => {
    const result = await callStreamRoute({ moduleId: VALID_MODULE_ID });

    expect(result.status).toBe(401);
    expect(result.status).not.toBe(500);
    expect(result.error).toContain(MISSING_AUTH_MESSAGE);
    expect(result.error).not.toContain(INVALID_MODULE_MESSAGE);
    expectNoDownstreamRuntimeAccess();
  });

  it('preserves omitted moduleId behavior and reaches the auth gate', async () => {
    const result = await callStreamRoute({});

    expect(result.status).toBe(401);
    expect(result.status).not.toBe(500);
    expect(result.error).toContain(MISSING_AUTH_MESSAGE);
    expect(result.error).not.toContain(INVALID_MODULE_MESSAGE);
    expectNoDownstreamRuntimeAccess();
  });
});
