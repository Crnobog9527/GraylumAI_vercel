import { createTRPCContext, router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

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
  return Promise.all(
    conversations.map(async (conversation) => {
      const { data: messages } = await ctx.supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('conversation_id', conversation.id)
        .eq('is_deleted', 'false')
        .order('created_at', { ascending: true });

      return {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.created_at,
        messages: (messages ?? []) as ExportMessageRecord[],
      };
    })
  );
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
  getConversations: protectedProcedure.query(async ({ ctx }) => {
    // 获取对话列表（排除已删除的）
    const { data: conversations, error } = await ctx.supabase
      .from('conversations')
      .select('*')
      .eq('user_id', ctx.profileId)
      .eq('is_deleted', 'false')
      .order('created_at', { ascending: false });

    if (error || !conversations) {
      return { data: [], error };
    }

    // 为每个对话获取消息数量
    const conversationsWithStats = await Promise.all(
      conversations.map(async (conv) => {
        // 获取消息数量（排除已删除的）
        const { count: messageCount } = await ctx.supabase
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('conversation_id', conv.id)
          .eq('is_deleted', 'false');

        // 获取该对话消耗的积分（从 token_stats 或 billing_history）
        const { data: usageLogs } = await ctx.supabase
          .from('billing_history')
          .select('amount')
          .eq('user_id', ctx.profileId)
          .eq('reference_id', conv.id);

        const creditsUsed = (usageLogs || []).reduce((sum: number, log: any) => sum + Math.abs(log.amount || 0), 0);

        return {
          ...conv,
          message_count: messageCount ?? 0,
          credits_used: creditsUsed,
        };
      })
    );

    return { data: conversationsWithStats, error: null };
  }),

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

      if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
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

      if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      return data;
    }),

  deleteConversation: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const deletedAt = new Date().toISOString();

      const { error: messageDeleteError } = await ctx.supabase
        .from('messages')
        .update({ is_deleted: true, deleted_at: deletedAt })
        .eq('conversation_id', input.conversationId)
        .eq('is_deleted', 'false');

      if (messageDeleteError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: messageDeleteError.message });
      }

      const { error } = await ctx.supabase
        .from('conversations')
        .update({ is_deleted: true, deleted_at: deletedAt })
        .eq('id', input.conversationId)
        .eq('user_id', ctx.profileId)
        .eq('is_deleted', 'false');

      if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      return { success: true };
    }),

  deleteConversations: protectedProcedure
    .input(z.object({ conversationIds: z.array(z.string().uuid()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const deletedAt = new Date().toISOString();
      const { data: ownedConversations, error: ownedError } = await ctx.supabase
        .from('conversations')
        .select('id')
        .in('id', input.conversationIds)
        .eq('user_id', ctx.profileId)
        .eq('is_deleted', 'false');

      if (ownedError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: ownedError.message });
      }

      const ownedConversationIds = (ownedConversations ?? []).map((conversation) => conversation.id);
      if (ownedConversationIds.length !== input.conversationIds.length) {
        throw new TRPCError({ code: 'FORBIDDEN', message: '包含无权操作的对话' });
      }

      const { error: messageDeleteError } = await ctx.supabase
        .from('messages')
        .update({ is_deleted: true, deleted_at: deletedAt })
        .in('conversation_id', ownedConversationIds)
        .eq('is_deleted', 'false');

      if (messageDeleteError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: messageDeleteError.message });
      }

      const { error } = await ctx.supabase
        .from('conversations')
        .update({ is_deleted: true, deleted_at: deletedAt })
        .in('id', ownedConversationIds)
        .eq('user_id', ctx.profileId)
        .eq('is_deleted', 'false');

      if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
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
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
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
