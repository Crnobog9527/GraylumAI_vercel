import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

// 前端分类到数据库分类的映射
const categoryToDbMap: Record<string, string> = {
  technical_support: 'question',
  feature_request: 'feature',
  bug_report: 'bug',
  account_issue: 'account',
  billing: 'billing',
  other: 'other',
};

// 数据库分类到前端分类的映射
const dbToCategoryMap: Record<string, string> = {
  question: 'technical_support',
  feature: 'feature_request',
  bug: 'bug_report',
  account: 'account_issue',
  billing: 'other',
  other: 'other',
};

// 数据库状态到前端状态的映射
const dbToStatusMap: Record<string, string> = {
  open: 'pending',
  in_progress: 'in_progress',
  closed: 'closed',
};

// 生成工单号 (TK-年月日-序号)
const generateTicketNumber = (id: string): string => {
  const now = new Date();
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const shortId = id.substring(0, 6).toUpperCase();
  return `TK-${dateStr}-${shortId}`;
};

export const ticketRouter = router({
  createTicket: protectedProcedure
    .input(z.object({
      title: z.string().min(1),
      description: z.string().min(1),
      category: z.string().optional().default('other'),
      attachments: z.array(z.string()).optional().default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      // 映射前端分类到数据库分类
      const dbCategory = categoryToDbMap[input.category] || 'other';

      const { data: newTicket, error: ticketError } = await ctx.supabase
        .from('tickets')
        .insert({
          user_id: ctx.profileId,
          title: input.title,
          description: input.description,
          category: dbCategory,
          status: 'open',
          attachments: input.attachments,
        })
        .select()
        .single();

      if (ticketError || !newTicket) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: ticketError?.message || 'Failed to create ticket.' });
      }

      return newTicket;
    }),

  getTickets: protectedProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('tickets')
      .select('*, ticket_replies(*)')
      .eq('user_id', ctx.profileId)
      .eq('is_deleted', 'false')
      .order('created_at', { ascending: false });

    if (error) {
      // 返回空数组而不是抛出错误，更好的用户体验
      console.error('getTickets error:', error.message);
      return [];
    }

    // 转换数据格式以匹配前端组件期望的格式
    return (data || []).map((ticket: any) => ({
      id: ticket.id,
      ticket_number: generateTicketNumber(ticket.id),
      title: ticket.title,
      description: ticket.description || '',
      category: dbToCategoryMap[ticket.category] || 'other',
      status: dbToStatusMap[ticket.status] || 'pending',
      priority: ticket.priority || 'medium',
      attachments: ticket.attachments || [],
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
      replies: (ticket.ticket_replies || []).map((reply: any) => ({
        id: reply.id,
        message: reply.content,
        is_admin_reply: reply.is_admin === 'true',
        created_at: reply.created_at,
      })),
    }));
  }),

  getTicketById: protectedProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { data: ticket, error } = await ctx.supabase
        .from('tickets')
        .select('*, ticket_replies(*)')
        .eq('id', input.ticketId)
        .eq('user_id', ctx.profileId)
        .single();

      if (error || !ticket) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found.' });
      }

      // 转换数据格式
      return {
        id: ticket.id,
        ticket_number: generateTicketNumber(ticket.id),
        title: ticket.title,
        description: ticket.description || '',
        category: dbToCategoryMap[ticket.category] || 'other',
        status: dbToStatusMap[ticket.status] || 'pending',
        priority: ticket.priority || 'medium',
        attachments: ticket.attachments || [],
        created_at: ticket.created_at,
        updated_at: ticket.updated_at,
        replies: (ticket.ticket_replies || []).map((reply: any) => ({
          id: reply.id,
          message: reply.content,
          is_admin_reply: reply.is_admin === 'true',
          created_at: reply.created_at,
        })),
      };
    }),

  replyToTicket: protectedProcedure
    .input(z.object({ ticketId: z.string().uuid(), content: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { data: ticket, error: ticketError } = await ctx.supabase
        .from('tickets')
        .select('id')
        .eq('id', input.ticketId)
        .eq('user_id', ctx.profileId)
        .single();

      if (ticketError || !ticket) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Ticket not found or unauthorized.' });
      }

      const { data: newReply, error: replyError } = await ctx.supabase
        .from('ticket_replies')
        .insert({
          ticket_id: input.ticketId,
          user_id: ctx.profileId,
          content: input.content,
          is_admin: 'false',
        })
        .select()
        .single();

      if (replyError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: replyError.message });
      }

      return {
        id: newReply.id,
        message: newReply.content,
        is_admin_reply: false,
        created_at: newReply.created_at,
      };
    }),

  closeTicket: protectedProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.supabase
        .from('tickets')
        .update({ status: 'closed' })
        .eq('id', input.ticketId)
        .eq('user_id', ctx.profileId);

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return { success: true };
    }),
});
