import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const billingState = vi.hoisted(() => ({
  constructorArgs: [] as Array<{ supabase: unknown; userId: string }>,
  checkIdempotency: vi.fn(),
  preDeduct: vi.fn(),
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
    preDeduct = billingState.preDeduct;
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
  billingState.preDeduct.mockReset();
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
    /function normalizeModuleId[\s\S]*?\n\}/,
  );

  expect(uuidPatternMatch).not.toBeNull();
  expect(moduleIdMatch).not.toBeNull();
  const helperSource = moduleIdMatch![0];
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

  describe('closed sendMessage endpoint (P0-2)', () => {
    const closedError = {
      code: 'BAD_REQUEST',
      message: 'ai.sendMessage 已关闭，请使用 /api/ai/stream + useStreamingChat。',
    };

    function createActiveUserClients() {
      const userRpc = vi.fn(() => {
        throw new Error('closed sendMessage dispatched a user-scoped RPC');
      });
      const userFrom = vi.fn((table: string) => {
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

        throw new Error(`closed sendMessage read ${table}`);
      });
      const adminRpc = vi.fn(() => {
        throw new Error('closed sendMessage dispatched an admin RPC');
      });
      const adminFrom = vi.fn((table: string) => {
        throw new Error(`closed sendMessage used the admin client for ${table}`);
      });

      return {
        supabase: { from: userFrom, rpc: userRpc },
        supabaseAdmin: { from: adminFrom, rpc: adminRpc },
        userFrom,
        userRpc,
        adminFrom,
        adminRpc,
      };
    }

    it.each([
      ['the former request shape', {
        message: 'hello',
        requestId: '123e4567-e89b-42d3-a456-426614174000',
        modelId: '123e4567-e89b-42d3-a456-426614174002',
      }],
      ['no input', undefined],
    ])('rejects a signed-in user with %s before billing or a provider call', async (_label, input) => {
      const fetchSpy = vi.fn(async () => {
        throw new Error('closed sendMessage called the model provider');
      });
      vi.stubGlobal('fetch', fetchSpy);
      const clients = createActiveUserClients();
      const caller = createProtectedCaller(clients.supabase, clients.supabaseAdmin);
      const sendMessage = caller.sendMessage as (value?: unknown) => Promise<unknown>;

      try {
        await expect(sendMessage(input)).rejects.toMatchObject<Partial<TRPCError>>(closedError);
      } finally {
        vi.unstubAllGlobals();
      }

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(billingState.constructorArgs).toHaveLength(0);
      expect(billingState.checkIdempotency).not.toHaveBeenCalled();
      expect(billingState.preDeduct).not.toHaveBeenCalled();
      expect(clients.adminRpc).not.toHaveBeenCalled();
      expect(clients.adminFrom).not.toHaveBeenCalled();
      expect(clients.userRpc).not.toHaveBeenCalled();
      expect(clients.userFrom.mock.calls.map(([table]) => table)).toEqual(['profiles']);
    });

    it('still requires sign-in before reaching the closed handler', async () => {
      const caller = aiRouter.createCaller({
        headers: new Headers(),
        user: null,
        isEmailVerified: false,
        supabase: {},
        supabaseAuth: {},
        supabasePublic: {},
        supabaseAdmin: {},
        hasSupabaseAdminPrivileges: true,
      } as any);

      await expect(caller.sendMessage()).rejects.toMatchObject<Partial<TRPCError>>({
        code: 'UNAUTHORIZED',
      });
      expect(billingState.constructorArgs).toHaveLength(0);
    });

    it('keeps billing, model routing and provider code out of the closed handler', () => {
      const source = readFileSync(new URL('./ai.ts', import.meta.url), 'utf8');
      const sendMessageBody = source.slice(
        source.indexOf('sendMessage: protectedProcedure'),
        source.indexOf('abortRequest: protectedProcedure'),
      );

      expect(sendMessageBody).toContain('AI_SEND_MESSAGE_CLOSED_MESSAGE');
      expect(sendMessageBody).not.toMatch(
        /ctx|BillingService|preDeduct|selectModel|callClaudeViaOpenRouter|fetch\(/,
      );
    });
  });

  it.each([0, 10, 999999])('rejects client token settlement (%s) without accounting writes', async count => {
    const supabase = {from: () => createSingleQueryBuilder(Promise.resolve({data:{id:'user-1',role:'user',status:'active',nickname:'User',email:'user@example.com'},error:null}))};
    const caller = createProtectedCaller(supabase, {client:'admin'});
    await expect(caller.abortRequest({requestId:'123e4567-e89b-42d3-a456-426614174000',preDeductId:'123e4567-e89b-42d3-a456-426614174001',consumedTokens:{inputTokens:count,outputTokens:count},modelId:'spoofed-model'})).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
    expect(billingState.constructorArgs).toHaveLength(0);
    expect(billingState.settleAbort).not.toHaveBeenCalled();
    expect(billingState.recordUsageLog).not.toHaveBeenCalled();
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

});
