import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { getTicketsForProfile, ticketRouter } from './ticket';

type QueryCall = { table: string; operation: string; value: unknown };

function createQueryBuilder(result: Promise<unknown>, calls: QueryCall[] = [], table = '') {
  return {
    insert(value: unknown) {
      calls.push({ table, operation: 'insert', value });
      return this;
    },
    update() {
      return this;
    },
    select(value?: unknown) {
      calls.push({ table, operation: 'select', value });
      return this;
    },
    eq() {
      return this;
    },
    order() {
      return result;
    },
    maybeSingle() {
      return result;
    },
    single() {
      return result;
    },
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
}

function createTicketCaller(options: {
  ticketResult?: { data: unknown; error: unknown };
  ticketReplyResult?: { data: unknown; error: unknown };
  closeTicketResult?: { data: unknown; error: unknown };
  calls?: QueryCall[];
}) {
  const authProfile = {
    id: 'user-1',
    role: 'user',
    status: 'active',
    nickname: 'User',
    email: 'user@example.com',
  };

  const supabase = {
    from(table: string) {
      if (table === 'profiles') {
        return createQueryBuilder(Promise.resolve({ data: authProfile, error: null }));
      }

      if (table === 'tickets') {
        if (options.ticketResult) {
          return createQueryBuilder(Promise.resolve(options.ticketResult), options.calls, 'tickets');
        }

        return createQueryBuilder(Promise.resolve({ data: { id: 'ticket-1' }, error: null }), options.calls, 'tickets');
      }

      if (table === 'ticket_replies') {
        return createQueryBuilder(Promise.resolve(options.ticketReplyResult ?? {
          data: { id: 'reply-1', content: 'ok', created_at: '2026-03-27T00:00:00.000Z' },
          error: null,
        }), options.calls, 'ticket_replies');
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  return ticketRouter.createCaller({
    headers: new Headers(),
    user: {
      id: 'user-1',
      email: 'user@example.com',
      app_metadata: { provider: 'email' },
      user_metadata: { email_verified: true },
    },
    isEmailVerified: true,
    authProvider: 'email',
    supabase,
    supabaseAuth: supabase,
    supabasePublic: {},
    supabaseAdmin: {
      storage: {
        from: () => ({
          createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example.com/file' }, error: null }),
        }),
      },
    },
    hasSupabaseAdminPrivileges: true,
  } as any);
}

describe('getTicketsForProfile', () => {
  it('throws a TRPC error when the ticket query fails', async () => {
    const ctx = {
      profileId: 'user-1',
      supabaseAdmin: {},
      supabase: {
        from(table: string) {
          if (table === 'tickets') {
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

    await expect(getTicketsForProfile(ctx)).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '获取工单列表失败，请稍后重试',
    });
  });
});

describe('ticketRouter error sanitization', () => {
  it('sanitizes createTicket failures', async () => {
    const caller = createTicketCaller({
      ticketResult: {
        data: null,
        error: { message: 'insert into tickets violates row-level security policy' },
      },
    });

    await expect(
      caller.createTicket({
        title: 'Need help',
        description: 'desc',
        category: 'other',
        attachments: [],
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '创建工单失败，请稍后重试',
    });
  });

  it('sanitizes replyToTicket failures', async () => {
    const caller = createTicketCaller({
      ticketReplyResult: {
        data: null,
        error: { message: 'relation ticket_replies does not exist' },
      },
    });

    await expect(
      caller.replyToTicket({
        ticketId: '11111111-1111-4111-8111-111111111111',
        content: 'follow up',
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '回复工单失败，请稍后重试',
    });
  });

  it('sanitizes closeTicket failures', async () => {
    const caller = createTicketCaller({
      closeTicketResult: {
        data: null,
        error: { message: 'permission denied for table tickets' },
      },
    });

    const failingSupabase = {
      from(table: string) {
        if (table === 'profiles') {
          return createQueryBuilder(Promise.resolve({
            data: {
              id: 'user-1',
              role: 'user',
              status: 'active',
              nickname: 'User',
              email: 'user@example.com',
            },
            error: null,
          }));
        }

        if (table === 'tickets') {
          return createQueryBuilder(Promise.resolve({
            data: null,
            error: { message: 'permission denied for table tickets' },
          }));
        }

        throw new Error(`Unexpected table ${table}`);
      },
    };

    const closeCaller = ticketRouter.createCaller({
      headers: new Headers(),
      user: {
        id: 'user-1',
        email: 'user@example.com',
        app_metadata: { provider: 'email' },
        user_metadata: { email_verified: true },
      },
      isEmailVerified: true,
      authProvider: 'email',
      supabase: failingSupabase,
      supabaseAuth: failingSupabase,
      supabasePublic: {},
      supabaseAdmin: {},
      hasSupabaseAdminPrivileges: true,
    } as any);

    await expect(
      closeCaller.closeTicket({ ticketId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: 'INTERNAL_SERVER_ERROR',
      message: '关闭工单失败，请稍后重试',
    });
  });
});

describe('ticketRouter column grant contract', () => {
  const ticketId = '11111111-1111-4111-8111-111111111111';

  it('creates using the caller identity and database-controlled initial status', async () => {
    const calls: QueryCall[] = [];
    const caller = createTicketCaller({ calls });
    await caller.createTicket({ title: 'fixture', description: 'fixture', category: 'bug_report', attachments: [] });
    expect(calls.find(x => x.operation === 'insert')?.value).toEqual({
      user_id: 'user-1', title: 'fixture', description: 'fixture', category: 'bug', attachments: [],
    });
    const projection = calls.find(x => x.operation === 'select')?.value;
    expect(projection).toEqual(expect.any(String));
    expect(projection).not.toContain('*');
    expect(projection).not.toContain('deleted_at');
  });

  it('replies without requesting write access to the administrator flag', async () => {
    const calls: QueryCall[] = [];
    const caller = createTicketCaller({ calls });
    await caller.replyToTicket({ ticketId, content: 'fixture' });
    expect(calls.find(x => x.table === 'ticket_replies' && x.operation === 'insert')?.value).toEqual({
      ticket_id: ticketId, user_id: 'user-1', content: 'fixture',
    });
    const projection = calls.find(x => x.table === 'ticket_replies' && x.operation === 'select')?.value;
    expect(projection).toEqual(expect.any(String));
    expect(projection).not.toContain('*');
    expect(projection).not.toContain('deleted_at');
  });

  it('does not report a successful close when RLS matches no ticket', async () => {
    const caller = createTicketCaller({ ticketResult: { data: null, error: null } });
    await expect(caller.closeTicket({ ticketId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
