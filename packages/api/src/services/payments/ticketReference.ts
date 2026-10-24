/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { createSafeServiceUnavailableError } from '../../lib/publicError';
import { ticketIdRangeFromQuery } from '../../lib/ticketNumber';

/** The number admins see on every ticket page: TK-<UTC creation date>-<first 6 ID characters> (lib/ticketNumber). */
export const ticketNumberInput = z.object({ ticketNumber: z.string().trim().regex(/^TK-\d{8}-[0-9A-Fa-f]{6}$/i) }).strict();

/**
 * Turns a ticket number into the ticket ID the refund forms send. Only the lookup: the refund procedures still check,
 * with the ID, that it is the order owner's billing ticket. Same day and same first 6 characters must name exactly one
 * ticket; otherwise the admin is asked for the full ID instead of a guess.
 */
export async function resolveTicketNumber(db: Pick<SupabaseClient, 'from'>, ticketNumber: string): Promise<{ ticketId: string }> {
  const number = ticketNumberInput.parse({ ticketNumber }).ticketNumber.toUpperCase();
  const day = number.slice(3, 11);
  const start = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00.000Z`;
  if (Number.isNaN(Date.parse(start))) throw new TRPCError({ code: 'BAD_REQUEST', message: '工单编号里的日期不对' });
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const range = ticketIdRangeFromQuery(number);
  if (range?.kind !== 'range') throw new TRPCError({ code: 'BAD_REQUEST', message: '工单编号格式不对' });
  const { data, error } = await db.from('tickets').select('id').gte('id', range.min).lte('id', range.max)
    .gte('created_at', start).lt('created_at', end).eq('is_deleted', false).limit(2);
  if (error) throw createSafeServiceUnavailableError(error, '工单暂时无法读取，请稍后重试');
  const rows = (data ?? []) as Array<{ id: string }>;
  if (rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: '找不到这个工单编号，请到工单管理页复制' });
  if (rows.length > 1) throw new TRPCError({ code: 'CONFLICT', message: '有两张工单编号相同，请改填完整的工单 ID' });
  return { ticketId: rows[0].id };
}
