import { createTRPCContext, router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createSafeInternalError } from '../lib/publicError';
import { logger } from '../lib/logger';

type ExportFormat = 'json' | 'markdown' | 'txt';
type BaseContext = Awaited<ReturnType<typeof createTRPCContext>>;
type ProtectedContext = BaseContext & {
  profileId: string;
  userRole: 'user' | 'admin';
  user: NonNullable<BaseContext['user']>;
};

interface ExportConversationRecord {
  id: string;
  title: string | null;
  created_at: string;
}

interface ExportMessageRecord {
  role: string;
  content: string;
  created_at: string;
}

interface ConversationStatsSource {
  id: string;
}

interface ConversationMessageCountRow {
  conversation_id: string | null;
}

interface ConversationCreditsRow {
  conversation_id: string | null;
  total_credits: number | null;
}

export function buildConversationStats<T extends ConversationStatsSource>(
  conversations: T[],
  messageRows: ConversationMessageCountRow[],
  creditRows: ConversationCreditsRow[],
) {
  const messageCountByConversation = new Map<string, number>();
  for (const row of messageRows) {
    if (!row.conversation_id) {
      continue;
    }
    messageCountByConversation.set(
      row.conversation_id,
      (messageCountByConversation.get(row.conversation_id) ?? 0) + 1,
    );
  }

  const creditsByConversation = new Map<string, number>();
  for (const row of creditRows) {
    if (!row.conversation_id) {
      continue;
    }
    creditsByConversation.set(
      row.conversation_id,
      (creditsByConversation.get(row.conversation_id) ?? 0) + (row.total_credits ?? 0),
    );
  }

  return conversations.map((conversation) => ({
    ...conversation,
    message_count: messageCountByConversation.get(conversation.id) ?? 0,
    credits_used: creditsByConversation.get(conversation.id) ?? 0,
  }));
}

export async function getConversationsWithStats(
  ctx: Pick<ProtectedContext, 'supabase' | 'profileId'>,
) {
  const { data: conversations, error } = await ctx.supabase
    .from('conversations')
    .select('*')
    .eq('user_id', ctx.profileId)
    .eq('is_deleted', 'false')
    .order('created_at', { ascending: false });

  if (error || !conversations) {
    if (error) {
      logger.error('ai', 'chat_conversations_fetch_failed', {
        code: error.code,
      });
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '获取对话列表失败，请稍后重试',
    });
  }

  if (conversations.length === 0) {
    return { data: [], error: null };
  }

  const conversationIds = conversations.map((conversation) => conversation.id);
  const [{ data: messageRows, error: messageError }, { data: creditRows, error: creditsError }] =
    await Promise.all([
      ctx.supabase
        .from('messages')
        .select('conversation_id')
        .in('conversation_id', conversationIds)
        .eq('is_deleted', 'false'),
      ctx.supabase
        .from('token_stats')
        .select('conversation_id, total_credits')
        .eq('user_id', ctx.profileId)
        .in('conversation_id', conversationIds),
    ]);

  if (messageError || creditsError) {
    logger.error('ai', 'chat_conversation_stats_aggregate_failed', {
      messageErrorCode: messageError?.code,
      creditsErrorCode: creditsError?.code,
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '获取对话统计失败，请稍后重试',
    });
  }

  return {
    data: buildConversationStats(
      conversations,
      (messageRows ?? []) as ConversationMessageCountRow[],
      (creditRows ?? []) as ConversationCreditsRow[],
    ),
    error: null,
  };
}

async function assertExportPermission(ctx: ProtectedContext) {
  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('membership_level')
    .eq('id', ctx.profileId)
    .single();

  if (!profile) {
    throw new TRPCError({ code: 'FORBIDDEN', message: '用户不存在' });
  }

  const { data: plan } = await ctx.supabase
    .from('membership_plans')
    .select('allow_export, allow_batch_export')
    .eq('level', profile.membership_level)
    .eq('is_active', 'true')
    .single();

  return {
    membershipLevel: profile.membership_level,
    allowExport: plan?.allow_export === 'true',
    allowBatchExport: plan?.allow_batch_export === 'true',
  };
}

