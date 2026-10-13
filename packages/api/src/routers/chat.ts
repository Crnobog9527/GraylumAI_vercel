import { createTRPCContext, router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';
import { skillChatService } from '../services/artifacts/chat';
import { logger } from '../lib/logger';

type BaseContext = Awaited<ReturnType<typeof createTRPCContext>>;
type ProtectedContext = BaseContext & {
  profileId: string;
  userRole: 'user' | 'admin';
  user: NonNullable<BaseContext['user']>;
};

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
  ctx: Pick<ProtectedContext, 'supabase' | 'profileId'> & Partial<Pick<ProtectedContext,'hasSupabaseAdminPrivileges'|'supabaseAdmin'>>,
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

  const stats=buildConversationStats(conversations,(messageRows??[]) as ConversationMessageCountRow[],(creditRows??[]) as ConversationCreditsRow[]);
  if(conversations.some(c=>c.skill_mode)) {
    const guided=await skillChatService(ctx.supabase,ctx.hasSupabaseAdminPrivileges?ctx.supabaseAdmin??null:null).stats();
    for(const row of stats){const item=guided.find(s=>s.conversationId===row.id);if(item){row.message_count=item.messageCount;row.credits_used=item.creditsUsed;}}
  }
  return {data:stats,error:null};
}

// LEGACY-CLOSE: the old chat page and its conversation, message, export and send procedures are gone.
// Only the profile usage-history list still reads old conversations.
export const chatRouter = router({
  getConversations: protectedProcedure.query(async ({ ctx }) => getConversationsWithStats(ctx)),
});
