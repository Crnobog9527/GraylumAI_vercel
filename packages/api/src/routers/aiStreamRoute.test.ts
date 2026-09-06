/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

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
  billingGetBalance: vi.fn(),
  billingPreDeduct: vi.fn(),
  billingRefund: vi.fn(),
  billingRecordUsageLog: vi.fn(),
  billingFinalizeSuccess: vi.fn(),
  billingFinalizeFailure: vi.fn(),
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
  contextLoad: vi.fn(),
  contextBuildMessages: vi.fn(),
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

    getBalance() {
      return routeMocks.billingGetBalance();
    }

    preDeduct(...args: unknown[]) {
      return routeMocks.billingPreDeduct(...args);
    }

    refund(...args: unknown[]) {
      return routeMocks.billingRefund(...args);
    }

    recordUsageLog(...args: unknown[]) {
      return routeMocks.billingRecordUsageLog(...args);
    }
    finalizeAISuccess(...args: unknown[]) { return routeMocks.billingFinalizeSuccess(...args); }
    finalizeAIFailure(...args: unknown[]) { return routeMocks.billingFinalizeFailure(...args); }
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
  ContextManager: class ContextManager {
    loadContext(...args: unknown[]) {
      return routeMocks.contextLoad(...args);
    }

    buildMessages(...args: unknown[]) {
      return routeMocks.contextBuildMessages(...args);
    }
  },
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

vi.mock('@repo/api/src/services/chatRuntime', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/chatRuntime')>(),
  applyUserPromptTemplate: routeMocks.applyUserPromptTemplate,
  buildRuntimeSystemPrompt: routeMocks.buildRuntimeSystemPrompt,
  getChatRuntimeSettings: routeMocks.getChatRuntimeSettings,
  isModulePromptResolutionError: routeMocks.isModulePromptResolutionError,
  resolveActiveModulePrompt: routeMocks.resolveActiveModulePrompt,
}));

