import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const billingState = vi.hoisted(() => ({
  constructorArgs: [] as Array<{ supabase: unknown; userId: string }>,
  checkIdempotency: vi.fn(),
  settleAbort: vi.fn(),
  recordUsageLog: vi.fn(),
}));

vi.mock('../services', async () => {
  const actual = await vi.importActual<typeof import('../services')>('../services');

  class BillingService {
    constructor(ctx: { supabase: unknown; userId: string }) {
      billingState.constructorArgs.push(ctx);
    }

    checkIdempotency = billingState.checkIdempotency;
    settleAbort = billingState.settleAbort;
    recordUsageLog = billingState.recordUsageLog;
  }

  return {
    ...actual,
    BillingService,
  };
});

import { aiRouter } from './ai';

beforeEach(() => {
  billingState.constructorArgs.length = 0;
  billingState.checkIdempotency.mockReset();
  billingState.settleAbort.mockReset();
  billingState.recordUsageLog.mockReset();
});

function createSingleQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    single() {
      return result;
    },
  };
}

function createProtectedCaller(
  supabase: { from(table: string): unknown },
  supabaseAdmin: unknown = {},
  hasSupabaseAdminPrivileges = true,
) {
  return aiRouter.createCaller({
    headers: new Headers(),
    user: {
      id: 'user-1',
      email: 'user@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase,
    supabaseAuth: supabase,
    supabasePublic: {},
    supabaseAdmin,
    hasSupabaseAdminPrivileges,
  } as any);
}

function getStreamRouteSource() {
  return readFileSync(
    new URL('../../../../apps/web/src/app/api/ai/stream/route.ts', import.meta.url),
    'utf8',
  );
}

function loadNormalizeModuleIdForTest() {
  const source = getStreamRouteSource();
  const uuidPatternMatch = source.match(
    /const UUID_PATTERN =\n\s+\/\^\[0-9a-f\]\{8\}-[\s\S]*?\/i;/,
  );
  const moduleIdMatch = source.match(
    /function normalizeModuleId[\s\S]*?\n\}\n\nasync function getUserSecurityProfile/,
  );

  expect(uuidPatternMatch).not.toBeNull();
  expect(moduleIdMatch).not.toBeNull();
  const helperSource = moduleIdMatch![0].slice(
    0,
    moduleIdMatch![0].lastIndexOf('\n\nasync function getUserSecurityProfile'),
  );
  const runnableSource = helperSource.replace(
    /function normalizeModuleId\(moduleId\?: unknown\): string \| undefined/,
    'function normalizeModuleId(moduleId)',
  );

  return runInNewContext(
    `${uuidPatternMatch![0]}\n\n${runnableSource}\nnormalizeModuleId;`,
  ) as (moduleId?: unknown) => string | undefined;
}

