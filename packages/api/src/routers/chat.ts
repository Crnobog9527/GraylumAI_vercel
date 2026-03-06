import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

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
      // Delete messages first (foreign key constraint)
      await ctx.supabase
        .from('messages')
        .delete()
        .eq('conversation_id', input.conversationId);

      const { error } = await ctx.supabase
        .from('conversations')
        .delete()
        .eq('id', input.conversationId)
        .eq('user_id', ctx.profileId);

      if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      return { success: true };
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
    // 获取用户 profile 和会员等级
    const { data: profile } = await ctx.supabase
      .from('profiles')
      .select('membership_level')
      .eq('id', ctx.profileId)
      .single();

    if (!profile) {
      return { allowExport: false, allowBatchExport: false };
    }

    // 获取对应会员等级的权限
    const { data: plan } = await ctx.supabase
      .from('membership_plans')
      .select('allow_export, allow_batch_export')
      .eq('level', profile.membership_level)
      .eq('is_active', 'true')
      .single();

    return {
      allowExport: plan?.allow_export === 'true',
      allowBatchExport: plan?.allow_batch_export === 'true',
      membershipLevel: profile.membership_level,
    };
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
      // 检查导出权限
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
        .select('allow_export')
        .eq('level', profile.membership_level)
        .eq('is_active', 'true')
        .single();

      if (plan?.allow_export !== 'true') {
        throw new TRPCError({ code: 'FORBIDDEN', message: '您的会员等级不支持导出对话功能，请升级会员' });
      }

      // 验证用户拥有该对话
      const { data: conversation } = await ctx.supabase
        .from('conversations')
        .select('id, title, created_at')
        .eq('id', input.conversationId)
        .eq('user_id', ctx.profileId)
        .single();

      if (!conversation) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '对话不存在' });
      }

      // 获取对话消息
      const { data: messages } = await ctx.supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('conversation_id', input.conversationId)
        .order('created_at', { ascending: true });

      // 根据格式生成导出内容
      const title = conversation.title || '未命名对话';
      const createdAt = new Date(conversation.created_at).toLocaleString('zh-CN');

      if (input.format === 'json') {
        return {
          filename: `${title}.json`,
          content: JSON.stringify({
            title,
            createdAt: conversation.created_at,
            messages: messages || [],
          }, null, 2),
          mimeType: 'application/json',
        };
      }

      if (input.format === 'txt') {
        const lines = [`对话: ${title}`, `创建时间: ${createdAt}`, '', '---', ''];
        (messages || []).forEach((msg) => {
          const role = msg.role === 'user' ? '用户' : 'AI';
          lines.push(`[${role}]`);
          lines.push(msg.content);
          lines.push('');
        });
        return {
          filename: `${title}.txt`,
          content: lines.join('\n'),
          mimeType: 'text/plain',
        };
      }

      // 默认 markdown 格式
      const lines = [`# ${title}`, '', `> 创建时间: ${createdAt}`, '', '---', ''];
      (messages || []).forEach((msg) => {
        const role = msg.role === 'user' ? '**用户**' : '**AI**';
        lines.push(role);
        lines.push('');
        lines.push(msg.content);
        lines.push('');
        lines.push('---');
        lines.push('');
      });
      return {
        filename: `${title}.md`,
        content: lines.join('\n'),
        mimeType: 'text/markdown',
      };
    }),

  /**
   * 批量导出所有对话（需要高级会员权限）
   */
  exportAllConversations: protectedProcedure
    .input(z.object({
      format: z.enum(['json', 'markdown']).default('json'),
    }))
    .query(async ({ ctx, input }) => {
      // 检查批量导出权限
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
        .select('allow_batch_export')
        .eq('level', profile.membership_level)
        .eq('is_active', 'true')
        .single();

      if (plan?.allow_batch_export !== 'true') {
        throw new TRPCError({ code: 'FORBIDDEN', message: '您的会员等级不支持批量导出功能，请升级会员' });
      }

      // 获取所有对话
      const { data: conversations } = await ctx.supabase
        .from('conversations')
        .select('id, title, created_at')
        .eq('user_id', ctx.profileId)
        .order('created_at', { ascending: false });

      if (!conversations || conversations.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: '没有可导出的对话' });
      }

      // 获取每个对话的消息
      const exportData = await Promise.all(
        conversations.map(async (conv) => {
          const { data: messages } = await ctx.supabase
            .from('messages')
            .select('role, content, created_at')
            .eq('conversation_id', conv.id)
            .order('created_at', { ascending: true });

          return {
            id: conv.id,
            title: conv.title,
            createdAt: conv.created_at,
            messages: messages || [],
          };
        })
      );

      const timestamp = new Date().toISOString().slice(0, 10);

      if (input.format === 'json') {
        return {
          filename: `all_conversations_${timestamp}.json`,
          content: JSON.stringify({
            exportedAt: new Date().toISOString(),
            totalConversations: exportData.length,
            conversations: exportData,
          }, null, 2),
          mimeType: 'application/json',
        };
      }

      // Markdown 格式
      const lines = ['# 对话记录导出', '', `> 导出时间: ${new Date().toLocaleString('zh-CN')}`, `> 共 ${exportData.length} 个对话`, '', '---', ''];

      exportData.forEach((conv, index) => {
        lines.push(`## ${index + 1}. ${conv.title || '未命名对话'}`);
        lines.push('');
        lines.push(`创建时间: ${new Date(conv.createdAt).toLocaleString('zh-CN')}`);
        lines.push('');
        conv.messages.forEach((msg) => {
          const role = msg.role === 'user' ? '**用户**' : '**AI**';
          lines.push(role);
          lines.push('');
          lines.push(msg.content);
          lines.push('');
        });
        lines.push('---');
        lines.push('');
      });

      return {
        filename: `all_conversations_${timestamp}.md`,
        content: lines.join('\n'),
        mimeType: 'text/markdown',
      };
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