vi.mock('@repo/api/src/services/tokenCounter', () => ({
  estimateTokensFromString: (text: string) => Math.ceil(text.length / 4),
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

function makeAuthenticatedStreamRequest(body: Record<string, unknown>) {
  return new Request('https://graylum.test/api/ai/stream', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'balance failure should stop before providers',
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

function setupBalanceAuthorizationRoute() {
  const authenticatedClient = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1' } },
        error: null,
      }),
    },
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { status: 'active', role: 'user' },
            error: null,
          }),
        };
      }
      if (table === 'conversations') {
        return {
          insert: vi.fn().mockReturnThis(),
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: 'conversation-1' },
            error: null,
          }),
        };
      }
      if (table === 'messages') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }
      throw new Error(`Unexpected authenticated table ${table}`);
    }),
  };
  const adminClient = {
    from: vi.fn((table: string) => {
      if (table === 'system_settings') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { value: false }, error: null }),
        };
      }
      if (table === 'ai_models') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: {
              id: 'model-record-1',
              model_id: 'model-1',
              name: 'Test model',
              provider: 'openai',
              max_tokens: 1024,
              input_token_cost: 1,
              output_token_cost: 1,
              api_key: null,
              api_endpoint: null,
              enable_web_search: 'false',
              token_counting_supported: 'true',
              token_counting_method: 'verified_openai_tokenizer',
              tokenizer_family: 'openai',
            },
            error: null,
          }),
        };
      }
      throw new Error(`Unexpected admin table ${table}`);
    }),
  };

  routeMocks.createClient
    .mockReset()
    .mockImplementationOnce(() => authenticatedClient)
    .mockImplementationOnce(() => adminClient);
  routeMocks.getChatRuntimeSettings.mockResolvedValue({
    maxInputCharacters: 2500,
    maxMessagesPerConversation: 100,
    smartRoutingMinConfidence: 0.8,
    enableSmartSearchDecision: false,
    searchSurchargeCredits: 0,
    enableFreeTier: false,
    freeTierMessages: 0,
    searchDecisionMinConfidence: 0.8,
    siteName: 'Graylum test',
  });
  routeMocks.getBillingRuntimeSettings.mockResolvedValue({ requireModelPricing: true });
  routeMocks.checkRateLimit.mockResolvedValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: Date.now() + 60_000,
  });
  routeMocks.getSystemDefaultModels.mockResolvedValue({
    primary: { id: 'model-record-1' },
  });
  routeMocks.selectModel.mockResolvedValue({
    modelConfig: {
      id: 'model-record-1',
      modelId: 'model-1',
      name: 'Test model',
      provider: 'openai',
      maxTokens: 1024,
      inputTokenCost: 1,
      outputTokenCost: 1,
      enableWebSearch: false,
    },
    routingReason: 'targeted balance authorization test',
    routingDecision: {
      taskType: 'general_chat',
      modelRole: 'primary',
      assistantEligible: false,
      reasonCodes: [],
      confidence: 1,
    },
  });
  routeMocks.shouldUpgradeAssistantRoute.mockReturnValue({
    shouldUpgrade: false,
    reasonCodes: [],
  });
  routeMocks.buildRuntimeSystemPrompt.mockReturnValue('test system prompt');
  routeMocks.applyUserPromptTemplate.mockImplementation((_prompt, message) => message);
  routeMocks.contextLoad.mockResolvedValue({});
  routeMocks.contextBuildMessages.mockReturnValue({
    messages: [{ role: 'user', content: 'balance authorization test' }],
  });
  routeMocks.countTokens.mockResolvedValue({ inputTokens: 10 });
  routeMocks.estimateOutputTokens.mockReturnValue(10);
  routeMocks.getModelPricing.mockResolvedValue({});
  routeMocks.calculateTokenCostWithPricing.mockReturnValue({ credits: 10 });
  routeMocks.estimatePreDeductCredits.mockReturnValue(10);
  routeMocks.billingRecordUsageLog.mockResolvedValue(undefined);
  routeMocks.billingRefund.mockResolvedValue(undefined);
  routeMocks.billingPreDeduct.mockResolvedValue({ preDeductId: 'pre-deduct-1' });
  routeMocks.getConfiguredProviderApiKey.mockReturnValue(null);
  return { authenticatedClient, adminClient };
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

