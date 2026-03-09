import type { SupabaseClient } from '@supabase/supabase-js';

export interface TicketAutoCloseTicketRecord {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'closed';
}

export interface TicketAutoCloseReplyRecord {
  ticket_id: string;
  is_admin: string;
  created_at: string;
}

export interface TicketAutoCloseDecision {
  ticketId: string;
  title: string;
  timeoutStartAt: string;
  closeReason: string;
}

export interface TicketAutoCloseResult {
  checked: number;
  eligible: number;
  closed: number;
  decisions: TicketAutoCloseDecision[];
}

export const TICKET_AUTO_CLOSE_TIMEOUT_HOURS = 48;
export const TICKET_AUTO_CLOSE_SYSTEM_MESSAGE = `此工单因超过 ${TICKET_AUTO_CLOSE_TIMEOUT_HOURS} 小时无用户回复，已被系统自动关闭。如需继续咨询，请创建新工单。`;

export function determineTicketAutoCloseDecisions(input: {
  tickets: TicketAutoCloseTicketRecord[];
  replies: TicketAutoCloseReplyRecord[];
  now: Date;
  timeoutHours?: number;
}) {
  const timeoutHours = input.timeoutHours ?? TICKET_AUTO_CLOSE_TIMEOUT_HOURS;
  const decisions: TicketAutoCloseDecision[] = [];
  const repliesByTicket = new Map<string, TicketAutoCloseReplyRecord[]>();

  for (const reply of input.replies) {
    const bucket = repliesByTicket.get(reply.ticket_id) ?? [];
    bucket.push(reply);
    repliesByTicket.set(reply.ticket_id, bucket);
  }

  for (const ticket of input.tickets) {
    if (ticket.status === 'closed') {
      continue;
    }

    const replies = (repliesByTicket.get(ticket.id) ?? []).slice().sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    const firstAdminReply = replies.find((reply) => reply.is_admin === 'true');
    if (!firstAdminReply) {
      continue;
    }

    const adminReplyTime = new Date(firstAdminReply.created_at);
    const userRepliesAfterAdmin = replies.filter(
      (reply) => reply.is_admin !== 'true' && new Date(reply.created_at).getTime() > adminReplyTime.getTime()
    );

    const timeoutStartAt = userRepliesAfterAdmin.length > 0
      ? new Date(userRepliesAfterAdmin[userRepliesAfterAdmin.length - 1].created_at)
      : adminReplyTime;

    const hoursDiff = (input.now.getTime() - timeoutStartAt.getTime()) / (1000 * 60 * 60);
    if (hoursDiff < timeoutHours) {
      continue;
    }

    decisions.push({
      ticketId: ticket.id,
      title: ticket.title,
      timeoutStartAt: timeoutStartAt.toISOString(),
      closeReason: TICKET_AUTO_CLOSE_SYSTEM_MESSAGE,
    });
  }

  return decisions;
}

type MinimalSupabaseClient = Pick<SupabaseClient, 'from'>;

export class TicketAutoCloseService {
  constructor(
    private readonly options: {
      supabase: MinimalSupabaseClient;
      now?: Date;
      timeoutHours?: number;
    }
  ) {}

  async run(): Promise<TicketAutoCloseResult> {
    const now = this.options.now ?? new Date();
    const timeoutHours = this.options.timeoutHours ?? TICKET_AUTO_CLOSE_TIMEOUT_HOURS;

    const { data: tickets, error: ticketsError } = await this.options.supabase
      .from('tickets')
      .select('id, title, status')
      .eq('is_deleted', 'false')
      .in('status', ['open', 'in_progress']);

    if (ticketsError) {
      throw new Error(`Failed to load tickets: ${ticketsError.message}`);
    }

    const activeTickets = (tickets ?? []) as TicketAutoCloseTicketRecord[];
    if (activeTickets.length === 0) {
      return {
        checked: 0,
        eligible: 0,
        closed: 0,
        decisions: [],
      };
    }

    const ticketIds = activeTickets.map((ticket) => ticket.id);
    const { data: replies, error: repliesError } = await this.options.supabase
      .from('ticket_replies')
      .select('ticket_id, is_admin, created_at')
      .eq('is_deleted', 'false')
      .in('ticket_id', ticketIds)
      .order('created_at', { ascending: true });

    if (repliesError) {
      throw new Error(`Failed to load ticket replies: ${repliesError.message}`);
    }

    const decisions = determineTicketAutoCloseDecisions({
      tickets: activeTickets,
      replies: (replies ?? []) as TicketAutoCloseReplyRecord[],
      now,
      timeoutHours,
    });

    for (const decision of decisions) {
      const { error: updateError } = await this.options.supabase
        .from('tickets')
        .update({
          status: 'closed',
          updated_at: now.toISOString(),
        })
        .eq('id', decision.ticketId);

      if (updateError) {
        throw new Error(`Failed to close ticket ${decision.ticketId}: ${updateError.message}`);
      }

      const { error: insertError } = await this.options.supabase
        .from('ticket_replies')
        .insert({
          ticket_id: decision.ticketId,
          user_id: null,
          content: decision.closeReason,
          is_admin: 'true',
        });

      if (insertError) {
        throw new Error(`Failed to write auto-close reply for ${decision.ticketId}: ${insertError.message}`);
      }
    }

    return {
      checked: activeTickets.length,
      eligible: decisions.length,
      closed: decisions.length,
      decisions,
    };
  }
}
