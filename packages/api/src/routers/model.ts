import { router, adminProcedure, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

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
          is_active: 'true',
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data;
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
      config: z.record(z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
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

      const { data, error } = await ctx.supabase
        .from('ai_models')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data;
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
        .select('id, name, model_id, provider, api_key, api_endpoint')
        .eq('id', input.id)
        .single();

      if (fetchError || !model) {
        return {
          success: false,
          error: '模型不存在',
          status: 'not_found' as const,
        };
      }

      // Check if API key is configured
      const apiKey = model.api_key || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return {
          success: false,
          error: 'API 密钥未配置',
          status: 'no_key' as const,
        };
      }

      // Test the API connection based on provider
      try {
        if (model.provider === 'anthropic' || !model.provider) {
          // Test Anthropic API
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
            // Update last tested time in config
            await ctx.supabase
              .from('ai_models')
              .update({
                config: {
                  ...(model as any).config,
                  last_tested: new Date().toISOString(),
                  connection_status: 'connected',
                },
                updated_at: new Date().toISOString(),
              })
              .eq('id', input.id);

            return {
              success: true,
              status: 'connected' as const,
              message: 'API 连接正常',
            };
          } else {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = (errorData as any).error?.message || `HTTP ${response.status}`;

            // Update config with error status
            await ctx.supabase
              .from('ai_models')
              .update({
                config: {
                  ...(model as any).config,
                  last_tested: new Date().toISOString(),
                  connection_status: 'error',
                  last_error: errorMessage,
                },
                updated_at: new Date().toISOString(),
              })
              .eq('id', input.id);

            return {
              success: false,
              error: errorMessage,
              status: 'error' as const,
            };
          }
        } else {
          // For other providers, just check if API key exists
          return {
            success: true,
            status: 'configured' as const,
            message: 'API 密钥已配置（未测试连接）',
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '连接失败';

        // Update config with error status
        await ctx.supabase
          .from('ai_models')
          .update({
            config: {
              ...(model as any).config,
              last_tested: new Date().toISOString(),
              connection_status: 'error',
              last_error: errorMessage,
            },
            updated_at: new Date().toISOString(),
          })
          .eq('id', input.id);

        return {
          success: false,
          error: errorMessage,
          status: 'error' as const,
        };
      }
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
      const hasApiKey = !!(model.api_key || process.env.ANTHROPIC_API_KEY);

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
