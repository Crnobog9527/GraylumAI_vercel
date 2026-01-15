import { router, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const adminRouter = router({
  /**
   * Get dashboard statistics
   * Returns overview of users, credits, tickets, and invitations
   */
  getStatistics: adminProcedure.query(async ({ ctx }) => {
    // Fetch all statistics in parallel for better performance
    const [
      usersResult,
      ticketsResult,
      invitationsResult,
      creditsResult,
      recentUsersResult,
    ] = await Promise.all([
      // Total users count
      ctx.supabase.from('profiles').select('id', { count: 'exact', head: true }),

      // Tickets by status
      ctx.supabase.from('tickets').select('status'),

      // Invitations by status
      ctx.supabase.from('invitations').select('status'),

      // Total credits in system
      ctx.supabase.from('profiles').select('credits'),

      // Recent users (last 7 days)
      ctx.supabase
        .from('profiles')
        .select('id, email, nickname, role, credits, created_at')
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    // Calculate ticket statistics
    const ticketStats = {
      total: ticketsResult.data?.length ?? 0,
      open: ticketsResult.data?.filter(t => t.status === 'open').length ?? 0,
      inProgress: ticketsResult.data?.filter(t => t.status === 'in_progress').length ?? 0,
      closed: ticketsResult.data?.filter(t => t.status === 'closed').length ?? 0,
    };

    // Calculate invitation statistics
    const invitationStats = {
      total: invitationsResult.data?.length ?? 0,
      active: invitationsResult.data?.filter(i => i.status === 'active').length ?? 0,
      used: invitationsResult.data?.filter(i => i.status === 'used').length ?? 0,
      expired: invitationsResult.data?.filter(i => i.status === 'expired').length ?? 0,
    };

    // Calculate total credits
    const totalCredits = creditsResult.data?.reduce((sum, user) => sum + (user.credits ?? 0), 0) ?? 0;

    return {
      users: {
        total: usersResult.count ?? 0,
        recentUsers: recentUsersResult.data ?? [],
      },
      tickets: ticketStats,
      invitations: invitationStats,
      credits: {
        totalInSystem: totalCredits,
      },
    };
  }),

  /**
   * Get all users (for admin management)
   */
  getAllUsers: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
      search: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('profiles')
        .select('id, email, nickname, role, credits, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      // Apply search filter if provided
      if (input.search) {
        query = query.or(`email.ilike.%${input.search}%,nickname.ilike.%${input.search}%`);
      }

      const { data, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return {
        users: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
      };
    }),

  /**
   * Update user role
   */
  updateUserRole: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
      role: z.enum(['user', 'admin']),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ role: input.role })
        .eq('id', input.userId)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Get all tickets (for admin to manage all users' tickets)
   */
  getAllTickets: adminProcedure
    .input(z.object({
      status: z.enum(['open', 'in_progress', 'closed']).optional(),
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('tickets')
        .select('*, ticket_replies(*)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.status) {
        query = query.eq('status', input.status);
      }

      const { data, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return {
        tickets: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
      };
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
        .update({ status: input.status })
        .eq('id', input.ticketId)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
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
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Adjust user credits (add or deduct)
   */
  adjustUserCredits: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
      amount: z.number().int(), // Positive to add, negative to deduct
      reason: z.string().min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get current credits
      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('credits')
        .eq('id', input.userId)
        .single();

      if (profileError || !profile) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const newCredits = Math.max(0, profile.credits + input.amount);

      // Update credits
      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ credits: newCredits })
        .eq('id', input.userId)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      // Record transaction
      await ctx.supabase.from('credit_transactions').insert({
        user_id: input.userId,
        amount: input.amount,
        type: input.amount > 0 ? 'addition' : 'deduction',
        description: `[Admin] ${input.reason}`,
      });

      return {
        previousCredits: profile.credits,
        newCredits,
        adjustment: input.amount,
      };
    }),
});
