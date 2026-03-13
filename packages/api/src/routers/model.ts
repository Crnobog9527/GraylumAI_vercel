import { router, adminProcedure, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  getConfiguredProviderApiKey,
  getOpenAICompatibleHeaders,
  getProviderErrorMessage,
  normalizeOpenAICompatibleEndpoint,
  usesOpenAICompatibleApi as usesOpenAICompatibleProvider,
} from '../services/providerUtils';

type PersistedModel = {
  id: string;
  name: string;
  model_id: string;
  provider: 'anthropic' | 'openai' | 'google' | 'custom' | 'builtin' | null;
  api_key?: string | null;
  api_endpoint?: string | null;
  config?: Record<string, unknown> | null;
};

type ConnectionCheckResult = {
  success: boolean;
  status: 'connected' | 'configured' | 'error' | 'no_key' | 'not_found';
  message?: string;
  error?: string;
};

type TokenCountingMetadata = {
  token_counting_supported: 'true' | 'false';
  token_counting_method: string;
  tokenizer_family: string | null;
};

const VERIFIED_OPENAI_TOKENIZER_PREFIXES = [
  'gpt-4.1',
  'gpt-4o',
  'gpt-4.5',
  'gpt-5',
  'o1',
  'o3',
  'text-embedding-3',
];

function inferTokenCountingMetadata(params: {
  provider: PersistedModel['provider'] | NonNullable<PersistedModel['provider']>;
  modelId: string;
  apiEndpoint?: string | null;
}): TokenCountingMetadata {
  const provider = params.provider ?? 'custom';
  const modelId = params.modelId.toLowerCase();
  const endpoint = params.apiEndpoint?.toLowerCase() ?? '';

  if (provider === 'anthropic') {
    return {
      token_counting_supported: 'true',
      token_counting_method: 'anthropic_count_tokens',
      tokenizer_family: 'anthropic',
    };
  }

  if (provider === 'google') {
    return {
      token_counting_supported: 'true',
      token_counting_method: 'gemini_count_tokens',
      tokenizer_family: 'gemini',
    };
  }

  const openAITokenizerVerified = VERIFIED_OPENAI_TOKENIZER_PREFIXES.some((prefix) => modelId.startsWith(prefix));
  const openAICompatibleProvider = provider === 'openai' || endpoint.includes('openrouter') || endpoint.includes('chat/completions');

  if (openAICompatibleProvider && openAITokenizerVerified) {
    return {
      token_counting_supported: 'true',
      token_counting_method: 'verified_openai_tokenizer',
      tokenizer_family: 'openai',
    };
  }

  return {
    token_counting_supported: 'false',
    token_counting_method: 'unsupported',
    tokenizer_family: openAICompatibleProvider ? 'openai' : null,
  };
}

function usesOpenAICompatibleApi(model: PersistedModel) {
  return usesOpenAICompatibleProvider({
    endpoint: model.api_endpoint,
    apiKey: model.api_key,
  });
}

async function persistConnectionState(
  supabase: any,
  model: PersistedModel,
  result: ConnectionCheckResult,
) {
  const currentConfig = (model.config as Record<string, unknown> | null) ?? {};
  const nextConfig: Record<string, unknown> = {
    ...currentConfig,
    last_tested: new Date().toISOString(),
    connection_status: result.status,
  };

  if (result.success) {
    nextConfig.last_error = null;
  } else if (result.error) {
    nextConfig.last_error = result.error;
  }

  await supabase
    .from('ai_models')
    .update({
      config: nextConfig,
      updated_at: new Date().toISOString(),
    })
    .eq('id', model.id);
}