async function loadConversationExportData(
  ctx: ProtectedContext,
  conversations: ExportConversationRecord[]
) {
  if (conversations.length === 0) {
    return [];
  }

  const conversationIds = conversations.map((conversation) => conversation.id);
  const { data: messages, error } = await ctx.supabase
    .from('messages')
    .select('conversation_id, role, content, created_at')
    .in('conversation_id', conversationIds)
    .eq('is_deleted', 'false')
    .order('created_at', { ascending: true });

  if (error) {
    throw createSafeInternalError(error, '导出对话失败，请稍后重试');
  }

  const messagesByConversationId = new Map<string, ExportMessageRecord[]>();
  for (const message of (messages ?? []) as Array<ExportMessageRecord & { conversation_id: string | null }>) {
    if (!message.conversation_id) {
      continue;
    }

    const existingMessages = messagesByConversationId.get(message.conversation_id) ?? [];
    existingMessages.push({
      role: message.role,
      content: message.content,
      created_at: message.created_at,
    });
    messagesByConversationId.set(message.conversation_id, existingMessages);
  }

  return conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.created_at,
    messages: messagesByConversationId.get(conversation.id) ?? [],
  }));
}

function buildConversationExportPayload(
  conversations: Awaited<ReturnType<typeof loadConversationExportData>>,
  format: ExportFormat,
  filenameBase: string
) {
  if (conversations.length === 1) {
    const [conversation] = conversations;
    const title = conversation.title || '未命名对话';
    const createdAt = new Date(conversation.createdAt).toLocaleString('zh-CN');

    if (format === 'json') {
      return {
        filename: `${filenameBase}.json`,
        content: JSON.stringify(
          {
            title,
            createdAt: conversation.createdAt,
            messages: conversation.messages,
          },
          null,
          2
        ),
        mimeType: 'application/json',
      };
    }

    if (format === 'txt') {
      const lines = [`对话: ${title}`, `创建时间: ${createdAt}`, '', '---', ''];
      conversation.messages.forEach((message) => {
        const role = message.role === 'user' ? '用户' : 'AI';
        lines.push(`[${role}]`);
        lines.push(message.content);
        lines.push('');
      });

      return {
        filename: `${filenameBase}.txt`,
        content: lines.join('\n'),
        mimeType: 'text/plain',
      };
    }

    const lines = [`# ${title}`, '', `> 创建时间: ${createdAt}`, '', '---', ''];
    conversation.messages.forEach((message) => {
      const role = message.role === 'user' ? '**用户**' : '**AI**';
      lines.push(role);
      lines.push('');
      lines.push(message.content);
      lines.push('');
      lines.push('---');
      lines.push('');
    });

    return {
      filename: `${filenameBase}.md`,
      content: lines.join('\n'),
      mimeType: 'text/markdown',
    };
  }

  const timestamp = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    return {
      filename: `${filenameBase}_${timestamp}.json`,
      content: JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          totalConversations: conversations.length,
          conversations,
        },
        null,
        2
      ),
      mimeType: 'application/json',
    };
  }

  const lines = [
    '# 对话记录导出',
    '',
    `> 导出时间: ${new Date().toLocaleString('zh-CN')}`,
    `> 共 ${conversations.length} 个对话`,
    '',
    '---',
    '',
  ];

  conversations.forEach((conversation, index) => {
    lines.push(`## ${index + 1}. ${conversation.title || '未命名对话'}`);
    lines.push('');
    lines.push(`创建时间: ${new Date(conversation.createdAt).toLocaleString('zh-CN')}`);
    lines.push('');
    conversation.messages.forEach((message) => {
      const role = message.role === 'user' ? '**用户**' : '**AI**';
      lines.push(role);
      lines.push('');
      lines.push(message.content);
      lines.push('');
    });
    lines.push('---');
    lines.push('');
  });

  return {
    filename: `${filenameBase}_${timestamp}.md`,
    content: lines.join('\n'),
    mimeType: 'text/markdown',
  };
}