describe('aiRouter error sanitization', () => {
  it('does not use hardcoded estimateRequestCost in the non-stream router', () => {
    const source = readFileSync(new URL('./ai.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('estimateRequestCost');
    expect(source).not.toMatch(/from ['"].*costCalculator['"]/);
    expect(source).not.toContain('defaultCalculator');
    expect(source).not.toContain('CostCalculator');
    expect(source).toContain('getBillingRuntimeSettings');
    expect(source).toContain('estimatePreDeductCredits');
  });

  it('does not import legacy costCalculator helpers in production stream billing', () => {
    const source = getStreamRouteSource();

    expect(source).not.toMatch(/from ['"].*costCalculator['"]/);
    expect(source).not.toContain('defaultCalculator');
    expect(source).not.toContain('CostCalculator');
  });

  describe('production stream moduleId validation', () => {
    const validModuleId = '00000000-0000-4000-8000-000000000001';

    it('passes a valid UUID moduleId through unchanged', () => {
      const normalizeModuleId = loadNormalizeModuleIdForTest();

      expect(normalizeModuleId(validModuleId)).toBe(validModuleId);
    });

    it('maps an invalid string moduleId to the existing invalid-module response path', () => {
      const normalizeModuleId = loadNormalizeModuleIdForTest();

      expect(normalizeModuleId('not-a-module-id')).toBe('');
    });

    it('keeps the invalid-module sentinel wired to the existing 400 response', () => {
      const source = getStreamRouteSource();
      const invalidModuleResponseBlock = source.slice(
        source.indexOf("if (moduleId === '')"),
        source.indexOf('const authHeader'),
      );

      expect(invalidModuleResponseBlock).toContain('功能模块参数无效，请返回功能广场重新选择');
      expect(invalidModuleResponseBlock).toContain('status: 400');
    });

    it('maps a numeric moduleId to the existing invalid-module response path without throwing', () => {
      const normalizeModuleId = loadNormalizeModuleIdForTest();

      expect(() => normalizeModuleId(123)).not.toThrow();
      expect(normalizeModuleId(123)).toBe('');
    });

    it('maps object and array moduleId values to the existing invalid-module response path without throwing', () => {
      const normalizeModuleId = loadNormalizeModuleIdForTest();

      expect(() => normalizeModuleId({ id: validModuleId })).not.toThrow();
      expect(() => normalizeModuleId([validModuleId])).not.toThrow();
      expect(normalizeModuleId({ id: validModuleId })).toBe('');
      expect(normalizeModuleId([validModuleId])).toBe('');
    });

    it('preserves omitted and empty moduleId behavior', () => {
      const normalizeModuleId = loadNormalizeModuleIdForTest();

      expect(normalizeModuleId()).toBeUndefined();
      expect(normalizeModuleId(null)).toBeUndefined();
      expect(normalizeModuleId('')).toBeUndefined();
      expect(normalizeModuleId('   ')).toBeUndefined();
    });
  });

  it('uses the admin client for sendMessage billing writes while preserving user-scoped reads', () => {
    const source = readFileSync(new URL('./ai.ts', import.meta.url), 'utf8');
    const sendMessageBody = source.slice(
      source.indexOf('sendMessage: protectedProcedure'),
      source.indexOf('abortRequest: protectedProcedure'),
    );

    expect(sendMessageBody).toContain('new BillingService({\n        supabase: ctx.supabaseAdmin');
    expect(sendMessageBody).toContain('getOrCreateConversation(\n        ctx.supabase');
    expect(sendMessageBody).toContain('getConversationHistory(ctx.supabase');
    expect(sendMessageBody).toContain('{ supabase: ctx.supabase, userId: ctx.profileId }');
  });

  it('lets a regular user reach sendMessage billing with the admin client', async () => {
    const stopAfterBillingConstruction = new Error('stop-after-billing-construction');
    billingState.checkIdempotency.mockRejectedValueOnce(stopAfterBillingConstruction);
    const supabaseAdmin = { client: 'admin' };
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller(supabase, supabaseAdmin);

    await expect(caller.sendMessage({
      message: 'hello',
      requestId: '123e4567-e89b-42d3-a456-426614174000',
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: stopAfterBillingConstruction.message,
    });

    expect(billingState.constructorArgs[0]).toMatchObject({
      supabase: supabaseAdmin,
      userId: 'user-1',
    });
  });

  it('fails fast before sendMessage billing when admin privileges are unavailable', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller(supabase, { client: 'anon-fallback' }, false);

    await expect(caller.sendMessage({
      message: 'hello',
      requestId: '123e4567-e89b-42d3-a456-426614174000',
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: 'AI 计费服务暂不可用，请稍后重试',
    });

    expect(billingState.constructorArgs).toHaveLength(0);
    expect(billingState.checkIdempotency).not.toHaveBeenCalled();
  });

  it('uses the admin client for abortRequest billing writes', async () => {
    billingState.settleAbort.mockResolvedValueOnce({
      consumedCredits: 1,
      refundedCredits: 9,
      balanceAfter: 991,
    });
    billingState.recordUsageLog.mockResolvedValueOnce(undefined);
    const supabaseAdmin = { client: 'admin' };
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller(supabase, supabaseAdmin);

    await expect(caller.abortRequest({
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      preDeductId: '123e4567-e89b-42d3-a456-426614174001',
      consumedTokens: {
        inputTokens: 10,
        outputTokens: 20,
      },
      modelId: 'dynamic-model',
    })).resolves.toMatchObject({
      success: true,
      consumedCredits: 1,
      refundedCredits: 9,
    });

    expect(billingState.constructorArgs[0]).toMatchObject({
      supabase: supabaseAdmin,
      userId: 'user-1',
    });
  });

  it('fails fast before abortRequest billing when admin privileges are unavailable', async () => {
    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller(supabase, { client: 'anon-fallback' }, false);

    await expect(caller.abortRequest({
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      preDeductId: '123e4567-e89b-42d3-a456-426614174001',
      consumedTokens: {
        inputTokens: 10,
        outputTokens: 20,
      },
      modelId: 'dynamic-model',
    })).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'SERVICE_UNAVAILABLE',
      message: 'AI 计费服务暂不可用，请稍后重试',
    });

    expect(billingState.constructorArgs).toHaveLength(0);
    expect(billingState.settleAbort).not.toHaveBeenCalled();
    expect(billingState.recordUsageLog).not.toHaveBeenCalled();
  });

  it('records abort pricing metadata from settleAbort in the usage log', async () => {
    billingState.settleAbort.mockResolvedValueOnce({
      consumedCredits: 1,
      refundedCredits: 9,
      balanceAfter: 991,
      pricing: {
        modelId: 'dynamic-model',
        inputPer1M: 2,
        outputPer1M: 4,
        searchPer1K: 0,
        pricingSource: 'ai_models',
      },
      billingSettingsSnapshot: {
        creditsPerUsd: 100,
        tokenPriceMultiplier: 2,
        minPreDeduct: 10,
        maxPreDeduct: 10000,
        safetyMargin: 0.2,
      },
    });
    billingState.recordUsageLog.mockResolvedValueOnce(undefined);

    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller(supabase);

    await expect(caller.abortRequest({
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      preDeductId: '123e4567-e89b-42d3-a456-426614174001',
      consumedTokens: {
        inputTokens: 10,
        outputTokens: 20,
      },
      modelId: 'dynamic-model',
    })).resolves.toMatchObject({
      success: true,
      consumedCredits: 1,
      refundedCredits: 9,
    });

    expect(billingState.recordUsageLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        pricing: expect.objectContaining({
          modelId: 'dynamic-model',
          inputPer1M: 2,
          outputPer1M: 4,
          searchPer1K: 0,
          pricingSource: 'ai_models',
        }),
        billingSettingsSnapshot: expect.objectContaining({
          creditsPerUsd: 100,
          tokenPriceMultiplier: 2,
        }),
      }),
    }));
  });

  it('sanitizes abortRequest settlement failures', async () => {
    billingState.settleAbort.mockRejectedValueOnce(
      new Error('relation ai_usage_logs does not exist'),
    );

    const supabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createSingleQueryBuilder(
            Promise.resolve({
              data: {
                id: 'user-1',
                role: 'user',
                status: 'active',
                nickname: 'User',
                email: 'user@example.com',
              },
              error: null,
            }),
          );
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const caller = createProtectedCaller(supabase);

    await expect(
      caller.abortRequest({
        requestId: '123e4567-e89b-42d3-a456-426614174000',
        preDeductId: '123e4567-e89b-42d3-a456-426614174001',
        consumedTokens: {
          inputTokens: 10,
          outputTokens: 20,
        },
        modelId: 'claude-3-5-sonnet',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '中断结算失败，请稍后重试',
    });
  });
});