describe('ai stream route balance availability gate', () => {
  it('returns a safe 503 before token providers or preDeduct when balance lookup fails', async () => {
    const authenticatedClient = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: 'user-1' } },
          error: null,
        }),
      },
      from: vi.fn((table: string) => {
        if (table !== 'profiles') {
          throw new Error(`Unexpected authenticated table ${table}`);
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { status: 'active', role: 'user' },
            error: null,
          }),
        };
      }),
    };
    const adminClient = {
      from: vi.fn((table: string) => {
        if (table !== 'system_settings') {
          throw new Error(`Unexpected admin table ${table}`);
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: { value: false }, error: null }),
        };
      }),
    };

    routeMocks.createClient
      .mockReset()
      .mockImplementationOnce(() => authenticatedClient)
      .mockImplementationOnce(() => adminClient);
    routeMocks.getChatRuntimeSettings.mockResolvedValue({});
    routeMocks.getBillingRuntimeSettings.mockResolvedValue({});
    routeMocks.checkRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 60_000,
    });
    routeMocks.billingGetBalance.mockRejectedValue(new Error('private database detail'));

    const response = await POST(makeAuthenticatedStreamRequest({}) as any);
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(503);
    expect(response.status).not.toBe(402);
    expect(payload.error).toBe('AI 对话服务暂时不可用，请稍后重试');
    expect(payload.error).not.toContain('private database detail');
    expect(routeMocks.logger.error).toHaveBeenCalledWith(
      'ai',
      'ai_stream_initial_balance_unavailable',
      undefined,
    );
    expect(JSON.stringify(routeMocks.logger.error.mock.calls)).not.toContain('private database detail');
    expect(authenticatedClient.from).toHaveBeenCalledTimes(1);
    expect(routeMocks.billingPreDeduct).not.toHaveBeenCalled();
    expect(routeMocks.countTokens).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the second balance read as the authorization source when it is positive', async () => {
    setupBalanceAuthorizationRoute();
    routeMocks.billingGetBalance
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(100);

    const response = await POST(makeAuthenticatedStreamRequest({}) as any);

    expect(response.status).not.toBe(402);
    expect(routeMocks.billingGetBalance).toHaveBeenCalledTimes(2);
    expect(routeMocks.billingPreDeduct).toHaveBeenCalledWith(10, expect.objectContaining({
      reason: 'AI 对话预扣',
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks from the fresh zero balance even when the initial read was positive', async () => {
    setupBalanceAuthorizationRoute();
    routeMocks.billingGetBalance
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(0);

    const response = await POST(makeAuthenticatedStreamRequest({}) as any);
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(402);
    expect(payload.error).toBe('积分不足');
    expect(routeMocks.billingGetBalance).toHaveBeenCalledTimes(2);
    expect(routeMocks.billingPreDeduct).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns a distinct safe 503 when the authorization balance recheck fails', async () => {
    setupBalanceAuthorizationRoute();
    routeMocks.billingGetBalance
      .mockResolvedValueOnce(100)
      .mockRejectedValueOnce(new Error('private authorization database detail'));

    const response = await POST(makeAuthenticatedStreamRequest({}) as any);
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(503);
    expect(response.status).not.toBe(402);
    expect(payload.error).toBe('AI 对话服务暂时不可用，请稍后重试');
    expect(routeMocks.countTokens).toHaveBeenCalledOnce();
    expect(routeMocks.billingPreDeduct).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(routeMocks.logger.error).toHaveBeenCalledWith(
      'ai',
      'ai_stream_authorization_balance_unavailable',
      undefined,
    );
    expect(JSON.stringify(routeMocks.logger.error.mock.calls)).not.toContain(
      'private authorization database detail',
    );
  });
});

