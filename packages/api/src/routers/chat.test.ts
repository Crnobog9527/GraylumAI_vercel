import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { buildConversationStats, getConversationsWithStats } from './chat';

describe('buildConversationStats', () => {
  it('aggregates message counts and credits in bulk without per-conversation queries', () => {
    const conversations = [
      { id: 'conv-1', title: 'A' },
      { id: 'conv-2', title: 'B' },
    ];

    const result = buildConversationStats(
      conversations,
      [
        { conversation_id: 'conv-1' },
        { conversation_id: 'conv-1' },
        { conversation_id: 'conv-2' },
      ],
      [
        { conversation_id: 'conv-1', total_credits: 5 },
        { conversation_id: 'conv-1', total_credits: 7 },
        { conversation_id: 'conv-2', total_credits: 3 },
      ],
    );

    expect(result).toEqual([
      { id: 'conv-1', title: 'A', message_count: 2, credits_used: 12 },
      { id: 'conv-2', title: 'B', message_count: 1, credits_used: 3 },
    ]);
  });
});

function createQueryBuilder(result: Promise<unknown>) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    order() {
      return result;
    },
    in() {
      return this;
    },
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

describe('getConversationsWithStats', () => {
  it('throws a TRPC error when the base conversation query fails', async () => {
    const ctx = {
      profileId: 'user-1',
      supabase: {
        from(table: string) {
          if (table === 'conversations') {
            return createQueryBuilder(
              Promise.resolve({
                data: null,
                error: { message: 'boom' },
              }),
            );
          }
          throw new Error(`Unexpected table ${table}`);
        },
      },
    } as any;

    await expect(getConversationsWithStats(ctx)).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '获取对话列表失败，请稍后重试',
    });
  });

  it('throws a TRPC error when bulk stats aggregation fails', async () => {
    const ctx = {
      profileId: 'user-1',
      supabase: {
        from(table: string) {
          if (table === 'conversations') {
            return createQueryBuilder(
              Promise.resolve({
                data: [{ id: 'conv-1', title: 'A' }],
                error: null,
              }),
            );
          }
          if (table === 'messages') {
            return createQueryBuilder(
              Promise.resolve({
                data: null,
                error: { message: 'messages failed' },
              }),
            );
          }
          if (table === 'token_stats') {
            return createQueryBuilder(
              Promise.resolve({
                data: [],
                error: null,
              }),
            );
          }
          throw new Error(`Unexpected table ${table}`);
        },
      },
    } as any;

    await expect(getConversationsWithStats(ctx)).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '获取对话统计失败，请稍后重试',
    });
  });
});