async function verifyAndPersistConnection(
  supabase: any,
  model: PersistedModel,
): Promise<ConnectionCheckResult> {
  const apiKey = getConfiguredProviderApiKey(model.api_key);
  if (!apiKey) {
    const result: ConnectionCheckResult = {
      success: false,
      status: 'no_key',
      error: 'API 密钥未配置',
    };
    await persistConnectionState(supabase, model, result);
    return result;
  }

  try {
    const openAICompatibleEndpoint = usesOpenAICompatibleApi(model)
      ? (normalizeOpenAICompatibleEndpoint(model.api_endpoint) || 'https://openrouter.ai/api/v1/chat/completions')
      : null;

    if (openAICompatibleEndpoint) {
      const response = await fetch(openAICompatibleEndpoint, {
        method: 'POST',
        headers: getOpenAICompatibleHeaders(apiKey),
        body: JSON.stringify({
          model: model.model_id,
          max_tokens: 1,
          stream: true,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });

      if (response.ok) {
        const result: ConnectionCheckResult = {
          success: true,
          status: 'connected',
          message: 'OpenRouter / OpenAI 兼容接口连接正常',
        };
        await persistConnectionState(supabase, model, result);
        return result;
      }

      const errorMessage = await getProviderErrorMessage(response);
      const result: ConnectionCheckResult = {
        success: false,
        status: 'error',
        error: errorMessage,
      };
      await persistConnectionState(supabase, model, result);
      return result;
    }

    if (model.provider !== 'anthropic' && model.provider) {
      const result: ConnectionCheckResult = {
        success: true,
        status: 'configured',
        message: 'API 密钥已保存，请配置 OpenAI / OpenRouter 兼容 endpoint 后再测试连接',
      };
      await persistConnectionState(supabase, model, result);
      return result;
    }

    const endpoint = model.api_endpoint || 'https://api.anthropic.com/v1/messages';
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model.model_id,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    if (response.ok) {
      const result: ConnectionCheckResult = {
        success: true,
        status: 'connected',
        message: 'API 连接正常',
      };
      await persistConnectionState(supabase, model, result);
      return result;
    }

    const errorMessage = await getProviderErrorMessage(response);
    const result: ConnectionCheckResult = {
      success: false,
      status: 'error',
      error: errorMessage,
    };
    await persistConnectionState(supabase, model, result);
    return result;
  } catch (error) {
    const result: ConnectionCheckResult = {
      success: false,
      status: 'error',
      error: error instanceof Error ? error.message : '连接失败',
    };
    await persistConnectionState(supabase, model, result);
    return result;
  }
}

export const modelRouter = router({
  // Public: Get active AI models for users to select
  getActiveModels: protectedProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('ai_models')
      .select('id, name, model_id, provider, description, enable_web_search, max_tokens')
      .eq('is_active', 'true')
      .order('name');

    if (error) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
    return data;
  }),

  // Admin only: Get all AI models including inactive
  getAvailableModels: adminProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('ai_models')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
    return data;
  }),

  // Admin only: Create a new AI model
  createModel: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      modelId: z.string().min(1).max(100),
      provider: z.enum(['anthropic', 'openai', 'google', 'custom', 'builtin']).default('anthropic'),
      apiKey: z.string().optional(),
      apiEndpoint: z.string().optional(),
      description: z.string().optional(),
      maxTokens: z.number().int().min(256).default(4096),
      inputLimit: z.number().int().min(1000).default(180000),
      enableWebSearch: z.boolean().default(false),
      inputTokenCost: z.number().min(0).default(0),
      outputTokenCost: z.number().min(0).default(0),
      inputTokenCostAbove200k: z.number().min(0).default(0),
      outputTokenCostAbove200k: z.number().min(0).default(0),
      webSearchCost: z.number().min(0).default(0),
    }))
    .mutation(async ({ ctx, input }) => {
      const tokenCountingMetadata = inferTokenCountingMetadata({
        provider: input.provider,
        modelId: input.modelId,
        apiEndpoint: input.apiEndpoint,
      });

      const { data, error } = await ctx.supabase
        .from('ai_models')
        .insert({
          name: input.name,
          model_id: input.modelId,
          provider: input.provider,
          api_key: input.apiKey,
          api_endpoint: input.apiEndpoint,
          description: input.description,
          max_tokens: input.maxTokens,
          input_limit: input.inputLimit,
          enable_web_search: input.enableWebSearch ? 'true' : 'false',
          input_token_cost: Math.round(input.inputTokenCost * 100), // Store as cents
          output_token_cost: Math.round(input.outputTokenCost * 100),
          input_token_cost_above_200k: Math.round(input.inputTokenCostAbove200k * 100),
          output_token_cost_above_200k: Math.round(input.outputTokenCostAbove200k * 100),
          web_search_cost: Math.round(input.webSearchCost * 100),
          token_counting_supported: tokenCountingMetadata.token_counting_supported,
          token_counting_method: tokenCountingMetadata.token_counting_method,
          tokenizer_family: tokenCountingMetadata.tokenizer_family,
          is_active: 'true',
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      const connectionCheck = await verifyAndPersistConnection(ctx.supabase, data as PersistedModel);
      return {
        ...data,
        connectionCheck,
      };
    }),

  // Admin only: Update AI model
  updateModel: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      modelId: z.string().min(1).max(100).optional(),
      provider: z.enum(['anthropic', 'openai', 'google', 'custom', 'builtin']).optional(),
      apiKey: z.string().optional(),
      apiEndpoint: z.string().optional(),
      description: z.string().optional(),
      maxTokens: z.number().int().min(256).optional(),
      inputLimit: z.number().int().min(1000).optional(),
      enableWebSearch: z.boolean().optional(),
      inputTokenCost: z.number().min(0).optional(),
      outputTokenCost: z.number().min(0).optional(),
      inputTokenCostAbove200k: z.number().min(0).optional(),
      outputTokenCostAbove200k: z.number().min(0).optional(),
      webSearchCost: z.number().min(0).optional(),
      isActive: z.boolean().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const currentModel = await ctx.supabase
        .from('ai_models')
        .select('provider, model_id, api_endpoint')
        .eq('id', input.id)
        .single();

      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      if (input.name !== undefined) updateData.name = input.name;
      if (input.modelId !== undefined) updateData.model_id = input.modelId;
      if (input.provider !== undefined) updateData.provider = input.provider;
      if (input.apiKey !== undefined) updateData.api_key = input.apiKey;
      if (input.apiEndpoint !== undefined) updateData.api_endpoint = input.apiEndpoint;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.maxTokens !== undefined) updateData.max_tokens = input.maxTokens;
      if (input.inputLimit !== undefined) updateData.input_limit = input.inputLimit;
      if (input.enableWebSearch !== undefined) updateData.enable_web_search = input.enableWebSearch ? 'true' : 'false';
      if (input.inputTokenCost !== undefined) updateData.input_token_cost = Math.round(input.inputTokenCost * 100);
      if (input.outputTokenCost !== undefined) updateData.output_token_cost = Math.round(input.outputTokenCost * 100);
      if (input.inputTokenCostAbove200k !== undefined) updateData.input_token_cost_above_200k = Math.round(input.inputTokenCostAbove200k * 100);
      if (input.outputTokenCostAbove200k !== undefined) updateData.output_token_cost_above_200k = Math.round(input.outputTokenCostAbove200k * 100);
      if (input.webSearchCost !== undefined) updateData.web_search_cost = Math.round(input.webSearchCost * 100);
      if (input.isActive !== undefined) updateData.is_active = input.isActive ? 'true' : 'false';
      if (input.config !== undefined) updateData.config = input.config;

      const nextProvider = input.provider ?? currentModel.data?.provider ?? 'custom';
      const nextModelId = input.modelId ?? currentModel.data?.model_id;
      const nextEndpoint = input.apiEndpoint ?? currentModel.data?.api_endpoint ?? null;

      if (nextModelId) {
        const tokenCountingMetadata = inferTokenCountingMetadata({
          provider: nextProvider,
          modelId: nextModelId,
          apiEndpoint: nextEndpoint,
        });
        updateData.token_counting_supported = tokenCountingMetadata.token_counting_supported;
        updateData.token_counting_method = tokenCountingMetadata.token_counting_method;
        updateData.tokenizer_family = tokenCountingMetadata.tokenizer_family;
      }

      const { data, error } = await ctx.supabase
        .from('ai_models')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      const shouldVerifyConnection =
        input.apiKey !== undefined ||
        input.apiEndpoint !== undefined ||
        input.modelId !== undefined ||
        input.provider !== undefined;

      const connectionCheck = shouldVerifyConnection
        ? await verifyAndPersistConnection(ctx.supabase, data as PersistedModel)
        : null;

      return {
        ...data,
        connectionCheck,
      };
    }),

  // Admin only: Delete AI model
  deleteModel: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.supabase
        .from('ai_models')
        .delete()
        .eq('id', input.id);

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return { success: true };
    }),

  // Legacy: Update AI model configuration (kept for backwards compatibility)
  updateModelConfig: adminProcedure
    .input(z.object({ id: z.string().uuid(), config: z.any() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('ai_models')
        .update({ config: input.config, updated_at: new Date().toISOString() })
        .eq('id', input.id)
        .select();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data;
    }),

  // Admin only: Test API connection for a model
  testConnection: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get model details
      const { data: model, error: fetchError } = await ctx.supabase
        .from('ai_models')
        .select('id, name, model_id, provider, api_key, api_endpoint, config')
        .eq('id', input.id)
        .single();

      if (fetchError || !model) {
        return {
          success: false,
          error: '模型不存在',
          status: 'not_found' as const,
        };
      }

      return verifyAndPersistConnection(ctx.supabase, model as PersistedModel);
    }),

  // Admin only: Get connection status for all models
  getConnectionStatus: adminProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('ai_models')
      .select('id, name, api_key, config, is_active')
      .order('name');

    if (error) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
    }

    return (data || []).map(model => {
      const config = (model.config as any) || {};
      // 只检查模型自身的 api_key，不再回退到环境变量
      const hasApiKey = !!model.api_key;

      return {
        id: model.id,
        name: model.name,
        isActive: model.is_active === 'true',
        hasApiKey,
        connectionStatus: config.connection_status || (hasApiKey ? 'untested' : 'no_key'),
        lastTested: config.last_tested || null,
        lastError: config.last_error || null,
      };
    });
  }),
});
