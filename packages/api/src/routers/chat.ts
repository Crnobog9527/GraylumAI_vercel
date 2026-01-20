import { router, protectedProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const chatRouter = router({
  getConversations: protectedProcedure.query(async ({ ctx }) => {
    return ctx.supabase
      .from('conversations')
      .select('*')
      .eq('user_id', ctx.profileId)
      .order('created_at', { ascending: false });
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
        .order('created_at', { ascending: true });
    }),

  sendMessage: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid(), content: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // TODO: Add logic to call AI model and stream response
      // For now, we just save the user's message and echo a reply

      // 1. Save user message
      const { data: userMessage, error: userMessageError } = await ctx.supabase
        .from('messages')
        .insert({
          conversation_id: input.conversationId,
          role: 'user',
          content: input.content,
        })
        .select()
        .single();

      if (userMessageError) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: userMessageError.message });

      // 2. Deduct credits (example)
      // await ctx.supabase.rpc('deduct_credits', { user_id: ctx.profileId, amount: 1 });

      // 3. Echo a reply
      const { data: assistantMessage, error: assistantMessageError } = await ctx.supabase
        .from('messages')
        .insert({
          conversation_id: input.conversationId,
          role: 'assistant',
          content: `You said: ${input.content}`,
        })
        .select()
        .single();

      if (assistantMessageError) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: assistantMessageError.message });

      return { userMessage, assistantMessage };
    }),
});
