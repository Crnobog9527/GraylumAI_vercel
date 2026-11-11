/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure } from '../trpc';
import { z } from 'zod';
import { applyTicketIdSearch } from '../lib/ticketNumber';
import { issueSignedAttachmentUrlsByBatch } from '../lib/ticketAttachments';
import { createAdminOperationError, logAdminEndpointMetric } from './adminShared';

type TicketStatusSummary = {
  all: number;
  open: number;
  in_progress: number;
  closed: number;
};

function createEmptyTicketStatusSummary(): TicketStatusSummary {
  return {
    all: 0,
    open: 0,
    in_progress: 0,
    closed: 0,
  };
}

function summarizeTicketStatuses(tickets: Array<{ status: string | null | undefined }> | null | undefined): TicketStatusSummary {
  const summary = createEmptyTicketStatusSummary();

  for (const ticket of tickets ?? []) {
    summary.all += 1;

    if (ticket.status === 'open') summary.open += 1;
    else if (ticket.status === 'in_progress') summary.in_progress += 1;
    else if (ticket.status === 'closed') summary.closed += 1;
  }

  return summary;
}

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminTicketProcedures = {
  /**
   * Get all tickets (for admin to manage all users' tickets)
   */
  getAllTickets: adminProcedure
    .input(z.object({
      status: z.enum(['open', 'in_progress', 'closed']).optional(),
      category: z.enum(['bug', 'feature', 'question', 'account', 'billing', 'consult', 'other']).optional(),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
      search: z.string().transform((s) => s.slice(0, 64)).optional(),
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const startedAt = Date.now();
      // 查询工单（不使用外键关联，改为分步查询以避免 schema cache 问题）
      let query = ctx.supabase
        .from('tickets')
        .select('*', { count: 'exact' })
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.status) query = query.eq('status', input.status);
      if (input.category) query = query.eq('category', input.category);
      if (input.priority) query = query.eq('priority', input.priority);
      query = applyTicketIdSearch(query, input.search);

      const { data: ticketsData, error, count } = await query;

      if (error) {
        throw createAdminOperationError('读取工单列表', error);
      }

      let statusCountsQuery = ctx.supabase
        .from('tickets')
        .select('status')
        .eq('is_deleted', false);

      if (input.category) {
        statusCountsQuery = statusCountsQuery.eq('category', input.category);
      }
      if (input.priority) {
        statusCountsQuery = statusCountsQuery.eq('priority', input.priority);
      }

      const { data: statusCountRows, error: statusCountsError } = await statusCountsQuery;

      if (statusCountsError) {
        throw createAdminOperationError('读取工单列表', statusCountsError);
      }

      const statusCounts = summarizeTicketStatuses(statusCountRows);

      if (!ticketsData || ticketsData.length === 0) {
        return {
          tickets: [],
          total: count ?? 0,
          hasMore: false,
          statusCounts,
        };
      }

      // 获取所有工单的用户 ID
      const userIds = Array.from(new Set(ticketsData.map(t => t.user_id).filter(Boolean)));
      const ticketIds = ticketsData.map(t => t.id);

      // 分步查询：获取用户信息
      const { data: usersData } = userIds.length > 0
        ? await ctx.supabase
            .from('profiles')
            .select('id, email, nickname, avatar_url, role')
            .in('id', userIds)
        : { data: [] };

      // 分步查询：获取工单回复
      const { data: repliesData } = await ctx.supabase
        .from('ticket_replies')
        .select('*')
        .in('ticket_id', ticketIds)
        .order('created_at', { ascending: true });

      // 获取回复者用户信息
      const replyUserIds = Array.from(new Set((repliesData ?? []).map(r => r.user_id).filter(Boolean)));
      const { data: replyUsersData } = replyUserIds.length > 0
        ? await ctx.supabase
            .from('profiles')
            .select('id, email, nickname, avatar_url, role')
            .in('id', replyUserIds)
        : { data: [] };

      // 构建用户映射
      const usersMap = new Map((usersData ?? []).map(u => [u.id, u]));
      const replyUsersMap = new Map((replyUsersData ?? []).map(u => [u.id, u]));

      const attachmentBatches = ticketsData.flatMap((ticket) => [
        {
          key: `ticket:${ticket.id}`,
          value: ticket.attachments,
          ownerIds: [ticket.user_id],
        },
        ...((repliesData ?? [])
          .filter(r => r.ticket_id === ticket.id)
          .map((reply) => ({
            key: `reply:${reply.id}`,
            value: reply.attachments,
            ownerIds: [ticket.user_id, reply.user_id],
          }))),
      ]);
      const signedAttachments = await issueSignedAttachmentUrlsByBatch(ctx.supabaseAdmin, attachmentBatches);

      // 组装工单数据
      const tickets = ticketsData.map((ticket) => ({
        ...ticket,
        attachments: signedAttachments.get(`ticket:${ticket.id}`) ?? [],
        user: ticket.user_id ? usersMap.get(ticket.user_id) ?? null : null,
        ticket_replies: (repliesData ?? [])
          .filter(r => r.ticket_id === ticket.id)
          .map((reply) => ({
            ...reply,
            attachments: signedAttachments.get(`reply:${reply.id}`) ?? [],
            user: reply.user_id ? replyUsersMap.get(reply.user_id) ?? null : null,
          })),
      }));

      const result = {
        tickets,
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        statusCounts,
      };

      logAdminEndpointMetric('admin.getAllTickets', startedAt, {
        queryCount: 5,
        countStrategy: 'exact',
        pageSize: input.limit,
        returnedCount: result.tickets.length,
      });

      return result;
    }),

  /**
   * Update ticket status (admin can update any ticket)
   */
  updateTicketStatus: adminProcedure
    .input(z.object({
      ticketId: z.string().uuid(),
      status: z.enum(['open', 'in_progress', 'closed']),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('tickets')
        .update({
          status: input.status,
          updated_at: new Date().toISOString(),
        })
        .eq('id', input.ticketId)
        .select()
        .single();

      if (error) {
        throw createAdminOperationError('更新工单状态', error);
      }

      return data;
    }),

  /**
   * Admin reply to ticket
   */
  replyToTicket: adminProcedure
    .input(z.object({
      ticketId: z.string().uuid(),
      content: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('ticket_replies')
        .insert({
          ticket_id: input.ticketId,
          user_id: ctx.profileId,
          content: input.content,
          is_admin: 'true', // 标记为管理员回复
        })
        .select()
        .single();

      if (error) {
        throw createAdminOperationError('回复工单', error);
      }

      // 同时更新工单的 updated_at
      await ctx.supabase
        .from('tickets')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', input.ticketId);

      return data;
    }),
};
