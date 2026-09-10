/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
const networkFetch = globalThis.fetch;

const routeMocks = vi.hoisted(() => ({
  skillMode: vi.fn(),
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

vi.mock('@repo/api/src/services/artifacts/chat',()=>({skillChatService:()=>({mode:routeMocks.skillMode})}));

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

vi.mock('@repo/api/src/services/providerUtils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/providerUtils')>(),
  getConfiguredProviderApiKey: routeMocks.getConfiguredProviderApiKey,
  getOpenAICompatibleHeaders: routeMocks.getOpenAICompatibleHeaders,
  normalizeOpenAICompatibleEndpoint: routeMocks.normalizeOpenAICompatibleEndpoint,
  usesOpenAICompatibleApi: routeMocks.usesOpenAICompatibleApi,
}));

// Lifecycle SQL is exercised by ordinaryChatReliability.integration.ts. These
// existing handler cases isolate admission, routing and provider usage.
vi.mock('@/lib/ordinary-chat-request', async importOriginal => {
  const actual=await importOriginal<typeof import('../../../../apps/web/src/lib/ordinary-chat-request')>();
  const {BillingService}=await import('@repo/api/src/services/billing');
  return {...actual,readChatRequest:vi.fn(async()=>null),
    claimChatRequest:vi.fn(async(_admin,userId,requestId,input)=>({claimed:true,request:{user_id:userId,request_id:requestId,input,conversation_id:'conversation-1'}})),
    ordinaryChatRequest:(admin,userId)=>({billing:new BillingService({supabase:admin,userId}),transition:vi.fn(async()=>({}))})};
});

const { POST } = await import('../../../../apps/web/src/app/api/ai/stream/route');

const INVALID_MODULE_MESSAGE = '功能模块参数无效';
const MISSING_AUTH_MESSAGE = '未提供认证 Token';
const VALID_MODULE_ID = '00000000-0000-4000-8000-000000000001';

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.decideWebSearch.mockReturnValue({shouldSearch:false,confidence:1,estimatedSearchCount:0,reasonCodes:['no_realtime_signals']});
  routeMocks.skillMode.mockResolvedValue({guided:false});
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
      requestId: crypto.randomUUID(),
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
      requestId: crypto.randomUUID(),
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
  routeMocks.usesOpenAICompatibleApi.mockReturnValue(true);
  const authenticatedClient = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1', email_confirmed_at: '2026-01-01T00:00:00Z' } },
        error: null,
      }),
    },
    from: vi.fn((table: string) => {
      if (table === 'billing_history') return {
        select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
        gte: vi.fn().mockResolvedValue({data: [], error: null, count: 0}),
      };
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
          data: { user: { id: 'user-1', email_confirmed_at: '2026-01-01T00:00:00Z' } },
          error: null,
        }),
      },
      from: vi.fn((table: string) => {
        if (table === 'billing_history') return {
          select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
          gte: vi.fn().mockResolvedValue({data: [], error: null, count: 0}),
        };
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
    expect(authenticatedClient.from).toHaveBeenCalledTimes(3);
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
  return { events, skill, ...clients };
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
      const injected = await POST(makeAuthenticatedStreamRequest({ message, moduleId,
        skillId: SKILL_B, skillKey: 'attacker', skillVersion: 999, publishedVersion: 999,
        publishedContentHash: 'attacker', skill_id: SKILL_B, skill_key: 'attacker', contentHash: 'attacker',
      }) as any);
      expect(injected.status).toBe(400);
      const response = await POST(makeAuthenticatedStreamRequest({ message, moduleId }) as any);
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

describe('guided Skill uses one generation path',()=>{
 it('rejects guided modules before ordinary reservation and model dispatch',async()=>{
  setupSkillRoute();routeMocks.skillMode.mockResolvedValue({guided:true});
  const response=await POST(makeAuthenticatedStreamRequest({moduleId:VALID_MODULE_ID}) as any);
  expect(response.status).toBe(409);expect(routeMocks.billingPreDeduct).not.toHaveBeenCalled();expect(fetchSpy).not.toHaveBeenCalled();
 });
 it('free chat does not consult workflow discovery',async()=>{
  setupSkillRoute();routeMocks.skillMode.mockRejectedValue(new Error('workflow unavailable'));
  const response=await POST(makeAuthenticatedStreamRequest({message:'Free chat'}) as any);
  await response.text();expect(routeMocks.skillMode).not.toHaveBeenCalled();expect(response.status).toBe(200);
 });
});

describe('provider usage settlement boundary',()=>{
 it.each([undefined,{}, {prompt_tokens:10,completion_tokens:-1}])('does not finalize success with missing or invalid usage %j',async usage=>{
  setupSkillRoute();fetchSpy.mockResolvedValue(new Response('data: '+JSON.stringify({choices:[{delta:{content:'answer'}}],usage})+'\n\ndata: [DONE]\n'));
  const response=await POST(makeAuthenticatedStreamRequest({moduleId:VALID_MODULE_ID}) as any);const text=await response.text();
  expect(text).toContain('"type":"error"');expect(routeMocks.billingFinalizeSuccess).not.toHaveBeenCalled();expect(routeMocks.billingFinalizeFailure).not.toHaveBeenCalled();
 });
 it('keeps provider zero instead of preflight estimates',async()=>{
  setupSkillRoute();fetchSpy.mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"cached answer"}}],"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\ndata: [DONE]'));
  const response=await POST(makeAuthenticatedStreamRequest({moduleId:VALID_MODULE_ID}) as any);await response.text();
  expect(routeMocks.billingFinalizeSuccess).toHaveBeenCalledWith(expect.objectContaining({usage:{inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0},tokenMetadata:expect.objectContaining({count_source:'provider_usage'})}));
 });
});