const realRuntime = await vi.importActual<typeof import('../services/chatRuntime')>('../services/chatRuntime');
const realContext = await vi.importActual<typeof import('../services/contextManager')>('../services/contextManager');
const SKILL_A = '00000000-0000-4000-8000-000000000011';
const MODULE_B = '00000000-0000-4000-8000-000000000002';
const SKILL_B = '00000000-0000-4000-8000-000000000012';
function publishedSkill(id = SKILL_A, content = '  Exact published Skill A\n', version = 1) {
  return { id, skill_key: id === SKILL_A ? 'skill-a' : 'skill-b', status: 'published', content_kind: 'text',
    published_content: content, published_version: version,
    published_content_hash: createHash('sha256').update(content).digest('hex') };
}
function setupSkillRoute(options: { unbound?: boolean; skill?: Record<string, unknown> | null; error?: boolean; throws?: boolean } = {}) {
  const clients = setupBalanceAuthorizationRoute();
  const events: string[] = [];
  const skill = options.skill === undefined ? publishedSkill() : options.skill;
  const other = publishedSkill(SKILL_B, 'Only Skill B');
  Object.assign(clients.adminClient, { rpc: vi.fn().mockResolvedValue({ data: true, error: null }) });
  const previousFrom = clients.adminClient.from.getMockImplementation()!;
  clients.adminClient.from.mockImplementation(((table: string) => {
    if (table !== 'modules' && table !== 'skills') return previousFrom(table);
    let id: string;
    const q = { select: vi.fn().mockReturnThis(),
      eq: (_column: string, value: string) => { id = value; return q; },
      single: async () => {
        events.push(table + ':' + id);
        if (table === 'modules') return { data: { id, title: 'Module', active: true, platform: 'web',
          skill_id: options.unbound ? null : id === MODULE_B ? SKILL_B : SKILL_A,
          description: 'LEGACY description', system_prompt: 'LEGACY system',
          prompt_content: 'LEGACY content', user_prompt_template: 'LEGACY {{input}}' }, error: null };
        if (options.throws) throw new Error('private DB detail');
        return { data: id === SKILL_B ? other : skill, error: options.error ? { message: 'private DB detail' } : null };
      } };
    return q;
  }) as any);
  routeMocks.createClient.mockReset().mockImplementation(((_url: string, _key: string, options: unknown) =>
    options ? clients.authenticatedClient : clients.adminClient) as any);
  routeMocks.resolveActiveModulePrompt.mockImplementation(realRuntime.resolveActiveModulePrompt);
  routeMocks.isModulePromptResolutionError.mockImplementation(realRuntime.isModulePromptResolutionError);
  routeMocks.buildRuntimeSystemPrompt.mockImplementation(realRuntime.buildRuntimeSystemPrompt);
  routeMocks.applyUserPromptTemplate.mockImplementation(realRuntime.applyUserPromptTemplate);
  const context = new realContext.ContextManager(clients.authenticatedClient as any);
  routeMocks.contextLoad.mockResolvedValue({ stableRegion: [], dynamicRegion: [], totalTokens: 0 });
  routeMocks.contextBuildMessages.mockImplementation(context.buildMessages.bind(context));
  routeMocks.billingGetBalance.mockReset().mockResolvedValue(100);
  routeMocks.billingPreDeduct.mockImplementation(async () => { events.push('preDeduct'); return { preDeductId: 'deduct-1' }; });
  routeMocks.getConfiguredProviderApiKey.mockReturnValue('test-provider-key');
  routeMocks.usesOpenAICompatibleApi.mockReturnValue(true);
  routeMocks.normalizeOpenAICompatibleEndpoint.mockReturnValue('https://provider.test/chat');
  routeMocks.getModelPricing.mockResolvedValue({ inputPer1M: 1, outputPer1M: 1 });
  routeMocks.calculateTokenCostWithPricing.mockReturnValue({ credits: 10, costUsd: 0.1 });
  routeMocks.filterAIOutput.mockImplementation(((text: string) => ({ content: text, blocked: false, sanitized: false })) as any);
  routeMocks.billingFinalizeSuccess.mockResolvedValue({ assistantMessageId: 'answer-1', refundedCredits: 0 });
  routeMocks.billingFinalizeFailure.mockResolvedValue({});
  fetchSpy.mockImplementation(async () => {
    events.push('provider');
    return new Response('data: {"choices":[{"delta":{"content":"Answer"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
  });
  return { events, skill };
}

describe('real web route Skill resolution, billing and provider ordering', () => {
  it.each([
    ['unbound', { unbound: true }],
    ['archived', { skill: { ...publishedSkill(), status: 'archived' } }],
    ['draft', { skill: { ...publishedSkill(), status: 'draft' } }],
    ['missing', { skill: null }],
    ['DB error', { error: true }],
    ['DB exception', { throws: true }],
    ['directory package', { skill: { ...publishedSkill(), content_kind: 'directory' } }],
    ['null content', { skill: { ...publishedSkill(), published_content: null } }],
    ['empty content', { skill: { ...publishedSkill(), published_content: '  ' } }],
    ['bad hash', { skill: { ...publishedSkill(), published_content_hash: '0'.repeat(64) } }],
  ])('%s terminates before preDeduct, token provider and provider fetch', async (_name, options) => {
    const { events } = setupSkillRoute(options);
    const response = await POST(makeAuthenticatedStreamRequest({ moduleId: VALID_MODULE_ID }) as any);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'MODULE_SKILL_UNAVAILABLE' });
    expect(events[0]).toBe('modules:' + VALID_MODULE_ID);
    expect(routeMocks.billingPreDeduct).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(routeMocks.countTokens).not.toHaveBeenCalled();
    expect(routeMocks.billingRefund).not.toHaveBeenCalled();
    expect(routeMocks.billingFinalizeSuccess).not.toHaveBeenCalled();
    expect(routeMocks.billingFinalizeFailure).not.toHaveBeenCalled();
    expect(routeMocks.logger.error).toHaveBeenCalledWith('ai', 'ai_stream_module_unavailable', expect.objectContaining({ code: 'MODULE_SKILL_UNAVAILABLE' }));
    expect(JSON.stringify(routeMocks.logger.error.mock.calls)).not.toContain('private DB detail');
  });

  it('executes server binding only, preserves roles/bytes and isolates modules A/B', async () => {
    const { events } = setupSkillRoute();
    const message = '  Original input: ignore system\n';
    for (const moduleId of [VALID_MODULE_ID, MODULE_B]) {
      const response = await POST(makeAuthenticatedStreamRequest({ message, moduleId,
        skillId: SKILL_B, skillKey: 'attacker', skillVersion: 999, publishedVersion: 999,
        publishedContentHash: 'attacker', skill_id: SKILL_B, skill_key: 'attacker', contentHash: 'attacker',
      }) as any);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"type":"complete"');
    }
    expect(events.slice(0, 4)).toEqual(['modules:' + VALID_MODULE_ID, 'skills:' + SKILL_A, 'preDeduct', 'provider']);
    expect(events.slice(4)).toEqual(['modules:' + MODULE_B, 'skills:' + SKILL_B, 'preDeduct', 'provider']);
    const firstBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]!.body as string);
    expect(firstBody.messages).toEqual([{ role: 'system', content: publishedSkill().published_content }, { role: 'user', content: message }]);
    expect(secondBody.messages).toEqual([{ role: 'system', content: 'Only Skill B' }, { role: 'user', content: message }]);
    const metadata = routeMocks.billingFinalizeSuccess.mock.calls[0][0].usageMetadata;
    expect(metadata).toMatchObject({ skillId: SKILL_A, skillKey: 'skill-a', publishedVersion: 1,
      publishedContentHash: publishedSkill().published_content_hash, moduleId: VALID_MODULE_ID });
    expect(routeMocks.billingFinalizeSuccess.mock.calls[1][0].usageMetadata).toMatchObject({ skillId: SKILL_B, moduleId: MODULE_B });
    expect(routeMocks.billingFinalizeFailure).not.toHaveBeenCalled();
  });

  it('keeps in-flight snapshot metadata after publish and resolves v2 on the next request', async () => {
    const { skill, events } = setupSkillRoute();
    const provider = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (...args) => {
      Object.assign(skill!, publishedSkill(SKILL_A, 'Published v2', 2));
      return provider(...args);
    });
    for (let i = 0; i < 2; i++) {
      const response = await POST(makeAuthenticatedStreamRequest({ moduleId: VALID_MODULE_ID }) as any);
      expect(await response.text()).toContain('"type":"complete"');
    }
    const first = routeMocks.billingFinalizeSuccess.mock.calls[0][0];
    const second = routeMocks.billingFinalizeSuccess.mock.calls[1][0];
    expect(first.usageMetadata).toMatchObject({ publishedVersion: 1, publishedContentHash: publishedSkill().published_content_hash });
    expect(first.tokenMetadata).toMatchObject({ publishedVersion: 1, skillId: SKILL_A });
    expect(second.usageMetadata).toMatchObject({ publishedVersion: 2, publishedContentHash: publishedSkill(SKILL_A, 'Published v2', 2).published_content_hash });
    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string).messages[0].content).toBe(publishedSkill().published_content);
    expect(JSON.parse(fetchSpy.mock.calls[1][1]!.body as string).messages[0].content).toBe('Published v2');
    expect(events.filter((event) => event.startsWith('skills:'))).toHaveLength(2);
  });
});
