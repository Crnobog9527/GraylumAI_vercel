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
        .select('id, email, nickname, avatar_url, role, credits, created_at', { count: 'exact' })
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
   * Get all credit transactions (for admin)
   */
  getAllTransactions: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
      type: z.enum(['deduction', 'addition', 'purchase', 'refund']).optional(),
      userId: z.string().uuid().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('credit_transactions')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.type) {
        query = query.eq('type', input.type);
      }

      if (input.userId) {
        query = query.eq('user_id', input.userId);
      }

      if (input.startDate) {
        query = query.gte('created_at', input.startDate);
      }

      if (input.endDate) {
        query = query.lte('created_at', input.endDate);
      }

      const { data, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      // Calculate statistics
      const statsQuery = await ctx.supabase
        .from('credit_transactions')
        .select('type, amount');

      const stats = {
        totalAdditions: 0,
        totalDeductions: 0,
        totalPurchases: 0,
        totalRefunds: 0,
      };

      statsQuery.data?.forEach((t: { type: string; amount: number }) => {
        if (t.type === 'addition') stats.totalAdditions += t.amount;
        else if (t.type === 'deduction') stats.totalDeductions += Math.abs(t.amount);
        else if (t.type === 'purchase') stats.totalPurchases += t.amount;
        else if (t.type === 'refund') stats.totalRefunds += t.amount;
      });

      return {
        transactions: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        stats,
      };
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

  // ============================================
  // Credit Packages Management
  // ============================================

  /**
   * Get all credit packages
   */
  getAllPackages: adminProcedure
    .query(async ({ ctx }) => {
      const { data, error } = await ctx.supabase
        .from('credit_packages')
        .select('*')
        .order('price', { ascending: true });

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data ?? [];
    }),

  /**
   * Create a new credit package
   */
  createPackage: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      price: z.number().int().positive(), // In cents
      creditsAmount: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('credit_packages')
        .insert({
          name: input.name,
          price: input.price,
          credits_amount: input.creditsAmount,
          active: 'true',
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Update a credit package
   */
  updatePackage: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      price: z.number().int().positive().optional(),
      creditsAmount: z.number().int().positive().optional(),
      active: z.enum(['true', 'false']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {};
      if (input.name) updateData.name = input.name;
      if (input.price) updateData.price = input.price;
      if (input.creditsAmount) updateData.credits_amount = input.creditsAmount;
      if (input.active) updateData.active = input.active;

      const { data, error } = await ctx.supabase
        .from('credit_packages')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Delete a credit package
   */
  deletePackage: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.supabase
        .from('credit_packages')
        .delete()
        .eq('id', input.id);

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return { success: true };
    }),

  // ============================================
  // Announcements Management
  // ============================================

  /**
   * Get all announcements (for admin)
   */
  getAllAnnouncements: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      activeOnly: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('announcements')
        .select('*', { count: 'exact' })
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.activeOnly) {
        query = query.eq('active', 'true');
      }

      const { data, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      // Get stats
      const statsQuery = await ctx.supabase
        .from('announcements')
        .select('active, type');

      const stats = {
        total: statsQuery.data?.length ?? 0,
        active: statsQuery.data?.filter(a => a.active === 'true').length ?? 0,
        inactive: statsQuery.data?.filter(a => a.active === 'false').length ?? 0,
        byType: {
          info: statsQuery.data?.filter(a => a.type === 'info').length ?? 0,
          warning: statsQuery.data?.filter(a => a.type === 'warning').length ?? 0,
          success: statsQuery.data?.filter(a => a.type === 'success').length ?? 0,
          error: statsQuery.data?.filter(a => a.type === 'error').length ?? 0,
        },
      };

      return {
        announcements: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        stats,
      };
    }),

  /**
   * Create a new announcement
   */
  createAnnouncement: adminProcedure
    .input(z.object({
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(5000),
      type: z.enum(['info', 'warning', 'success', 'error']).default('info'),
      priority: z.number().int().min(0).max(100).default(0),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('announcements')
        .insert({
          title: input.title,
          content: input.content,
          type: input.type,
          priority: input.priority,
          active: 'true',
          start_date: input.startDate ?? new Date().toISOString(),
          end_date: input.endDate ?? null,
          created_by: ctx.profileId,
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Update an announcement
   */
  updateAnnouncement: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      title: z.string().min(1).max(200).optional(),
      content: z.string().min(1).max(5000).optional(),
      type: z.enum(['info', 'warning', 'success', 'error']).optional(),
      priority: z.number().int().min(0).max(100).optional(),
      active: z.enum(['true', 'false']).optional(),
      startDate: z.string().optional(),
      endDate: z.string().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (input.title !== undefined) updateData.title = input.title;
      if (input.content !== undefined) updateData.content = input.content;
      if (input.type !== undefined) updateData.type = input.type;
      if (input.priority !== undefined) updateData.priority = input.priority;
      if (input.active !== undefined) updateData.active = input.active;
      if (input.startDate !== undefined) updateData.start_date = input.startDate;
      if (input.endDate !== undefined) updateData.end_date = input.endDate;

      const { data, error } = await ctx.supabase
        .from('announcements')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Delete an announcement
   */
  deleteAnnouncement: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.supabase
        .from('announcements')
        .delete()
        .eq('id', input.id);

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return { success: true };
    }),

  /**
   * Get active announcements (public, but could be used by admin preview too)
   */
  getActiveAnnouncements: adminProcedure
    .query(async ({ ctx }) => {
      const now = new Date().toISOString();

      const { data, error } = await ctx.supabase
        .from('announcements')
        .select('*')
        .eq('active', 'true')
        .lte('start_date', now)
        .or(`end_date.is.null,end_date.gt.${now}`)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data ?? [];
    }),

  // ============================================
  // Prompts Management
  // ============================================

  /**
   * Get all prompts (for admin)
   */
  getAllPrompts: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      category: z.enum(['general', 'assistant', 'creative', 'coding', 'translation', 'analysis']).optional(),
      activeOnly: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => {
      let query = ctx.supabase
        .from('prompts')
        .select('*', { count: 'exact' })
        .order('sort_order', { ascending: false })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.category) {
        query = query.eq('category', input.category);
      }

      if (input.activeOnly) {
        query = query.eq('active', 'true');
      }

      const { data, error, count } = await query;

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      // Get stats
      const statsQuery = await ctx.supabase
        .from('prompts')
        .select('active, category, is_system');

      const stats = {
        total: statsQuery.data?.length ?? 0,
        active: statsQuery.data?.filter(p => p.active === 'true').length ?? 0,
        inactive: statsQuery.data?.filter(p => p.active === 'false').length ?? 0,
        system: statsQuery.data?.filter(p => p.is_system === 'true').length ?? 0,
        byCategory: {
          general: statsQuery.data?.filter(p => p.category === 'general').length ?? 0,
          assistant: statsQuery.data?.filter(p => p.category === 'assistant').length ?? 0,
          creative: statsQuery.data?.filter(p => p.category === 'creative').length ?? 0,
          coding: statsQuery.data?.filter(p => p.category === 'coding').length ?? 0,
          translation: statsQuery.data?.filter(p => p.category === 'translation').length ?? 0,
          analysis: statsQuery.data?.filter(p => p.category === 'analysis').length ?? 0,
        },
      };

      return {
        prompts: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        stats,
      };
    }),

  /**
   * Create a new prompt
   */
  createPrompt: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      content: z.string().min(1).max(10000),
      category: z.enum(['general', 'assistant', 'creative', 'coding', 'translation', 'analysis']).default('general'),
      sortOrder: z.number().int().min(0).max(1000).default(0),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('prompts')
        .insert({
          name: input.name,
          description: input.description ?? null,
          content: input.content,
          category: input.category,
          sort_order: input.sortOrder,
          is_system: 'false',
          active: 'true',
          created_by: ctx.profileId,
        })
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Update a prompt
   */
  updatePrompt: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(500).nullable().optional(),
      content: z.string().min(1).max(10000).optional(),
      category: z.enum(['general', 'assistant', 'creative', 'coding', 'translation', 'analysis']).optional(),
      sortOrder: z.number().int().min(0).max(1000).optional(),
      active: z.enum(['true', 'false']).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.content !== undefined) updateData.content = input.content;
      if (input.category !== undefined) updateData.category = input.category;
      if (input.sortOrder !== undefined) updateData.sort_order = input.sortOrder;
      if (input.active !== undefined) updateData.active = input.active;

      const { data, error } = await ctx.supabase
        .from('prompts')
        .update(updateData)
        .eq('id', input.id)
        .select()
        .single();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return data;
    }),

  /**
   * Delete a prompt
   */
  deletePrompt: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Check if it's a system prompt
      const { data: prompt } = await ctx.supabase
        .from('prompts')
        .select('is_system')
        .eq('id', input.id)
        .single();

      if (prompt?.is_system === 'true') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Cannot delete system prompts' });
      }

      const { error } = await ctx.supabase
        .from('prompts')
        .delete()
        .eq('id', input.id);

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }

      return { success: true };
    }),

  // ============================================
  // Finance Statistics
  // ============================================

  /**
   * Get financial statistics
   */
  getFinanceStats: adminProcedure
    .query(async ({ ctx }) => {
      // Get all transactions for analysis
      const { data: transactions } = await ctx.supabase
        .from('credit_transactions')
        .select('amount, type, created_at')
        .order('created_at', { ascending: false });

      // Get credit packages for revenue calculation
      const { data: packages } = await ctx.supabase
        .from('credit_packages')
        .select('*');

      // Get user statistics
      const { data: users } = await ctx.supabase
        .from('profiles')
        .select('credits, created_at');

      // Calculate overall stats
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const transactionStats = {
        totalAdditions: 0,
        totalDeductions: 0,
        totalPurchases: 0,
        totalRefunds: 0,
        todayTransactions: 0,
        weekTransactions: 0,
        monthTransactions: 0,
      };

      // Daily breakdown for chart (last 30 days)
      const dailyStats: Record<string, { additions: number; deductions: number; purchases: number }> = {};
      for (let i = 0; i < 30; i++) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateKey = date.toISOString().split('T')[0];
        dailyStats[dateKey] = { additions: 0, deductions: 0, purchases: 0 };
      }

      transactions?.forEach(t => {
        const transDate = new Date(t.created_at);
        const dateKey = transDate.toISOString().split('T')[0];

        if (t.type === 'addition') transactionStats.totalAdditions += t.amount;
        else if (t.type === 'deduction') transactionStats.totalDeductions += Math.abs(t.amount);
        else if (t.type === 'purchase') transactionStats.totalPurchases += t.amount;
        else if (t.type === 'refund') transactionStats.totalRefunds += t.amount;

        if (transDate >= todayStart) transactionStats.todayTransactions++;
        if (transDate >= sevenDaysAgo) transactionStats.weekTransactions++;
        if (transDate >= thirtyDaysAgo) transactionStats.monthTransactions++;

        if (dailyStats[dateKey]) {
          if (t.type === 'addition') dailyStats[dateKey].additions += t.amount;
          else if (t.type === 'deduction') dailyStats[dateKey].deductions += Math.abs(t.amount);
          else if (t.type === 'purchase') dailyStats[dateKey].purchases += t.amount;
        }
      });

      // User statistics
      const userStats = {
        totalUsers: users?.length ?? 0,
        totalCreditsInSystem: users?.reduce((sum, u) => sum + (u.credits ?? 0), 0) ?? 0,
        averageCreditsPerUser: 0,
        newUsersThisMonth: 0,
        newUsersThisWeek: 0,
      };

      users?.forEach(u => {
        const createdAt = new Date(u.created_at);
        if (createdAt >= thirtyDaysAgo) userStats.newUsersThisMonth++;
        if (createdAt >= sevenDaysAgo) userStats.newUsersThisWeek++;
      });

      if (userStats.totalUsers > 0) {
        userStats.averageCreditsPerUser = Math.round(userStats.totalCreditsInSystem / userStats.totalUsers);
      }

      // Package statistics
      const packageStats = {
        totalPackages: packages?.length ?? 0,
        activePackages: packages?.filter(p => p.active === 'true').length ?? 0,
        packages: packages?.map(p => ({
          id: p.id,
          name: p.name,
          price: p.price,
          creditsAmount: p.credits_amount,
          active: p.active,
        })) ?? [],
      };

      // Convert daily stats to array for charting
      const dailyChartData = Object.entries(dailyStats)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, data]) => ({
          date,
          ...data,
        }));

      return {
        transactions: transactionStats,
        users: userStats,
        packages: packageStats,
        dailyChart: dailyChartData,
      };
    }),

  // ============================================
  // Performance Monitoring
  // ============================================

  /**
   * Get performance statistics
   */
  getPerformanceStats: adminProcedure
    .query(async ({ ctx }) => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Get conversations statistics
      const { data: conversations, count: totalConversations } = await ctx.supabase
        .from('conversations')
        .select('id, created_at, model_id', { count: 'exact' });

      // Get messages statistics
      const { data: messages, count: totalMessages } = await ctx.supabase
        .from('messages')
        .select('id, role, created_at', { count: 'exact' });

      // Get AI models
      const { data: models } = await ctx.supabase
        .from('ai_models')
        .select('id, name, provider');

      // Get tickets statistics
      const { data: tickets, count: totalTickets } = await ctx.supabase
        .from('tickets')
        .select('id, status, created_at', { count: 'exact' });

      // Calculate conversation stats
      const conversationStats = {
        total: totalConversations ?? 0,
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
      };

      conversations?.forEach(c => {
        const createdAt = new Date(c.created_at);
        if (createdAt >= todayStart) conversationStats.today++;
        if (createdAt >= sevenDaysAgo) conversationStats.thisWeek++;
        if (createdAt >= thirtyDaysAgo) conversationStats.thisMonth++;
      });

      // Calculate message stats
      const messageStats = {
        total: totalMessages ?? 0,
        userMessages: messages?.filter(m => m.role === 'user').length ?? 0,
        assistantMessages: messages?.filter(m => m.role === 'assistant').length ?? 0,
        today: 0,
        thisWeek: 0,
        thisMonth: 0,
      };

      messages?.forEach(m => {
        const createdAt = new Date(m.created_at);
        if (createdAt >= todayStart) messageStats.today++;
        if (createdAt >= sevenDaysAgo) messageStats.thisWeek++;
        if (createdAt >= thirtyDaysAgo) messageStats.thisMonth++;
      });

      // Calculate ticket stats
      const ticketStats = {
        total: totalTickets ?? 0,
        open: tickets?.filter(t => t.status === 'open').length ?? 0,
        inProgress: tickets?.filter(t => t.status === 'in_progress').length ?? 0,
        closed: tickets?.filter(t => t.status === 'closed').length ?? 0,
      };

      // Model usage stats
      const modelUsage = models?.map(model => {
        const count = conversations?.filter(c => c.model_id === model.id).length ?? 0;
        return {
          id: model.id,
          name: model.name,
          provider: model.provider,
          conversationCount: count,
        };
      }) ?? [];

      // Daily activity (last 14 days)
      const dailyActivity: Record<string, { conversations: number; messages: number }> = {};
      for (let i = 0; i < 14; i++) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateKey = date.toISOString().split('T')[0];
        dailyActivity[dateKey] = { conversations: 0, messages: 0 };
      }

      conversations?.forEach(c => {
        const dateKey = new Date(c.created_at).toISOString().split('T')[0];
        if (dailyActivity[dateKey]) {
          dailyActivity[dateKey].conversations++;
        }
      });

      messages?.forEach(m => {
        const dateKey = new Date(m.created_at).toISOString().split('T')[0];
        if (dailyActivity[dateKey]) {
          dailyActivity[dateKey].messages++;
        }
      });

      const dailyChartData = Object.entries(dailyActivity)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, data]) => ({
          date,
          ...data,
        }));

      // Calculate averages
      const averages = {
        messagesPerConversation: conversationStats.total > 0
          ? Math.round(messageStats.total / conversationStats.total)
          : 0,
        conversationsPerDay: Math.round(conversationStats.thisMonth / 30),
        messagesPerDay: Math.round(messageStats.thisMonth / 30),
      };

      return {
        conversations: conversationStats,
        messages: messageStats,
        tickets: ticketStats,
        modelUsage,
        dailyChart: dailyChartData,
        averages,
      };
    }),
});