describe('ordinary HTTP handler admission regression', () => {
  // A real loopback HTTP client and server mount the shipped POST handler.
  // Identity/database fixtures are synthetic; the public guards are not mocked.
  // Provider requests cross a second real HTTP endpoint with an observed count.
  async function requestOverHTTP(token: string | null = 'test-token') {
    let providerCalls = 0;
    const server = createServer(async (req, res) => {
      if (req.url === '/provider') {
        providerCalls++;
        for await (const _chunk of req) { /* drain the real provider request */ }
        res.writeHead(200, {'Content-Type':'text/event-stream'}).end('data: {"choices":[{"delta":{"content":"Answer"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
        return;
      }
      try {
        const chunks: Buffer[]=[]; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request=new Request('http://127.0.0.1/api/ai/stream', {method:'POST',headers:req.headers as Record<string,string>,body:Buffer.concat(chunks)});
        const response=await POST(request as any);
        res.writeHead(response.status,Object.fromEntries(response.headers)).end(await response.text());
      } catch { res.writeHead(500).end('Test HTTP server failed'); }
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    fetchSpy.mockImplementation((_url,init)=>networkFetch(origin+'/provider',init));
    try {
      const response=await networkFetch(origin+'/api/ai/stream',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({message:'Hello',requestId:crypto.randomUUID()})});
      return {status:response.status,body:await response.text(),providerCalls};
    } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  }

  function admissionFixture(options: {user?: Record<string, unknown> | null; status?: unknown; hourly?: unknown; daily?: unknown; profileError?: boolean; role?: string; maintenance?: boolean; free?: boolean; freeCount?: number; balance?: number; rate?: boolean | 'unavailable'} = {}) {
    const { events, authenticatedClient, adminClient } = setupSkillRoute();
    // Resolve the same fixtures that the real route will receive; do not mock
    // email verification, profile admission or the public consumption guard.
    if ('user' in options) authenticatedClient.auth.getUser.mockResolvedValue({data:{user:options.user},error:null});
    let reads=0;
    const from = authenticatedClient.from.getMockImplementation();
    authenticatedClient.from.mockImplementation((table: string) => {
      if (table === 'billing_history') {
        const value=reads++===0 ? options.hourly : options.daily;
        return {select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),gte:vi.fn().mockResolvedValue(value ?? {data:[],error:null,count:0})};
      }
      if (table === 'ai_usage_logs') return {select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),gte:vi.fn().mockResolvedValue({count:options.freeCount ?? 0,error:null})};
      if (table !== 'profiles') return from(table);
      return {select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),single:vi.fn().mockResolvedValue({
        data: {status:'status' in options ? options.status : 'active',role:options.role ?? 'user'},
        error:options.profileError ? {message:'PRIVATE_DATABASE_DETAIL'} : null,
      })};
    });
    const adminFrom = adminClient.from.getMockImplementation();
    adminClient.from.mockImplementation((table:string) => {
      if(table==='system_settings' && options.maintenance) return {select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{value:true},error:null})};
      return adminFrom(table);
    });
    if (options.balance !== undefined) routeMocks.billingGetBalance.mockResolvedValue(options.balance);
    if (options.free) {
      const settings = routeMocks.getChatRuntimeSettings.getMockImplementation()!;
      routeMocks.getChatRuntimeSettings.mockImplementation(async()=>({...await settings(),enableFreeTier:true,freeTierMessages:3}));
    }
    if (options.rate !== undefined) routeMocks.checkRateLimit.mockResolvedValue({success:options.rate===true,limit:20,remaining:0,reset:Date.now()+60000,retryAfter:60,reason:options.rate==='unavailable'?'unavailable':'rate_limited'});
    return {events};
  }
  it('rejects an unauthenticated direct HTTP request before model or reservation',async()=>{
    const {events}=admissionFixture();
    const response=await requestOverHTTP(null);
    expect(response.status).toBe(401); expect(response.providerCalls).toBe(0);
    expect(events).toEqual([]); expect(routeMocks.billingPreDeduct).not.toHaveBeenCalled();
  });
  it.each([
    ['invalid session',{user:null},401],
    ['unverified email', {user:{id:'user-1',email:'fixture@example.test',app_metadata:{provider:'email'},user_metadata:{email_verified:true}}},403],
    ['disabled', {status:'disabled'},403],
    ['banned', {status:'banned'},403],
    ['null status', {status:null},503],
    ['unknown status', {status:'pending'},503],
    ['profile read error', {profileError:true},503],
    ['hourly limit', {hourly:{data:[{amount:-10000}],error:null,count:1}},403],
    ['daily limit', {daily:{data:[{amount:-50000}],error:null,count:1}},403],
    ['hourly query failure', {hourly:{data:null,error:{message:'PRIVATE_DATABASE_DETAIL'},count:null}},503],
    ['daily query failure', {daily:{data:null,error:{message:'PRIVATE_DATABASE_DETAIL'},count:null}},503],
    ['missing consumption rows', {hourly:{data:null,error:null,count:0}},503],
    ['invalid consumption amount', {hourly:{data:[{amount:null}],error:null,count:1}},503],
    ['truncated consumption rows', {hourly:{data:[{amount:-1}],error:null,count:1001}},503],
  ] as const)('denies %s before token/provider calls or pre-deduction',async (_name,options,status)=>{
    const {events}=admissionFixture(options);
    const response=await requestOverHTTP();
    const body=response.body;
    expect({status:response.status,events,providerCalls:response.providerCalls}).toEqual({status,events:[],providerCalls:0});
    expect(body).not.toContain('PRIVATE_DATABASE_DETAIL');
    expect(routeMocks.billingPreDeduct).not.toHaveBeenCalled();
    expect(routeMocks.countTokens).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it.each([
    ['confirmed email',{id:'user-1',email_confirmed_at:'2026-01-01T00:00:00Z'}],
    ['trusted Google OAuth',{id:'user-1',app_metadata:{provider:'google'}}],
    ['verified identity',{id:'user-1',identities:[{identity_data:{email_verified:true}}]}],
  ])('allows %s through the real handler with one limiter and one generation',async(_name,user)=>{
    const {events}=admissionFixture({user:user as Record<string,unknown>});
    const response=await requestOverHTTP();
    expect(response.body).toContain('"type":"complete"');
    expect(response.providerCalls).toBe(1);
    expect(response.status).toBe(200);
    expect(events).toEqual(['preDeduct']);
    expect(routeMocks.checkRateLimit).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['maintenance',{maintenance:true},503,0,0],
    ['rate limit',{rate:false},429,0,0],
    ['rate backend unavailable',{rate:'unavailable'},503,0,0],
    ['zero paid balance',{balance:0},402,0,0],
    ['eligible free trial',{free:true,balance:0},200,1,0],
    ['exhausted free trial',{free:true,balance:0,freeCount:3},402,0,0],
    ['maintenance administrator',{maintenance:true,role:'admin'},200,1,1],
  ] as const)('preserves %s through HTTP',async(_name,options,status,providers,reservations)=>{
    admissionFixture(options);
    const response=await requestOverHTTP();
    expect({status:response.status,providers:response.providerCalls,reservations:routeMocks.billingPreDeduct.mock.calls.length}).toEqual({status,providers,reservations});
    if(status===200) expect(response.body).toContain('"type":"complete"');
    expect(routeMocks.checkRateLimit.mock.calls.length).toBeLessThanOrEqual(1);
  });

});
