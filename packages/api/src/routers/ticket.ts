import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { logger } from '../lib/logger';
import { createSafeInternalError } from '../lib/publicError';
import {
  filterOwnedTicketAttachmentPaths,
  issueSignedAttachmentUrls,
  issueSignedAttachmentUrlsByBatch,
} from '../lib/ticketAttachments';

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
  billing: 'billing',
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

async function serializeTicketsWithSignedAttachments(
  supabaseAdmin: any,
  tickets: any[],
  fallbackOwnerId: string,
) {
  const attachmentBatches = tickets.flatMap((ticket) => [
    {
      key: `ticket:${ticket.id}`,
      value: ticket.attachments,
      ownerIds: [ticket.user_id ?? fallbackOwnerId],
    },
    ...((ticket.ticket_replies || []).map((reply: any) => ({
      key: `reply:${reply.id}`,
      value: reply.attachments,
      ownerIds: [ticket.user_id ?? fallbackOwnerId, reply.user_id],
    }))),
  ]);

  const signedAttachments = await issueSignedAttachmentUrlsByBatch(supabaseAdmin, attachmentBatches);

  return tickets.map((ticket) => ({
    id: ticket.id,
    ticket_number: generateTicketNumber(ticket.id),
    title: ticket.title,
    description: ticket.description || '',
    category: dbToCategoryMap[ticket.category] || 'other',
    status: dbToStatusMap[ticket.status] || 'pending',
    priority: ticket.priority || 'medium',
    attachments: signedAttachments.get(`ticket:${ticket.id}`) ?? [],
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    replies: (ticket.ticket_replies || []).map((reply: any) => ({
      id: reply.id,
      message: reply.content,
      is_admin_reply: reply.is_admin === 'true',
      attachments: signedAttachments.get(`reply:${reply.id}`) ?? [],
      created_at: reply.created_at,
    })),
  }));
}

export async function getTicketsForProfile(ctx: {
  profileId: string;
  supabase: any;
  supabaseAdmin: any;
}) {
  const { data, error } = await ctx.supabase
    .from('tickets')
    .select('*, ticket_replies(*)')
    .eq('user_id', ctx.profileId)
    .eq('is_deleted', 'false')
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('api', 'ticket_list_fetch_failed', {
      code: error.code,
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: '获取工单列表失败，请稍后重试',
      cause: error,
    });
  }

  return serializeTicketsWithSignedAttachments(ctx.supabaseAdmin, data || [], ctx.profileId);
}

export const ticketRouter = router({
  createTicket: protectedProcedure
    .input(z.object({
      title: z.string().min(1),
      description: z.string().min(1),
      category: z.string().optional().default('other'),
      attachments: z.array(z.string()).optional().default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      const ownedAttachments = filterOwnedTicketAttachmentPaths(input.attachments, [ctx.profileId]);
      if (ownedAttachments.length !== input.attachments.length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: '附件路径无效，请重新上传后再提交工单。',
        });
      }

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
          attachments: ownedAttachments,
        })
        .select()
        .single();

      if (ticketError || !newTicket) {
        throw createSafeInternalError(ticketError, '创建工单失败，请稍后重试');
      }

      return newTicket;
    }),

  getTickets: protectedProcedure.query(async ({ ctx }) =>
    getTicketsForProfile({
      profileId: ctx.profileId,
      supabase: ctx.supabase,
      supabaseAdmin: ctx.supabaseAdmin,
    })
  ),

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

      const [serializedTicket] = await serializeTicketsWithSignedAttachments(
        ctx.supabaseAdmin,
        [ticket],
        ctx.profileId,
      );

      return serializedTicket;
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
        throw createSafeInternalError(replyError, '回复工单失败，请稍后重试');
      }

      return {
        id: newReply.id,
        message: newReply.content,
        is_admin_reply: false,
        attachments: [],
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
        throw createSafeInternalError(error, '关闭工单失败，请稍后重试');
      }

      return { success: true };
    }),
});
