import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const ticketRouter = router({
  createTicket: protectedProcedure
    .input(z.object({ title: z.string().min(5), content: z.string().min(10) }))
    .mutation(async ({ ctx, input }) => {
      const { data: newTicket, error: ticketError } = await ctx.supabase
        .from('tickets')
        .insert({
          user_id: ctx.profileId,
          title: input.title,
          status: 'open',
        })
        .select()
        .single();

      if (ticketError || !newTicket) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: ticketError?.message || 'Failed to create ticket.' });
      }

      await ctx.supabase
        .from('ticket_replies')
        .insert({
          ticket_id: newTicket.id,
          user_id: ctx.profileId,
          content: input.content,
        });

      return newTicket;
    }),

  getTickets: protectedProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('tickets')
      .select('*, ticket_replies(*)')
      .eq('user_id', ctx.profileId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
    }
    return data;
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
      return ticket;
    }),

  replyToTicket: protectedProcedure
    .input(z.object({ ticketId: z.string().uuid(), content: z.string().min(5) }))
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
        })
        .select()
        .single();

      if (replyError) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: replyError.message });
      }

      return newReply;
    }),
});