export const chatRouter = router({
  getConversations: protectedProcedure.query(async ({ ctx }) => getConversationsWithStats(ctx)),

  createConversation: protectedProcedure
    .input(z.object({ title: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('conversations')
        .insert({
          user_id: ctx.profileId,
          title: input.title || '新对话',
        })
        .select()
        .single();

      if (error) throw createSafeInternalError(error, '创建对话失败，请稍后重试');
      return data;
    }),

  updateConversationTitle: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid(), title: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('conversations')
        .update({ title: input.title })
        .eq('id', input.conversationId)
        .eq('user_id', ctx.profileId)
        .select()
        .single();

      if (error) throw createSafeInternalError(error, '更新对话标题失败，请稍后重试');
      return data;
    }),

  deleteConversation: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase.rpc('soft_delete_conversation', {
        p_conversation_id: input.conversationId,
        p_user_id: ctx.profileId,
      });

      if (error) {
        throw createSafeInternalError(error, '删除对话失败，请稍后重试');
      }

      if (!data) {
        throw new TRPCError({ code: 'FORBIDDEN', message: '无权删除该对话' });
      }

      return { success: true };
    }),

  deleteConversations: protectedProcedure
    .input(z.object({ conversationIds: z.array(z.string().uuid()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const { data: ownedConversations, error: ownedError } = await ctx.supabase
        .from('conversations')
        .select('id')
        .in('id', input.conversationIds)
        .eq('user_id', ctx.profileId)
        .eq('is_deleted', 'false');

      if (ownedError) {
        throw createSafeInternalError(ownedError, '批量删除对话失败，请稍后重试');
      }

      const ownedConversationIds = (ownedConversations ?? []).map((conversation) => conversation.id);
      if (ownedConversationIds.length !== input.conversationIds.length) {
        throw new TRPCError({ code: 'FORBIDDEN', message: '包含无权操作的对话' });
      }

      for (const conversationId of ownedConversationIds) {
        const { data, error } = await ctx.supabase.rpc('soft_delete_conversation', {
          p_conversation_id: conversationId,
          p_user_id: ctx.profileId,
        });

        if (error) {
          throw createSafeInternalError(error, '批量删除对话失败，请稍后重试');
        }

        if (!data) {
          throw new TRPCError({ code: 'FORBIDDEN', message: '包含无权操作的对话' });
        }
      }

      return { success: true, deletedCount: ownedConversationIds.length };
    }),

  getMessages: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Validate that the user owns the conversation
      const { data: convos } = await ctx.supabase
        .from('conversations')
        .select('id')
        .eq('id', input.conversationId)
        .eq('user_id', ctx.profileId);

      if (!convos || convos.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }

      return ctx.supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', input.conversationId)
        .eq('is_deleted', 'false')
        .order('created_at', { ascending: true });
    }),

  getConversationTokenStats: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { data: conversation } = await ctx.supabase
        .from('conversations')
        .select('id')
        .eq('id', input.conversationId)
        .eq('user_id', ctx.profileId)
        .eq('is_deleted', 'false')
        .single();

      if (!conversation) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }

      const { data: stats, error } = await ctx.supabase
        .from('token_stats')
        .select('input_tokens, output_tokens, total_credits, created_at')
        .eq('user_id', ctx.profileId)
        .eq('conversation_id', input.conversationId)
        .order('created_at', { ascending: false });

      if (error) {
        throw createSafeInternalError(error, '获取对话统计失败，请稍后重试');
      }

      const last = stats?.[0];
      const totals = (stats ?? []).reduce(
        (sum, row) => ({
          inputTokens: sum.inputTokens + (row.input_tokens ?? 0),
          outputTokens: sum.outputTokens + (row.output_tokens ?? 0),
          credits: sum.credits + (row.total_credits ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0, credits: 0 }
      );

      return {
        lastInputTokens: last?.input_tokens ?? 0,
        lastOutputTokens: last?.output_tokens ?? 0,
        totalInputTokens: totals.inputTokens,
        totalOutputTokens: totals.outputTokens,
        totalCredits: totals.credits,
        requestCount: stats?.length ?? 0,
      };
    }),

  /**
   * 获取用户导出权限（基于会员等级）
   */
  getExportPermissions: protectedProcedure.query(async ({ ctx }) => {
    try {
      return await assertExportPermission(ctx);
    } catch {
      return { allowExport: false, allowBatchExport: false };
    }
  }),

  /**
   * 导出单个对话（需要会员权限）
   */
  exportConversation: protectedProcedure
    .input(z.object({
      conversationId: z.string().uuid(),
      format: z.enum(['json', 'markdown', 'txt']).default('markdown'),
    }))
    .query(async ({ ctx, input }) => {
      const permissions = await assertExportPermission(ctx);
      if (!permissions.allowExport) {
        throw new TRPCError({ code: 'FORBIDDEN', message: '您的会员等级不支持导出对话功能，请升级会员' });
      }

      // 验证用户拥有该对话
      const { data: conversation } = await ctx.supabase
        .from('conversations')
        .select('id, title, created_at')
        .eq('id', input.conversationId)
        .eq('user_id', ctx.profileId)
        .eq('is_deleted', 'false')
        .single();

      if (!conversation) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '对话不存在' });
      }

      const exportData = await loadConversationExportData(ctx, [conversation as ExportConversationRecord]);
      return buildConversationExportPayload(exportData, input.format, conversation.title || '未命名对话');
    }),

  exportSelectedConversations: protectedProcedure
    .input(z.object({
      conversationIds: z.array(z.string().uuid()).min(1).max(100),
      format: z.enum(['json', 'markdown']).default('json'),
    }))
    .query(async ({ ctx, input }) => {
      const permissions = await assertExportPermission(ctx);
      if (!permissions.allowBatchExport) {
        throw new TRPCError({ code: 'FORBIDDEN', message: '您的会员等级不支持批量导出功能，请升级会员' });
      }

      const { data: conversations, error } = await ctx.supabase
        .from('conversations')
        .select('id, title, created_at')
        .in('id', input.conversationIds)
        .eq('user_id', ctx.profileId)
        .eq('is_deleted', 'false')
        .order('created_at', { ascending: false });

      if (error) {
        throw createSafeInternalError(error, '导出对话失败，请稍后重试');
      }

      if (!conversations || conversations.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '没有可导出的对话' });
      }

      if (conversations.length !== input.conversationIds.length) {
        throw new TRPCError({ code: 'FORBIDDEN', message: '包含无权导出的对话' });
      }

      const exportData = await loadConversationExportData(ctx, conversations as ExportConversationRecord[]);
      return buildConversationExportPayload(exportData, input.format, `selected_conversations_${conversations.length}`);
    }),

  /**
   * 批量导出所有对话（需要高级会员权限）
   */
  exportAllConversations: protectedProcedure
    .input(z.object({
      format: z.enum(['json', 'markdown']).default('json'),
    }))
    .query(async ({ ctx, input }) => {
      const permissions = await assertExportPermission(ctx);
      if (!permissions.allowBatchExport) {
        throw new TRPCError({ code: 'FORBIDDEN', message: '您的会员等级不支持批量导出功能，请升级会员' });
      }

      // 获取所有对话
      const { data: conversations } = await ctx.supabase
        .from('conversations')
        .select('id, title, created_at')
        .eq('user_id', ctx.profileId)
        .eq('is_deleted', 'false')
        .order('created_at', { ascending: false });

      if (!conversations || conversations.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '没有可导出的对话' });
      }

      const exportData = await loadConversationExportData(ctx, conversations as ExportConversationRecord[]);
      return buildConversationExportPayload(exportData, input.format, 'all_conversations');
    }),

  /**
   * @deprecated 旧非流式对话入口，已下线。
   * 请使用 /api/ai/stream + useStreamingChat 主链路。
   */
  sendMessage: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid(), content: z.string() }))
    .mutation(async () => {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'chat.sendMessage 已废弃，请使用 /api/ai/stream + useStreamingChat。',
      });
    }),
});
