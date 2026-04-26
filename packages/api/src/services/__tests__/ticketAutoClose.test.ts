import { describe, expect, it, vi } from 'vitest';
import {
  determineTicketAutoCloseDecisions,
  TICKET_AUTO_CLOSE_SYSTEM_MESSAGE,
  TicketAutoCloseService,
} from '../ticketAutoClose';

function createMockSupabase(options: {
  tickets?: Array<{ id: string; title: string; status: 'open' | 'in_progress' | 'closed' }>;
  replies?: Array<{ ticket_id: string; is_admin: string; created_at: string }>;
  ticketsError?: { message: string } | null;
  repliesError?: { message: string } | null;
  updateError?: { message: string } | null;
  insertError?: { message: string } | null;
}) {
  const tickets = options.tickets ?? [];
  const replies = options.replies ?? [];
  const updates: Array<{
    table: string;
    values: Record<string, unknown>;
    eq: Array<[string, unknown]>;
    in: Array<[string, unknown[]]>;
  }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown> | Record<string, unknown>[] }> = [];

  return {
    updates,
    inserts,
    client: {
      from: vi.fn((table: string) => {
        const state = {
          table,
          selectFields: '',
          updateValues: undefined as Record<string, unknown> | undefined,
          eqFilters: [] as Array<[string, unknown]>,
        };

        return {
          select(fields: string) {
            state.selectFields = fields;
            return this;
          },
          eq(column: string, value: unknown) {
            state.eqFilters.push([column, value]);
            return this;
          },
          in(column: string, values: unknown[]) {
            if (state.updateValues) {
              updates.push({
                table,
                values: state.updateValues,
                eq: [...state.eqFilters],
                in: [[column, values]],
              });
              return Promise.resolve({ data: null, error: options.updateError ?? null });
            }

            return this;
          },
          order() {
            return Promise.resolve({ data: replies, error: options.repliesError ?? null });
          },
          update(values: Record<string, unknown>) {
            state.updateValues = values;
            return this;
          },
          insert(values: Record<string, unknown> | Record<string, unknown>[]) {
            inserts.push({ table, values });
            return Promise.resolve({ data: values, error: options.insertError ?? null });
          },
          then(onFulfilled: (value: { data: unknown; error: null }) => unknown) {
            if (table === 'tickets' && state.selectFields.includes('status')) {
              return Promise.resolve(onFulfilled({ data: tickets, error: options.ticketsError ?? null }));
            }

            return Promise.resolve(onFulfilled({ data: null, error: null }));
          },
        };
      }),
    },
  };
}

describe('determineTicketAutoCloseDecisions', () => {
  const now = new Date('2026-03-09T12:00:00.000Z');

  it('does not close tickets without any admin reply', () => {
    const decisions = determineTicketAutoCloseDecisions({
      tickets: [{ id: 't1', title: 'No admin yet', status: 'open' }],
      replies: [
        { ticket_id: 't1', is_admin: 'false', created_at: '2026-03-07T09:00:00.000Z' },
      ],
      now,
    });

    expect(decisions).toEqual([]);
  });

  it('closes tickets when 48 hours passed after the first admin reply and user never replied', () => {
    const decisions = determineTicketAutoCloseDecisions({
      tickets: [{ id: 't1', title: 'Timed out', status: 'in_progress' }],
      replies: [
        { ticket_id: 't1', is_admin: 'true', created_at: '2026-03-07T10:00:00.000Z' },
      ],
      now,
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      ticketId: 't1',
      title: 'Timed out',
      closeReason: TICKET_AUTO_CLOSE_SYSTEM_MESSAGE,
    });
  });

  it('resets the timeout clock to the latest user reply after admin intervention', () => {
    const decisions = determineTicketAutoCloseDecisions({
      tickets: [{ id: 't1', title: 'Still active', status: 'in_progress' }],
      replies: [
        { ticket_id: 't1', is_admin: 'true', created_at: '2026-03-06T10:00:00.000Z' },
        { ticket_id: 't1', is_admin: 'false', created_at: '2026-03-08T15:00:00.000Z' },
      ],
      now,
    });

    expect(decisions).toEqual([]);
  });
});

describe('TicketAutoCloseService', () => {
  it('updates the ticket status and writes a system reply for eligible tickets', async () => {
    const mock = createMockSupabase({
      tickets: [
        { id: 'ticket-1', title: 'Auto close me', status: 'open' },
      ],
      replies: [
        { ticket_id: 'ticket-1', is_admin: 'true', created_at: '2026-03-07T08:00:00.000Z' },
      ],
    });

    const service = new TicketAutoCloseService({
      supabase: mock.client as never,
      now: new Date('2026-03-09T12:00:00.000Z'),
    });

    const result = await service.run();

    expect(result.closed).toBe(1);
    expect(mock.updates).toEqual([
      {
        table: 'tickets',
        values: expect.objectContaining({
          status: 'closed',
          updated_at: '2026-03-09T12:00:00.000Z',
        }),
        eq: [],
        in: [['id', ['ticket-1']]],
      },
    ]);
    expect(mock.inserts).toEqual([
      {
        table: 'ticket_replies',
        values: [{
          ticket_id: 'ticket-1',
          user_id: null,
          content: TICKET_AUTO_CLOSE_SYSTEM_MESSAGE,
          is_admin: 'true',
        }],
      },
    ]);
  });

  it('sanitizes reply query failures', async () => {
    const mock = createMockSupabase({
      tickets: [{ id: 'ticket-1', title: 'Auto close me', status: 'open' }],
      repliesError: { message: 'permission denied for table ticket_replies' },
    });

    const service = new TicketAutoCloseService({
      supabase: mock.client as never,
      now: new Date('2026-03-09T12:00:00.000Z'),
    });

    await expect(service.run()).rejects.toThrow('Failed to load ticket replies for auto-close');
  });
});
